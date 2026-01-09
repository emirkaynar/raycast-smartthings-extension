import type { SmartThingsDevice } from "./types";

export function deviceHasCapability(device: SmartThingsDevice, capabilityId: string): boolean {
  const components = device.components ?? [];
  for (const component of components) {
    for (const cap of component.capabilities ?? []) {
      if (cap.id === capabilityId) return true;
    }
  }
  return false;
}

export function getDeviceCategoryName(device: SmartThingsDevice): string | undefined {
  const components = device.components ?? [];
  const main = components.find((c) => c.id === "main");
  const orderedComponents = main ? [main, ...components.filter((c) => c !== main)] : components;

  const categories: Array<{ name: string; categoryType?: string }> = [];
  for (const component of orderedComponents) {
    for (const cat of component.categories ?? []) categories.push(cat);
  }

  const user = categories.find((c) => c.categoryType === "user")?.name;
  if (user) return user;

  const manufacturer = categories.find((c) => c.categoryType === "manufacturer")?.name;
  if (manufacturer) return manufacturer;

  return categories[0]?.name;
}

export function getDeviceKind(device: SmartThingsDevice): "light" | "television" | "presence" | "switch" | "other" {
  const category = getDeviceCategoryName(device);
  if (category === "Light") return "light";
  if (category === "Television") return "television";
  if (category === "MobilePresence" || category === "PresenceSensor" || category === "Mobile") return "presence";
  if (deviceHasCapability(device, "switch")) return "switch";
  return "other";
}
