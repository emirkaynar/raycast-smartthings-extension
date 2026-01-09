import {
  ActionPanel,
  Color,
  List,
  LocalStorage,
  Toast,
  getPreferenceValues,
  open,
  showToast,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useCallback, useMemo } from "react";

import {
  brokerLogout,
  createPair,
  getBrokerAccessToken,
  getPairStatus,
  type PairStatusResponse,
} from "./broker/client";
import { mapWithConcurrency } from "./shared/concurrency";
import { hsvToHex, kelvinToHex } from "./shared/color";
import { clamp } from "./shared/number";
import { sleep } from "./shared/time";
import { getDeviceStatus, listSmartThingsDevices } from "./smartthings/api";
import { deviceHasCapability, getDeviceKind } from "./smartthings/device";
import { formatDeviceUiInfo, type DeviceUiInfo } from "./smartthings/ui";
import type { SmartThingsDevice } from "./smartthings/types";
import { iconForKind } from "./ui/icons";

import { useDeviceActions } from "./smartthings/registry/useDeviceActions";

type Preferences = {
  brokerBaseUrl: string;
};

const STORAGE_SESSION_TOKEN_KEY = "smartthings_session_token";

const BRIGHTNESS_STEP = 5;
const BRIGHTNESS_DEBOUNCE_MS = 800;

function normalizeBaseUrl(input: string): string {
  return input.replace(/\/+$/g, "");
}

async function ensureConnected(brokerBaseUrl: string): Promise<string> {
  const existing = await LocalStorage.getItem<string>(STORAGE_SESSION_TOKEN_KEY);
  if (existing) return existing;

  const pair = await createPair(brokerBaseUrl);

  await showToast({
    style: Toast.Style.Animated,
    title: "Connect SmartThings",
    message: "Complete authorization in your browser…",
  });
  await open(pair.authorizationUrl);

  // Pairing records on the broker are TTL'd; use that rather than a hard-coded short timeout.
  const expiresMs = Math.max(30_000, (pair.expiresInSeconds || 2 * 60) * 1000);
  const deadline = Date.now() + expiresMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    let status: PairStatusResponse;
    try {
      status = await getPairStatus(brokerBaseUrl, pair.pairId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If the broker no longer has the pairing record (e.g. expired), stop polling and let the user retry.
      if (msg.includes("HTTP 404")) {
        throw new Error("Authorization session expired. Please try connecting again.");
      }
      throw err;
    }
    if (status.status === "completed" && status.sessionToken) {
      await LocalStorage.setItem(STORAGE_SESSION_TOKEN_KEY, status.sessionToken);
      await showToast({ style: Toast.Style.Success, title: "Connected" });
      return status.sessionToken;
    }
    if (status.status === "error") {
      throw new Error(status.error || "Authorization failed");
    }
  }

  throw new Error("Timed out waiting for authorization");
}

export default function ListDevicesCommand() {
  const prefs = getPreferenceValues<Preferences>();
  const brokerBaseUrl = useMemo(() => normalizeBaseUrl(prefs.brokerBaseUrl), [prefs.brokerBaseUrl]);

  const loadDevices = useCallback(async () => {
    const sessionToken = await ensureConnected(brokerBaseUrl);
    let accessToken: string;
    try {
      const token = await getBrokerAccessToken(brokerBaseUrl, sessionToken);
      accessToken = token.accessToken;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only force a new pairing if the broker explicitly rejects the session.
      // Otherwise (network/5xx), keep the session token and surface the error.
      if (msg.includes("HTTP 401")) {
        await LocalStorage.removeItem(STORAGE_SESSION_TOKEN_KEY);
        const newSessionToken = await ensureConnected(brokerBaseUrl);
        const token = await getBrokerAccessToken(brokerBaseUrl, newSessionToken);
        accessToken = token.accessToken;
      } else {
        throw err;
      }
    }

    const devices = await listSmartThingsDevices(accessToken);

    const deviceUiById: Record<string, DeviceUiInfo> = {};
    await mapWithConcurrency(devices, 6, async (device) => {
      try {
        const status = await getDeviceStatus(accessToken, device.deviceId);
        deviceUiById[device.deviceId] = formatDeviceUiInfo(device, status);
      } catch {
        // Ignore per-device status failures.
      }
      return undefined;
    });

    return { devices, accessToken, deviceUiById };
  }, [brokerBaseUrl]);

  const { data, isLoading, error, revalidate } = useCachedPromise(loadDevices, [], {
    keepPreviousData: true,
  });

  const devices = data?.devices ?? [];
  const accessToken = data?.accessToken;
  const deviceUiById = data?.deviceUiById ?? {};

  const onReconnect = useCallback(async () => {
    await LocalStorage.removeItem(STORAGE_SESSION_TOKEN_KEY);
    await revalidate();
  }, [revalidate]);

  const onDisconnect = useCallback(async () => {
    const sessionToken = await LocalStorage.getItem<string>(STORAGE_SESSION_TOKEN_KEY);
    if (sessionToken) {
      try {
        await brokerLogout(brokerBaseUrl, sessionToken);
      } catch {
        // Ignore logout failures; we still clear local state.
      }
    }
    await LocalStorage.removeItem(STORAGE_SESSION_TOKEN_KEY);
    await revalidate();
  }, [brokerBaseUrl, revalidate]);

  const { renderActionsForDevice } = useDeviceActions({
    brokerBaseUrl,
    accessToken,
    revalidate,
    storageSessionTokenKey: STORAGE_SESSION_TOKEN_KEY,
    onReconnect,
    onDisconnect,
    brightnessStep: BRIGHTNESS_STEP,
    brightnessDebounceMs: BRIGHTNESS_DEBOUNCE_MS,
  });

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search devices…">
      {error ? <List.EmptyView title="Error" description={String(error)} /> : null}
      {devices.map((device) => {
        const ui = deviceUiById[device.deviceId] ?? {};
        const kind = getDeviceKind(device);
        const title = device.label || device.name || device.deviceId;
        const isLight = kind === "light";
        const isSwitch = deviceHasCapability(device, "switch");

        const cachedSwitchState = ui.switchState;
        const accessoryText =
          kind === "presence" && ui.presence
            ? ui.presence === "present"
              ? "Present"
              : "Away"
            : cachedSwitchState === "on"
              ? "On"
              : cachedSwitchState === "off"
                ? "Off"
                : "";
        const toggleTitle =
          cachedSwitchState === "on" ? "Turn Off" : cachedSwitchState === "off" ? "Turn On" : "Toggle Switch";

        const subtitle =
          cachedSwitchState === "on" && isLight && typeof ui.level === "number" ? `${Math.round(ui.level)}%` : "";
        const iconTint = (() => {
          if (!isLight) return Color.SecondaryText;
          if (cachedSwitchState !== "on") return Color.SecondaryText;

          // RGB-capable: tint to current hue/sat (and level, if present)
          if (
            deviceHasCapability(device, "colorControl") &&
            typeof ui.hue === "number" &&
            typeof ui.saturation === "number"
          ) {
            const hueDeg = clamp(ui.hue, 0, 100) * 3.6;
            const sat01 = clamp(ui.saturation, 0, 100) / 100;
            // If saturation is near-zero, treat as white and fall through to temperature (if available).
            if (sat01 >= 0.08) {
              return hsvToHex(hueDeg, sat01, 1);
            }
          }

          // Warmth-only (or near-white RGB): tint based on color temperature
          if (deviceHasCapability(device, "colorTemperature") && typeof ui.colorTemperature === "number") {
            return kelvinToHex(ui.colorTemperature);
          }

          return Color.Yellow;
        })();

        const iconSource = iconForKind(kind);
        return (
          <List.Item
            key={device.deviceId}
            title={title}
            subtitle={subtitle}
            accessories={accessoryText ? [{ text: accessoryText }] : []}
            icon={{ source: iconSource, tintColor: iconTint }}
            actions={
              <ActionPanel>
                {renderActionsForDevice(device, ui)}
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
