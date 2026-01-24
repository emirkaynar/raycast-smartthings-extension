import { Action, Icon, Toast, showToast } from "@raycast/api";
import type { DeviceActionModule } from "../registry/types";

export const sessionActions: DeviceActionModule = {
  id: "session",
  group: "secondary",
  order: 100,
  isAvailable: () => true,
  render: (ctx) => [
    <Action key="refresh" title="Refresh" icon={Icon.RotateClockwise} onAction={ctx.revalidate} />,
    <Action
      key="reconnect"
      title="Reconnect"
      icon={Icon.Link}
      onAction={async () => {
        await ctx.onReconnect();
      }}
    />,
    <Action
      key="disconnect"
      title="Disconnect"
      icon={Icon.XmarkCircle}
      onAction={async () => {
        await ctx.onDisconnect();
        await showToast({ style: Toast.Style.Success, title: "Disconnected" });
      }}
    />,
  ],
};
