import {
  Action,
  ActionPanel,
  Icon,
  List,
  LocalStorage,
  Toast,
  getPreferenceValues,
  open,
  showToast,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useCallback, useMemo } from "react";

type Preferences = {
  brokerBaseUrl: string;
};

type PairResponse = {
  pairId: string;
  authorizationUrl: string;
  expiresInSeconds: number;
};

type PairStatusResponse = {
  status: "pending" | "completed" | "error";
  sessionToken?: string;
  error?: string;
};

type AccessTokenResponse = {
  accessToken: string;
  expiresAt: string;
};

type SmartThingsDevice = {
  deviceId: string;
  name?: string;
  label?: string;
  components?: Array<{
    id: string;
    capabilities?: Array<{ id: string }>;
  }>;
};

type SmartThingsDevicesResponse = {
  items: SmartThingsDevice[];
};

type SwitchStatusResponse = {
  switch?: { value?: "on" | "off" };
};

type DeviceStatusResponse = {
  components?: Record<string, Record<string, any>>;
};

const STORAGE_SESSION_TOKEN_KEY = "smartthings_session_token";

function normalizeBaseUrl(input: string): string {
  return input.replace(/\/+$/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

async function createPair(brokerBaseUrl: string): Promise<PairResponse> {
  return fetchJson<PairResponse>(`${brokerBaseUrl}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
}

async function getPairStatus(brokerBaseUrl: string, pairId: string): Promise<PairStatusResponse> {
  return fetchJson<PairStatusResponse>(`${brokerBaseUrl}/v1/pair/${encodeURIComponent(pairId)}`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
}

async function getBrokerAccessToken(brokerBaseUrl: string, sessionToken: string): Promise<AccessTokenResponse> {
  return fetchJson<AccessTokenResponse>(`${brokerBaseUrl}/v1/access-token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
  });
}

async function brokerLogout(brokerBaseUrl: string, sessionToken: string): Promise<void> {
  await fetchJson(`${brokerBaseUrl}/v1/logout`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
    },
  });
}

async function listSmartThingsDevices(accessToken: string): Promise<SmartThingsDevice[]> {
  const data = await fetchJson<SmartThingsDevicesResponse>("https://api.smartthings.com/v1/devices", {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  return data.items ?? [];
}

async function getDeviceStatus(accessToken: string, deviceId: string): Promise<DeviceStatusResponse> {
  const url = `https://api.smartthings.com/v1/devices/${encodeURIComponent(deviceId)}/status`;
  return fetchJson<DeviceStatusResponse>(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
}

function getPathValue(obj: any, path: string[]): unknown {
  let cur: any = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

function formatDeviceStatus(
  device: SmartThingsDevice,
  status: DeviceStatusResponse,
): { text: string; switchState?: "on" | "off" } {
  const main = status.components?.main;
  if (!main) return { text: "" };

  const parts: string[] = [];
  let switchState: "on" | "off" | undefined;

  if (deviceHasCapability(device, "switch")) {
    const sw = getPathValue(main, ["switch", "switch", "value"]);
    if (sw === "on" || sw === "off") {
      switchState = sw;
      parts.push(sw === "on" ? "On" : "Off");
    }
  }

  if (deviceHasCapability(device, "switchLevel")) {
    const level = getPathValue(main, ["switchLevel", "level", "value"]);
    if (typeof level === "number") parts.push(`${level}%`);
  }

  if (deviceHasCapability(device, "colorTemperature")) {
    const ct = getPathValue(main, ["colorTemperature", "colorTemperature", "value"]);
    if (typeof ct === "number") parts.push(`${ct}K`);
  }

  if (deviceHasCapability(device, "colorControl")) {
    const hue = getPathValue(main, ["colorControl", "hue", "value"]);
    const sat = getPathValue(main, ["colorControl", "saturation", "value"]);
    if (typeof hue === "number" && typeof sat === "number") {
      parts.push(`H${Math.round(hue)} S${Math.round(sat)}`);
    }
  }

  return { text: parts.join(" · "), switchState };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });

  await Promise.all(workers);
  return results;
}

function deviceHasCapability(device: SmartThingsDevice, capabilityId: string): boolean {
  const components = device.components ?? [];
  for (const component of components) {
    for (const cap of component.capabilities ?? []) {
      if (cap.id === capabilityId) return true;
    }
  }
  return false;
}

async function getSwitchStatus(accessToken: string, deviceId: string): Promise<"on" | "off" | "unknown"> {
  // Minimal endpoint for switch capability.
  const url = `https://api.smartthings.com/v1/devices/${encodeURIComponent(deviceId)}/components/main/capabilities/switch/status`;
  const data = await fetchJson<SwitchStatusResponse>(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  const value = data?.switch?.value;
  return value === "on" || value === "off" ? value : "unknown";
}

async function setSwitch(accessToken: string, deviceId: string, value: "on" | "off"): Promise<void> {
  const url = `https://api.smartthings.com/v1/devices/${encodeURIComponent(deviceId)}/commands`;
  await fetchJson(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      commands: [{ component: "main", capability: "switch", command: value }],
    }),
  });
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

  const deadline = Date.now() + 2 * 60_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const status = await getPairStatus(brokerBaseUrl, pair.pairId);
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
      // If the broker no longer recognizes the session token, clear it and retry once.
      await LocalStorage.removeItem(STORAGE_SESSION_TOKEN_KEY);
      const newSessionToken = await ensureConnected(brokerBaseUrl);
      const token = await getBrokerAccessToken(brokerBaseUrl, newSessionToken);
      accessToken = token.accessToken;
    }

    const devices = await listSmartThingsDevices(accessToken);

    const deviceStatusById: Record<string, string> = {};
    const deviceSwitchStateById: Record<string, "on" | "off"> = {};
    await mapWithConcurrency(devices, 6, async (device) => {
      try {
        const status = await getDeviceStatus(accessToken, device.deviceId);
        const formatted = formatDeviceStatus(device, status);
        if (formatted.text) deviceStatusById[device.deviceId] = formatted.text;
        if (formatted.switchState) deviceSwitchStateById[device.deviceId] = formatted.switchState;
      } catch {
        // Ignore per-device status failures.
      }
      return undefined;
    });

    return { devices, accessToken, deviceStatusById, deviceSwitchStateById };
  }, [brokerBaseUrl]);

  const { data, isLoading, error, revalidate } = useCachedPromise(loadDevices, [], {
    keepPreviousData: true,
  });

  const devices = data?.devices ?? [];
  const accessToken = data?.accessToken;
  const deviceStatusById = data?.deviceStatusById ?? {};
  const deviceSwitchStateById = data?.deviceSwitchStateById ?? {};

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search devices…">
      {error ? <List.EmptyView title="Error" description={String(error)} /> : null}
      {!error && devices.length === 0 && !isLoading ? (
        <List.EmptyView
          title="No devices found"
          description="Your account has no devices, or the app lacks device scopes."
        />
      ) : null}

      {devices.map((device) => {
        const title = device.label || device.name || device.deviceId;
        const isSwitch = deviceHasCapability(device, "switch");
        const subtitle = deviceStatusById[device.deviceId] || device.deviceId;
        const cachedSwitchState = deviceSwitchStateById[device.deviceId];
        const toggleTitle =
          cachedSwitchState === "on" ? "Turn Off" : cachedSwitchState === "off" ? "Turn On" : "Toggle Switch";
        return (
          <List.Item
            key={device.deviceId}
            title={title}
            subtitle={subtitle}
            icon={isSwitch ? Icon.LightBulb : Icon.Dot}
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

                <Action title="Refresh" icon={Icon.RotateClockwise} onAction={revalidate} />
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
