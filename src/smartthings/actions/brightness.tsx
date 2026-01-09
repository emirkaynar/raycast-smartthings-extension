import { Action, Icon } from "@raycast/api";
import type { DeviceActionContext, DeviceActionModule } from "../registry/types";

export const brightnessActions: DeviceActionModule = {
  id: "brightness",
  group: "primary",
  order: 20,
  isAvailable: (ctx) => {
    // Keep existing UX requirement: brightness controls only when the device is ON.
    return Boolean(
      ctx.accessToken &&
        ctx.switchLevelClient?.supports(ctx.device) &&
        ctx.ui.switchState === "on",
    );
  },
  render: (ctx) => {
    const step = ctx.brightnessStep;
    return [
      <Action
        key="brightness-up"
        title="Brightness Up"
        icon={Icon.ArrowUp}
        shortcut={{ modifiers: ["ctrl", "alt"], key: "arrowUp" }}
        onAction={async () => {
          await ctx.queueBrightnessAdjust(ctx.device.deviceId, ctx.ui.level, step);
        }}
      />,
      <Action
        key="brightness-down"
        title="Brightness Down"
        icon={Icon.ArrowDown}
        shortcut={{ modifiers: ["ctrl", "alt"], key: "arrowDown" }}
        onAction={async () => {
          await ctx.queueBrightnessAdjust(ctx.device.deviceId, ctx.ui.level, -step);
        }}
      />,
    ];
  },
};
