import { Action, ActionPanel, Form, Grid, Icon, Toast, showToast, type LocalStorage, useNavigation } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useMemo } from "react";

import { hexToHsv, kelvinToHex } from "../../shared/color";
import { clamp } from "../../shared/number";
import type { DeviceActionContext } from "../registry/types";

type HsTile = { id: string; title: string; hex: string };
type TempTile = { id: string; title: string; kelvin: number };

type StoredCustomColor = {
  id: string;
  name: string;
  hex: string;
};

const CUSTOM_COLORS_KEY = "smartthings_custom_colors";

function normalizeHex(input: string): string {
  const cleaned = input.trim();
  if (cleaned.startsWith("#")) return cleaned;
  return `#${cleaned}`;
}

async function loadCustomColors(storage: typeof LocalStorage): Promise<StoredCustomColor[]> {
  const raw = await storage.getItem<string>(CUSTOM_COLORS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => {
        if (!x || typeof x !== "object") return undefined;
        const rec = x as Record<string, unknown>;
        const id = typeof rec.id === "string" ? rec.id : undefined;
        const name = typeof rec.name === "string" ? rec.name : undefined;
        const hex = typeof rec.hex === "string" ? rec.hex : undefined;
        if (!id || !name || !hex) return undefined;
        return { id, name, hex } satisfies StoredCustomColor;
      })
      .filter(Boolean) as StoredCustomColor[];
  } catch {
    return [];
  }
}

async function saveCustomColors(storage: typeof LocalStorage, colors: StoredCustomColor[]): Promise<void> {
  await storage.setItem(CUSTOM_COLORS_KEY, JSON.stringify(colors));
}

export function ColorControlGrid(props: { ctx: DeviceActionContext }) {
  const { ctx } = props;

  const canHs = Boolean(ctx.colorControlClient?.supports(ctx.device));
  const canTemp = Boolean(ctx.colorTemperatureClient?.supports(ctx.device));

  const { data: customColors, isLoading, revalidate } = useCachedPromise(
    async () => {
      return loadCustomColors(ctx.LocalStorage);
    },
    [],
    { keepPreviousData: true },
  );

  const presets = useMemo(() => {
    const tiles: { reds: HsTile[]; greens: HsTile[]; blues: HsTile[]; whites: TempTile[] } = {
      reds: [],
      greens: [],
      blues: [],
      whites: [],
    };

    if (canHs) {
      const reds: Array<{ title: string; hex: string }> = [
        { title: "Ruby", hex: "#FF1744" },
        { title: "Flame", hex: "#FF3D00" },
        { title: "Rose", hex: "#FF5252" },
        { title: "Crimson", hex: "#D50000" },
        { title: "Brick", hex: "#C62828" },
        { title: "Coral", hex: "#FF6F61" },
      ];
      const greens: Array<{ title: string; hex: string }> = [
        { title: "Emerald", hex: "#00E676" },
        { title: "Jade", hex: "#00C853" },
        { title: "Forest", hex: "#2E7D32" },
        { title: "Teal", hex: "#00BFA5" },
        { title: "Mint", hex: "#1DE9B6" },
        { title: "Lime", hex: "#76FF03" },
      ];
      const blues: Array<{ title: string; hex: string }> = [
        { title: "Azure", hex: "#2979FF" },
        { title: "Sky", hex: "#00B0FF" },
        { title: "Indigo", hex: "#1A237E" },
        { title: "Periwinkle", hex: "#3D5AFE" },
        { title: "Violet", hex: "#651FFF" },
        { title: "Cyan", hex: "#18FFFF" },
      ];

      tiles.reds = reds.map((c, i) => ({ id: `red-${i}`, title: c.title, hex: c.hex }));
      tiles.greens = greens.map((c, i) => ({ id: `green-${i}`, title: c.title, hex: c.hex }));
      tiles.blues = blues.map((c, i) => ({ id: `blue-${i}`, title: c.title, hex: c.hex }));
    }

    if (canTemp) {
      const kelvins = [6500, 5600, 4800, 4000, 3200, 2700];
      tiles.whites = kelvins.map((k, i) => ({ id: `white-${i}`, title: `${k}K`, kelvin: k }));
    }

    return tiles;
  }, [canHs, canTemp]);

  const title = ctx.device.label || ctx.device.name || "Color Control";

  async function ensureOn() {
    if (!ctx.switchClient?.supports(ctx.device)) return;
    if (ctx.ui.switchState === "on") return;
    try {
      await ctx.switchClient.setState(ctx.device.deviceId, "on");
    } catch {
      // If turning on fails but color-setting succeeds, don't surface the turn-on failure.
    }
  }

  async function applyHs(hex: string) {
    if (!ctx.accessToken || !ctx.colorControlClient) return;

    const hsv = hexToHsv(hex);
    if (!hsv) {
      await showToast({ style: Toast.Style.Failure, title: "Invalid color", message: hex });
      return;
    }

    const hue100 = clamp(Math.round((hsv.hueDeg / 360) * 100), 0, 100);
    const sat100 = clamp(Math.round(hsv.saturation01 * 100), 0, 100);

    const toast = await showToast({ style: Toast.Style.Animated, title: "Setting color…" });
    try {
      await ensureOn();
      await ctx.colorControlClient.setColor(ctx.device.deviceId, hue100, sat100);
      toast.style = Toast.Style.Success;
      toast.title = "Color set";
      await ctx.revalidate();
    } catch (err) {
      toast.style = Toast.Style.Failure;
      toast.title = "Failed to set color";
      toast.message = String(err);
    }
  }

  async function applyTemperature(kelvin: number) {
    if (!ctx.accessToken || !ctx.colorTemperatureClient) return;

    const toast = await showToast({ style: Toast.Style.Animated, title: "Setting temperature…", message: `${kelvin}K` });
    try {
      await ensureOn();
      await ctx.colorTemperatureClient.setTemperature(ctx.device.deviceId, kelvin);
      toast.style = Toast.Style.Success;
      toast.title = "Temperature set";
      toast.message = `${kelvin}K`;
      await ctx.revalidate();
    } catch (err) {
      toast.style = Toast.Style.Failure;
      toast.title = "Failed to set temperature";
      toast.message = String(err);
    }
  }

  return (
    <Grid columns={6} navigationTitle={title} isLoading={isLoading} searchBarPlaceholder="Search colors…">
      {canHs ? (
        <Grid.Section title="Custom">
          <Grid.Item
            key="add-custom"
            content={{ source: Icon.Plus }}
            title="Add Color"
            actions={
              <ActionPanel>
                <Action.Push
                  title="Add Custom Color"
                  icon={Icon.Plus}
                  target={<AddCustomColorForm storage={ctx.LocalStorage} onDone={revalidate} />}
                />
              </ActionPanel>
            }
          />
          {(customColors ?? []).map((c) => (
            <Grid.Item
              key={c.id}
              content={{ color: c.hex }}
              title={c.name}
              subtitle={c.hex}
              actions={
                <ActionPanel>
                  <Action title="Set Color" icon={Icon.Dot} onAction={() => applyHs(c.hex)} />
                  <Action
                    title="Remove Color"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    onAction={async () => {
                      const existing = await loadCustomColors(ctx.LocalStorage);
                      await saveCustomColors(ctx.LocalStorage, existing.filter((x) => x.id !== c.id));
                      await revalidate();
                      await showToast({ style: Toast.Style.Success, title: "Removed" });
                    }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </Grid.Section>
      ) : null}

      {canHs ? (
        <>
          <Grid.Section title="Reds">
            {presets.reds.map((t) => (
              <Grid.Item
                key={t.id}
                content={{ color: t.hex }}
                title={t.title}
                actions={
                  <ActionPanel>
                    <Action title="Set Color" icon={Icon.Dot} onAction={() => applyHs(t.hex)} />
                  </ActionPanel>
                }
              />
            ))}
          </Grid.Section>

          <Grid.Section title="Greens">
            {presets.greens.map((t) => (
              <Grid.Item
                key={t.id}
                content={{ color: t.hex }}
                title={t.title}
                actions={
                  <ActionPanel>
                    <Action title="Set Color" icon={Icon.Dot} onAction={() => applyHs(t.hex)} />
                  </ActionPanel>
                }
              />
            ))}
          </Grid.Section>

          <Grid.Section title="Blues">
            {presets.blues.map((t) => (
              <Grid.Item
                key={t.id}
                content={{ color: t.hex }}
                title={t.title}
                actions={
                  <ActionPanel>
                    <Action title="Set Color" icon={Icon.Dot} onAction={() => applyHs(t.hex)} />
                  </ActionPanel>
                }
              />
            ))}
          </Grid.Section>
        </>
      ) : null}

      {canTemp ? (
        <Grid.Section title="Whites (Cool → Warm)">
          {presets.whites.map((t) => (
            <Grid.Item
              key={t.id}
              content={{ color: kelvinToHex(t.kelvin) }}
              title={t.title}
              actions={
                <ActionPanel>
                  <Action title="Set Temperature" icon={Icon.Sun} onAction={() => applyTemperature(t.kelvin)} />
                </ActionPanel>
              }
            />
          ))}
        </Grid.Section>
      ) : null}

      {!canHs && !canTemp ? <Grid.EmptyView title="Color control not supported" /> : null}
    </Grid>
  );
}

function AddCustomColorForm(props: { storage: typeof LocalStorage; onDone: () => void }) {
  const { storage, onDone } = props;
  const { pop } = useNavigation();

  return (
    <Form
      navigationTitle="Add Custom Color"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save Color"
            onSubmit={async (values) => {
              const name = typeof values.name === "string" ? values.name.trim() : "";
              const hex = typeof values.hex === "string" ? normalizeHex(values.hex) : "";
              const hsv = hexToHsv(hex);
              if (!name) {
                await showToast({ style: Toast.Style.Failure, title: "Name is required" });
                return;
              }
              if (!hsv) {
                await showToast({ style: Toast.Style.Failure, title: "Invalid hex", message: "Use #RRGGBB" });
                return;
              }

              const existing = await loadCustomColors(storage);
              const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
              await saveCustomColors(storage, [{ id, name, hex }, ...existing]);
              await showToast({ style: Toast.Style.Success, title: "Saved" });
              onDone();
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField id="name" title="Name" placeholder="My Color" />
      <Form.TextField id="hex" title="Hex" placeholder="#FF1744" />
      <Form.Description text="Tip: you can paste hex with or without # (format: #RRGGBB)." />
    </Form>
  );
}
