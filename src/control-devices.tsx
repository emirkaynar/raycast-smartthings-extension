import { ActionPanel, Color, List, LocalStorage, Toast, getPreferenceValues, open, showToast } from "@raycast/api";
import { useCachedPromise, useCachedState } from "@raycast/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { loadDeviceLastUsed, type DeviceLastUsedMap } from "./smartthings/lastUsed";

type Preferences = {
  brokerBaseUrl: string;
};

const STORAGE_SESSION_TOKEN_KEY = "smartthings_session_token";

const STORAGE_CATEGORY_FILTER_KEY = "smartthings_device_category_filter_v1";

type CategoryFilter = "all" | "recent" | "lights" | "sensors" | "other";

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

  const [category, setCategory] = useCachedState<CategoryFilter>(STORAGE_CATEGORY_FILTER_KEY, "all");
  const [sortLastUsedById, setSortLastUsedById] = useState<DeviceLastUsedMap>({});
  const [uiHydrated, setUiHydrated] = useState(false);

  const userSetCategoryRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const lastUsed = await loadDeviceLastUsed(LocalStorage);
        if (cancelled) return;

        setSortLastUsedById(lastUsed);
      } finally {
        if (!cancelled) setUiHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    revalidate();
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

  const visibleDevices = useMemo(() => {
    const titleFor = (d: SmartThingsDevice) => (d.label || d.name || d.deviceId).toLowerCase();
    const lastUsedFor = (d: SmartThingsDevice) => sortLastUsedById[d.deviceId] ?? 0;

    const isLightDevice = (d: SmartThingsDevice) => {
      const kind = getDeviceKind(d);
      if (kind === "light") return true;
      // Fallback: treat dimmable/color-capable devices as lights.
      return (
        deviceHasCapability(d, "switchLevel") ||
        deviceHasCapability(d, "colorControl") ||
        deviceHasCapability(d, "colorTemperature")
      );
    };

    const isSensorDevice = (d: SmartThingsDevice) => {
      const kind = getDeviceKind(d);
      if (kind === "presence" || kind === "mobile") return true;
      const sensorCaps = [
        "presenceSensor",
        "motionSensor",
        "contactSensor",
        "temperatureMeasurement",
        "relativeHumidityMeasurement",
        "illuminanceMeasurement",
        "waterSensor",
        "smokeDetector",
        "carbonMonoxideDetector",
      ];
      return sensorCaps.some((cap) => deviceHasCapability(d, cap));
    };

    const sorted = [...devices].sort((a, b) => {
      const delta = lastUsedFor(b) - lastUsedFor(a);
      if (delta !== 0) return delta;
      return titleFor(a).localeCompare(titleFor(b));
    });

    if (category === "recent") {
      return sorted.filter((d) => lastUsedFor(d) > 0).slice(0, 20);
    }
    if (category === "lights") {
      return sorted.filter(isLightDevice);
    }
    if (category === "sensors") {
      return sorted.filter(isSensorDevice);
    }
    if (category === "other") {
      return sorted.filter((d) => !isLightDevice(d) && !isSensorDevice(d));
    }
    return sorted;
  }, [category, devices, sortLastUsedById]);

  return (
    <List
      isLoading={isLoading || !uiHydrated}
      searchBarPlaceholder="Search devices…"
      searchBarAccessory={
        <List.Dropdown
          tooltip="Category"
          value={category}
          onChange={async (next) => {
            const value = next as CategoryFilter;
            userSetCategoryRef.current = true;
            setCategory(value);
          }}
        >
          <List.Dropdown.Item title="All" value="all" />
          <List.Dropdown.Item title="Recent" value="recent" />
          <List.Dropdown.Item title="Lights" value="lights" />
          <List.Dropdown.Item title="Sensors" value="sensors" />
          <List.Dropdown.Item title="Other" value="other" />
        </List.Dropdown>
      }
    >
      {error ? <List.EmptyView title="Error" description={String(error)} /> : null}
      {uiHydrated
        ? visibleDevices.map((device) => {
            const ui = deviceUiById[device.deviceId] ?? {};
            const kind = getDeviceKind(device);
            const title = device.label || device.name || device.deviceId;
            const isLight = kind === "light";

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
                actions={<ActionPanel>{renderActionsForDevice(device, ui)}</ActionPanel>}
              />
            );
          })
        : null}
    </List>
  );
}
