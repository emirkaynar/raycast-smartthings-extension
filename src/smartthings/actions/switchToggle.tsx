import { Action, Icon, Toast, showToast } from "@raycast/api";
import type { DeviceActionContext, DeviceActionModule } from "../registry/types";

export const switchToggleAction: DeviceActionModule = {
  id: "switch-toggle",
  group: "primary",
  order: 10,
  isAvailable: (ctx) => Boolean(ctx.accessToken && ctx.switchClient?.supports(ctx.device)),
  render: (ctx) => {
    const cachedSwitchState = ctx.ui.switchState;
    const toggleTitle = cachedSwitchState === "on" ? "Turn Off" : cachedSwitchState === "off" ? "Turn On" : "Toggle Switch";

    return (
      <Action
        title={toggleTitle}
        icon={Icon.Switch}
        onAction={async () => {
          if (!ctx.switchClient) return;

          await showToast({ style: Toast.Style.Animated, title: "Toggling…" });
          const current = await ctx.switchClient.getState(ctx.device.deviceId);
          const next = current === "on" ? "off" : "on";
          await ctx.switchClient.setState(ctx.device.deviceId, next);
          await showToast({ style: Toast.Style.Success, title: `Turned ${next}` });
          await ctx.revalidate();
        }}
      />
    );
  },
};
