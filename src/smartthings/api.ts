import { fetchJson } from "../shared/http";
import type {
  DeviceStatusResponse,
  SmartThingsDevice,
  SmartThingsDevicesResponse,
  SwitchLevelStatusResponse,
  SwitchStatusResponse,
} from "./types";

export async function listSmartThingsDevices(accessToken: string): Promise<SmartThingsDevice[]> {
  const data = await fetchJson<SmartThingsDevicesResponse>("https://api.smartthings.com/v1/devices", {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  return data.items ?? [];
}

export async function getSmartThingsDevice(accessToken: string, deviceId: string): Promise<any> {
  const url = `https://api.smartthings.com/v1/devices/${encodeURIComponent(deviceId)}`;
  return fetchJson<any>(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
}

export async function getDeviceStatus(accessToken: string, deviceId: string): Promise<DeviceStatusResponse> {
  const url = `https://api.smartthings.com/v1/devices/${encodeURIComponent(deviceId)}/status`;
  return fetchJson<DeviceStatusResponse>(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
}

export async function getSwitchStatus(accessToken: string, deviceId: string): Promise<"on" | "off" | "unknown"> {
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

export async function setSwitch(accessToken: string, deviceId: string, value: "on" | "off"): Promise<void> {
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

export async function getSwitchLevelStatus(accessToken: string, deviceId: string): Promise<number | undefined> {
  const url = `https://api.smartthings.com/v1/devices/${encodeURIComponent(deviceId)}/components/main/capabilities/switchLevel/status`;
  const data = await fetchJson<SwitchLevelStatusResponse>(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });

  const value = data?.level?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function setSwitchLevel(accessToken: string, deviceId: string, level: number): Promise<void> {
  const url = `https://api.smartthings.com/v1/devices/${encodeURIComponent(deviceId)}/commands`;
  await fetchJson(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      commands: [{ component: "main", capability: "switchLevel", command: "setLevel", arguments: [level] }],
    }),
  });
}

export async function setColorControl(accessToken: string, deviceId: string, hue: number, saturation: number): Promise<void> {
  const url = `https://api.smartthings.com/v1/devices/${encodeURIComponent(deviceId)}/commands`;
  const init = (commands: unknown) => ({
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ commands }),
  });

  // Prefer a single command (less likely to produce partial-failure HTTP 424).
  try {
    await fetchJson(url, init([{ component: "main", capability: "colorControl", command: "setColor", arguments: [{ hue, saturation }] }]));
    return;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Fallback for devices that don't implement setColor.
    if (!msg.includes("HTTP 400") && !msg.includes("HTTP 404") && !msg.includes("HTTP 424")) throw err;
  }

  await fetchJson(
    url,
    init([
      { component: "main", capability: "colorControl", command: "setHue", arguments: [hue] },
      { component: "main", capability: "colorControl", command: "setSaturation", arguments: [saturation] },
    ]),
  );
}

export async function setColorTemperature(accessToken: string, deviceId: string, kelvin: number): Promise<void> {
  const url = `https://api.smartthings.com/v1/devices/${encodeURIComponent(deviceId)}/commands`;
  await fetchJson(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      commands: [{ component: "main", capability: "colorTemperature", command: "setColorTemperature", arguments: [kelvin] }],
    }),
  });
}
