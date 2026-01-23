import { Icon } from "@raycast/api";

export function iconForKind(kind: "light" | "television" | "presence" | "switch" | "mobile" | "other"): Icon {
  switch (kind) {
    case "light":
      return Icon.LightBulb;
    case "television":
      return Icon.Monitor;
    case "presence":
      return Icon.Livestream;
    case "switch":
      return Icon.Switch;
    case "mobile":
      return Icon.Mobile;
    default:
      return Icon.Dot;
  }
}
