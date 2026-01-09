import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Icon,
  List,
  LocalStorage,
  Toast,
  getPreferenceValues,
  open,
  showToast,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useCallback, useMemo, useRef } from "react";

import {
  brokerLogout,
  createPair,
  getBrokerAccessToken,
  getPairStatus,
  type PairStatusResponse,
} from "./broker/client";
import { mapWithConcurrency } from "./shared/concurrency";
import { hsvToHex, kelvinToHex } from "./shared/color";
import { formatAsPrettyJson } from "./shared/json";
import { clamp } from "./shared/number";
import { sleep } from "./shared/time";
import {
  getDeviceStatus,
  getSmartThingsDevice,
  getSwitchLevelStatus,
  getSwitchStatus,
  listSmartThingsDevices,
  setSwitch,
  setSwitchLevel,
} from "./smartthings/api";
import { deviceHasCapability, getDeviceKind } from "./smartthings/device";
import { formatDeviceUiInfo, type DeviceUiInfo } from "./smartthings/ui";
import type { SmartThingsDevice } from "./smartthings/types";
import { iconForKind } from "./ui/icons";

type Preferences = {
  brokerBaseUrl: string;
};

const STORAGE_SESSION_TOKEN_KEY = "smartthings_session_token";

const BRIGHTNESS_STEP = 5;
const BRIGHTNESS_DEBOUNCE_MS = 800;

type BrightnessDebounceState = {
  target?: number;
  timer?: ReturnType<typeof setTimeout>;
  toast?: Toast;
  inFlight?: Promise<void>;
  commitAfterFlight?: boolean;
};

function normalizeBaseUrl(input: string): string {
  return input.replace(/\/+$/g, "");
}

function DeviceRawDataDetail(props: { accessToken: string; device: SmartThingsDevice }) {
  const { accessToken, device } = props;

  const { data, isLoading, error, revalidate } = useCachedPromise(
    async (token: string, deviceId: string) => {
      const [fullDevice, status] = await Promise.all([
        getSmartThingsDevice(token, deviceId),
        getDeviceStatus(token, deviceId),
      ]);
      return { fullDevice, status };
    },
    [accessToken, device.deviceId],
    { keepPreviousData: true },
  );

  const title = device.label || device.name || device.deviceId;
  const deviceJson = formatAsPrettyJson(data?.fullDevice);
  const statusJson = formatAsPrettyJson(data?.status);
  const listItemJson = formatAsPrettyJson(device);

  const combinedJson =
    JSON.stringify(
      {
        deviceId: device.deviceId,
        device: data?.fullDevice,
        status: data?.status,
        listItem: device,
      },
      null,
      2,
    ) || "";

  const markdown =
    `# ${title}\n\n` +
    `**Device ID:** ${device.deviceId}\n\n` +
    (error ? `## Error\n\n\`${String(error)}\`\n\n` : "") +
    `## Device (GET /v1/devices/${device.deviceId})\n\n` +
    `\`\`\`json\n${deviceJson}\n\`\`\`\n\n` +
    `## Status (GET /v1/devices/${device.deviceId}/status)\n\n` +
    `\`\`\`json\n${statusJson}\n\`\`\`\n\n` +
    `## List Item (GET /v1/devices)\n\n` +
    `\`\`\`json\n${listItemJson}\n\`\`\`\n`;

  return (
    <Detail
      isLoading={isLoading}
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action title="Refresh" icon={Icon.RotateClockwise} onAction={revalidate} />
          <Action.CopyToClipboard title="Copy Device JSON" content={deviceJson} />
          <Action.CopyToClipboard title="Copy Status JSON" content={statusJson} />
          <Action.CopyToClipboard title="Copy All (Combined)" content={combinedJson} />
        </ActionPanel>
      }
    />
  );
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

  const brightnessDebounceRef = useRef<Map<string, BrightnessDebounceState>>(new Map());

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

  const queueBrightnessAdjust = useCallback(
    async (deviceId: string, baseLevel: number | undefined, delta: number) => {
      if (!accessToken) return;

      const state = brightnessDebounceRef.current.get(deviceId) ?? {};
      brightnessDebounceRef.current.set(deviceId, state);

      const startingLevel = typeof state.target === "number" ? state.target : baseLevel;
      const resolvedStartingLevel =
        typeof startingLevel === "number" && Number.isFinite(startingLevel)
          ? startingLevel
          : await getSwitchLevelStatus(accessToken, deviceId);

      if (typeof resolvedStartingLevel !== "number" || !Number.isFinite(resolvedStartingLevel)) {
        if (!state.toast) {
          state.toast = await showToast({ style: Toast.Style.Failure, title: "Brightness unavailable" });
        } else {
          state.toast.style = Toast.Style.Failure;
          state.toast.title = "Brightness unavailable";
          state.toast.message = undefined;
        }
        return;
      }

      const nextTarget = clamp(Math.round(resolvedStartingLevel) + delta, 0, 100);
      state.target = nextTarget;

      if (!state.toast) {
        state.toast = await showToast({
          style: Toast.Style.Animated,
          title: "Adjusting brightness…",
          message: `Target: ${nextTarget}%`,
        });
      } else {
        state.toast.style = Toast.Style.Animated;
        state.toast.title = "Adjusting brightness…";
        state.toast.message = `Target: ${nextTarget}%`;
      }

      const commit = async () => {
        if (!accessToken) return;
        if (state.inFlight) {
          state.commitAfterFlight = true;
          return;
        }
        const desired = state.target;
        if (typeof desired !== "number") return;

        state.inFlight = (async () => {
          try {
            if (!state.toast) {
              state.toast = await showToast({ style: Toast.Style.Animated, title: "Setting brightness…" });
            }
            state.toast.style = Toast.Style.Animated;
            state.toast.title = "Setting brightness…";
            state.toast.message = `${desired}%`;

            const currentSwitch = await getSwitchStatus(accessToken, deviceId);
            if (currentSwitch !== "on") {
              state.toast.style = Toast.Style.Failure;
              state.toast.title = "Device is off";
              state.toast.message = undefined;
              state.target = undefined;
              return;
            }

            await setSwitchLevel(accessToken, deviceId, desired);
            state.target = undefined;

            state.toast.style = Toast.Style.Success;
            state.toast.title = `Brightness ${desired}%`;
            state.toast.message = undefined;
            await revalidate();
          } catch (err) {
            if (!state.toast) {
              state.toast = await showToast({ style: Toast.Style.Failure, title: "Failed to set brightness" });
            }
            state.toast.style = Toast.Style.Failure;
            state.toast.title = "Failed to set brightness";
            state.toast.message = String(err);
          } finally {
            state.inFlight = undefined;

            if (state.commitAfterFlight && typeof state.target === "number") {
              state.commitAfterFlight = false;
              // Inactivity period already elapsed; commit immediately.
              await commit();
              return;
            }

            // Auto-hide only when truly idle.
            if (state.toast) {
              const toastToHide = state.toast;
              void (async () => {
                await sleep(900);
                if (state.target == null && !state.timer && !state.inFlight) {
                  try {
                    await toastToHide.hide();
                  } catch {
                    // Ignore
                  }
                }
              })();
            }
          }
        })();
      };

      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.timer = undefined;
        void commit();
      }, BRIGHTNESS_DEBOUNCE_MS);
    },
    [accessToken, revalidate],
  );

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
                {isSwitch && accessToken ? (
                  <Action
                    title={toggleTitle}
                    icon={Icon.Switch}
                    onAction={async () => {
                      await showToast({ style: Toast.Style.Animated, title: "Toggling…" });
                      const current = await getSwitchStatus(accessToken, device.deviceId);
                      const next = current === "on" ? "off" : "on";
                      await setSwitch(accessToken, device.deviceId, next);
                      await showToast({ style: Toast.Style.Success, title: `Turned ${next}` });
                      await revalidate();
                    }}
                  />
                ) : null}

                {kind === "light" &&
                accessToken &&
                cachedSwitchState === "on" &&
                deviceHasCapability(device, "switchLevel") ? (
                  <>
                    <Action
                      title="Brightness Up"
                      icon={Icon.ArrowUp}
                      shortcut={{ modifiers: ["ctrl", "alt"], key: "arrowUp" }}
                      onAction={async () => {
                        await queueBrightnessAdjust(device.deviceId, ui.level, BRIGHTNESS_STEP);
                      }}
                    />
                    <Action
                      title="Brightness Down"
                      icon={Icon.ArrowDown}
                      shortcut={{ modifiers: ["ctrl", "alt"], key: "arrowDown" }}
                      onAction={async () => {
                        await queueBrightnessAdjust(device.deviceId, ui.level, -BRIGHTNESS_STEP);
                      }}
                    />
                  </>
                ) : null}

                <Action title="Refresh" icon={Icon.RotateClockwise} onAction={revalidate} />

                {accessToken ? (
                  <Action.Push
                    title="Show Raw Device Data"
                    icon={Icon.Bug}
                    target={<DeviceRawDataDetail accessToken={accessToken} device={device} />}
                  />
                ) : null}

                <Action
                  title="Reconnect"
                  icon={Icon.Link}
                  onAction={async () => {
                    await LocalStorage.removeItem(STORAGE_SESSION_TOKEN_KEY);
                    await revalidate();
                  }}
                />
                <Action
                  title="Disconnect"
                  icon={Icon.XmarkCircle}
                  onAction={async () => {
                    const sessionToken = await LocalStorage.getItem<string>(STORAGE_SESSION_TOKEN_KEY);
                    if (sessionToken) {
                      try {
                        await brokerLogout(brokerBaseUrl, sessionToken);
                      } catch {
                        // Ignore logout failures; we still clear local state.
                      }
                    }
                    await LocalStorage.removeItem(STORAGE_SESSION_TOKEN_KEY);
                    await showToast({ style: Toast.Style.Success, title: "Disconnected" });
                    await revalidate();
                  }}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
