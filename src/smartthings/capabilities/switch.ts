import { getSwitchStatus, setSwitch } from "../api";
import type { SmartThingsDevice } from "../types";
import { deviceHasCapability } from "../device";

export type SwitchState = "on" | "off" | "unknown";

export type SwitchClient = {
  supports: (device: SmartThingsDevice) => boolean;
  getState: (deviceId: string) => Promise<SwitchState>;
  setState: (deviceId: string, value: Exclude<SwitchState, "unknown">) => Promise<void>;
};

export function createSwitchClient(accessToken: string): SwitchClient {
  return {
    supports: (device) => deviceHasCapability(device, "switch"),
    getState: (deviceId) => getSwitchStatus(accessToken, deviceId),
    setState: (deviceId, value) => setSwitch(accessToken, deviceId, value),
  };
}
