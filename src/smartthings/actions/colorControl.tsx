import { Action, Icon } from "@raycast/api";

import type { DeviceActionContext, DeviceActionModule } from "../registry/types";
import { ColorControlGrid } from "../views/ColorControlGrid";

export const colorControlAction: DeviceActionModule = {
  id: "color-control",
  group: "primary",
  order: 30,
  isAvailable: (ctx) => {
    if (!ctx.accessToken) return false;
    const hasHs = Boolean(ctx.colorControlClient?.supports(ctx.device));
    const hasTemp = Boolean(ctx.colorTemperatureClient?.supports(ctx.device));
    return hasHs || hasTemp;
  },
  render: (ctx) => (
    <Action.Push
      title="Color Control"
      icon={Icon.Brush}
      shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }}
      target={<ColorControlGrid ctx={ctx} />}
    />
  ),
};
