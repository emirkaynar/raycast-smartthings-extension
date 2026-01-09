import { getSwitchLevelStatus, setSwitchLevel } from "../api";
import type { SmartThingsDevice } from "../types";
import { deviceHasCapability } from "../device";

export type SwitchLevelClient = {
  supports: (device: SmartThingsDevice) => boolean;
  getLevel: (deviceId: string) => Promise<number | undefined>;
  setLevel: (deviceId: string, level: number) => Promise<void>;
};

export function createSwitchLevelClient(accessToken: string): SwitchLevelClient {
  return {
    supports: (device) => deviceHasCapability(device, "switchLevel"),
    getLevel: (deviceId) => getSwitchLevelStatus(accessToken, deviceId),
    setLevel: (deviceId, level) => setSwitchLevel(accessToken, deviceId, level),
  };
}
