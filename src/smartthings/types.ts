export type SmartThingsDevice = {
  deviceId: string;
  name?: string;
  label?: string;
  components?: Array<{
    id: string;
    capabilities?: Array<{ id: string }>;
    categories?: Array<{ name: string; categoryType?: string }>;
  }>;
};

export type SmartThingsDevicesResponse = {
  items: SmartThingsDevice[];
};

export type SwitchStatusResponse = {
  switch?: { value?: "on" | "off" };
};

export type SwitchLevelStatusResponse = {
  level?: { value?: number };
};

export type DeviceStatusResponse = {
  components?: Record<string, Record<string, any>>;
};
