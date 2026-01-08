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
    categories?: Array<{ name: string; categoryType?: string }>;
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

async function getSmartThingsDevice(accessToken: string, deviceId: string): Promise<any> {
  const url = `https://api.smartthings.com/v1/devices/${encodeURIComponent(deviceId)}`;
  return fetchJson<any>(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
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

type DeviceUiInfo = {
  switchState?: "on" | "off";
  level?: number;
  colorTemperature?: number;
  hue?: number;
  saturation?: number;
  presence?: "present" | "not present";
};

function getDeviceCategoryName(device: SmartThingsDevice): string | undefined {
  const components = device.components ?? [];
  const main = components.find((c) => c.id === "main");
  const orderedComponents = main ? [main, ...components.filter((c) => c !== main)] : components;

  const categories: Array<{ name: string; categoryType?: string }> = [];
  for (const component of orderedComponents) {
    for (const cat of component.categories ?? []) categories.push(cat);
  }

  const user = categories.find((c) => c.categoryType === "user")?.name;
  if (user) return user;

  const manufacturer = categories.find((c) => c.categoryType === "manufacturer")?.name;
  if (manufacturer) return manufacturer;

  return categories[0]?.name;
}

function getDeviceKind(device: SmartThingsDevice): "light" | "television" | "presence" | "switch" | "other" {
  const category = getDeviceCategoryName(device);
  if (category === "Light") return "light";
  if (category === "Television") return "television";
  if (category === "MobilePresence" || category === "PresenceSensor" || category === "Mobile") return "presence";
  if (deviceHasCapability(device, "switch")) return "switch";
  return "other";
}

function iconForKind(kind: "light" | "television" | "presence" | "switch" | "other"): Icon {
  switch (kind) {
    case "light":
      return Icon.LightBulb;
    case "television":
      return Icon.Monitor;
    case "presence":
      return Icon.Livestream;
    case "switch":
      return Icon.Switch;
    default:
      return Icon.Dot;
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function rgbToHex(r: number, g: number, b: number): string {
  const rr = clamp(Math.round(r), 0, 255).toString(16).padStart(2, "0");
  const gg = clamp(Math.round(g), 0, 255).toString(16).padStart(2, "0");
  const bb = clamp(Math.round(b), 0, 255).toString(16).padStart(2, "0");
  return `#${rr}${gg}${bb}`;
}

function hsvToHex(hueDeg: number, saturation01: number, value01: number): string {
  const h = ((hueDeg % 360) + 360) % 360;
  const s = clamp(saturation01, 0, 1);
  const v = clamp(value01, 0, 1);
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (h < 60) {
    r1 = c;
    g1 = x;
  } else if (h < 120) {
    r1 = x;
    g1 = c;
  } else if (h < 180) {
    g1 = c;
    b1 = x;
  } else if (h < 240) {
    g1 = x;
    b1 = c;
  } else if (h < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  return rgbToHex((r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255);
}

function kelvinToHex(kelvin: number): string {
  const temp = clamp(kelvin, 1000, 40000) / 100;

  let red: number;
  let green: number;
  let blue: number;

  if (temp <= 66) {
    red = 255;
    green = 99.4708025861 * Math.log(temp) - 161.1195681661;
    blue = temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
  } else {
    red = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
    green = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
    blue = 255;
  }

  return rgbToHex(red, green, blue);
}

function formatDeviceUiInfo(device: SmartThingsDevice, status: DeviceStatusResponse): DeviceUiInfo {
  const main = status.components?.main;
  if (!main) return {};

  const info: DeviceUiInfo = {};

  if (deviceHasCapability(device, "switch")) {
    const sw = getPathValue(main, ["switch", "switch", "value"]);
    if (sw === "on" || sw === "off") {
      info.switchState = sw;
    }
  }

  if (deviceHasCapability(device, "switchLevel")) {
    const level = getPathValue(main, ["switchLevel", "level", "value"]);
    if (typeof level === "number") info.level = level;
  }

  if (deviceHasCapability(device, "colorTemperature")) {
    const ct = getPathValue(main, ["colorTemperature", "colorTemperature", "value"]);
    if (typeof ct === "number") info.colorTemperature = ct;
  }

  if (deviceHasCapability(device, "colorControl")) {
    const hue = getPathValue(main, ["colorControl", "hue", "value"]);
    const sat = getPathValue(main, ["colorControl", "saturation", "value"]);
    if (typeof hue === "number" && typeof sat === "number") {
      info.hue = hue;
      info.saturation = sat;
    }
  }

  if (deviceHasCapability(device, "presenceSensor")) {
    const presence = getPathValue(main, ["presenceSensor", "presence", "value"]);
    if (presence === "present" || presence === "not present") {
      info.presence = presence;
    }
  }

  return info;
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

function formatAsPrettyJson(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
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
        const kind = getDeviceKind(device);
        const isLight = kind === "light";
        const isSwitch = deviceHasCapability(device, "switch");
        const ui = deviceUiById[device.deviceId] || {};
        const cachedSwitchState = ui.switchState;
        const toggleTitle =
          cachedSwitchState === "on" ? "Turn Off" : cachedSwitchState === "off" ? "Turn On" : "Toggle Switch";

        const subtitle =
          cachedSwitchState === "on" && isLight && typeof ui.level === "number" ? `${Math.round(ui.level)}%` : "";

        const accessoryText =
          cachedSwitchState === "on"
            ? "On"
            : cachedSwitchState === "off"
              ? "Off"
              : ui.presence === "present"
                ? "Present"
                : ui.presence === "not present"
                  ? "Away"
                  : "";

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
