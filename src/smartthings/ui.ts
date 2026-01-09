import { getPathValue } from "../shared/json";
import { deviceHasCapability } from "./device";
import type { DeviceStatusResponse, SmartThingsDevice } from "./types";

export type DeviceUiInfo = {
  switchState?: "on" | "off";
  level?: number;
  colorTemperature?: number;
  hue?: number;
  saturation?: number;
  presence?: "present" | "not present";
};

export function formatDeviceUiInfo(device: SmartThingsDevice, status: DeviceStatusResponse): DeviceUiInfo {
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
