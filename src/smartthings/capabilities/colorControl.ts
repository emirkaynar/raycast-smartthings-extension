import { setColorControl } from "../api";
import type { SmartThingsDevice } from "../types";
import { deviceHasCapability } from "../device";
import { clamp } from "../../shared/number";

export type ColorControlClient = {
  supports: (device: SmartThingsDevice) => boolean;
  setColor: (deviceId: string, hue: number, saturation: number) => Promise<void>;
};

export function createColorControlClient(accessToken: string): ColorControlClient {
  return {
    supports: (device) => deviceHasCapability(device, "colorControl"),
    setColor: async (deviceId, hue, saturation) => {
      const h = clamp(Math.round(hue), 0, 100);
      const s = clamp(Math.round(saturation), 0, 100);
      await setColorControl(accessToken, deviceId, h, s);
    },
  };
}
