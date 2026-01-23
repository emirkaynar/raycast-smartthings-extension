import type { LocalStorage } from "@raycast/api";

const DEVICE_LAST_USED_KEY = "smartthings_device_last_used_v1";

export type DeviceLastUsedMap = Record<string, number>;

function normalizeMap(input: unknown): DeviceLastUsedMap {
  if (!input || typeof input !== "object") return {};

  const rec = input as Record<string, unknown>;
  const out: DeviceLastUsedMap = {};
  for (const [deviceId, value] of Object.entries(rec)) {
    if (typeof deviceId !== "string" || !deviceId) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    out[deviceId] = value;
  }
  return out;
}

export async function loadDeviceLastUsed(storage: typeof LocalStorage): Promise<DeviceLastUsedMap> {
  const raw = await storage.getItem(DEVICE_LAST_USED_KEY);
  if (raw == null) return {};

  if (typeof raw === "string") {
    try {
      return normalizeMap(JSON.parse(raw) as unknown);
    } catch {
      return {};
    }
  }

  return normalizeMap(raw);
}

export async function markDeviceUsed(
  storage: typeof LocalStorage,
  deviceId: string,
  atMs: number = Date.now(),
): Promise<number> {
  const map = await loadDeviceLastUsed(storage);
  map[deviceId] = atMs;
  // Store as JSON to match LocalStorage.Value constraints; loadDeviceLastUsed also tolerates older object storage.
  await storage.setItem(DEVICE_LAST_USED_KEY, JSON.stringify(map));
  return atMs;
}
