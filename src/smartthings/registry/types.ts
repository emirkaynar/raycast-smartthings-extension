import type { LocalStorage, Toast } from "@raycast/api";
import type { SmartThingsDevice } from "../types";
import type { DeviceUiInfo } from "../ui";
import type { SwitchClient } from "../capabilities/switch";
import type { SwitchLevelClient } from "../capabilities/switchLevel";
import type { ColorControlClient } from "../capabilities/colorControl";
import type { ColorTemperatureClient } from "../capabilities/colorTemperature";

export type BrightnessDebounceState = {
  target?: number;
  timer?: ReturnType<typeof setTimeout>;
  toast?: Toast;
  inFlight?: Promise<void>;
  commitAfterFlight?: boolean;
};

export type DeviceActionContext = {
  device: SmartThingsDevice;
  ui: DeviceUiInfo;

  brokerBaseUrl: string;
  accessToken?: string;

  revalidate: () => Promise<void> | void;

  // Capabilities
  switchClient?: SwitchClient;
  switchLevelClient?: SwitchLevelClient;
  colorControlClient?: ColorControlClient;
  colorTemperatureClient?: ColorTemperatureClient;

  // Brightness helpers
  brightnessStep: number;
  queueBrightnessAdjust: (deviceId: string, baseLevel: number | undefined, delta: number) => Promise<void>;

  // Session helpers
  storageSessionTokenKey: string;
  onReconnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;

  // Injected Raycast APIs (keeps modules testable-ish)
  LocalStorage: typeof LocalStorage;
};

export type DeviceActionModule = {
  id: string;
  group: "primary" | "secondary" | "debug";
  order: number;
  isAvailable: (ctx: DeviceActionContext) => boolean;
  render: (ctx: DeviceActionContext) => React.ReactNode | React.ReactNode[];
};
