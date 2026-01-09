import { Action, Icon } from "@raycast/api";
import { DeviceRawDataDetail } from "../../ui/DeviceRawDataDetail";
import type { DeviceActionModule } from "../registry/types";

export const rawDataAction: DeviceActionModule = {
  id: "raw-data",
  group: "debug",
  order: 10,
  isAvailable: (ctx) => Boolean(ctx.accessToken),
  render: (ctx) => (
    <Action.Push
      title="Show Raw Device Data"
      icon={Icon.Bug}
      target={<DeviceRawDataDetail accessToken={ctx.accessToken!} device={ctx.device} />}
    />
  ),
};
