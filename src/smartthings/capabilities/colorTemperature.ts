import { setColorTemperature } from "../api";
import type { SmartThingsDevice } from "../types";
import { deviceHasCapability } from "../device";
import { clamp } from "../../shared/number";

export type ColorTemperatureClient = {
  supports: (device: SmartThingsDevice) => boolean;
  setTemperature: (deviceId: string, kelvin: number) => Promise<void>;
};

export function createColorTemperatureClient(accessToken: string): ColorTemperatureClient {
  return {
    supports: (device) => deviceHasCapability(device, "colorTemperature"),
    setTemperature: async (deviceId, kelvin) => {
      const k = clamp(Math.round(kelvin), 1000, 40000);
      await setColorTemperature(accessToken, deviceId, k);
    },
  };
}
