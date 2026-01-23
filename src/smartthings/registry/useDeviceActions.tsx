import { ActionPanel, LocalStorage, Toast, showToast } from "@raycast/api";
import { cloneElement, isValidElement, useCallback, useMemo, useRef } from "react";

import { clamp } from "../../shared/number";
import { sleep } from "../../shared/time";
import { createSwitchClient } from "../capabilities/switch";
import { createSwitchLevelClient } from "../capabilities/switchLevel";
import { createColorControlClient } from "../capabilities/colorControl";
import { createColorTemperatureClient } from "../capabilities/colorTemperature";
import type { SmartThingsDevice } from "../types";
import type { DeviceUiInfo } from "../ui";
import type { BrightnessDebounceState, DeviceActionContext, DeviceActionModule } from "./types";

import { markDeviceUsed } from "../lastUsed";

import { switchToggleAction } from "../actions/switchToggle";
import { brightnessActions } from "../actions/brightness";
import { colorControlAction } from "../actions/colorControl";
import { sessionActions } from "../actions/session";
import { rawDataAction } from "../actions/rawData";

export type UseDeviceActionsParams = {
  brokerBaseUrl: string;
  accessToken?: string;
  revalidate: () => Promise<void> | void;

  onDeviceUsed?: (deviceId: string, usedAtMs: number) => void;

  storageSessionTokenKey: string;
  onReconnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;

  brightnessStep: number;
  brightnessDebounceMs: number;

  // Allows the command file to inject extra modules.
  extraModules?: DeviceActionModule[];
};

export function useDeviceActions(params: UseDeviceActionsParams) {
  const {
    brokerBaseUrl,
    accessToken,
    revalidate,
    onDeviceUsed,
    storageSessionTokenKey,
    onReconnect,
    onDisconnect,
    brightnessStep,
    brightnessDebounceMs,
    extraModules,
  } = params;

  const brightnessDebounceRef = useRef<Map<string, BrightnessDebounceState>>(new Map());

  const switchClient = useMemo(() => (accessToken ? createSwitchClient(accessToken) : undefined), [accessToken]);
  const switchLevelClient = useMemo(
    () => (accessToken ? createSwitchLevelClient(accessToken) : undefined),
    [accessToken],
  );
  const colorControlClient = useMemo(
    () => (accessToken ? createColorControlClient(accessToken) : undefined),
    [accessToken],
  );
  const colorTemperatureClient = useMemo(
    () => (accessToken ? createColorTemperatureClient(accessToken) : undefined),
    [accessToken],
  );

  const queueBrightnessAdjust = useCallback(
    async (deviceId: string, baseLevel: number | undefined, delta: number) => {
      if (!accessToken || !switchLevelClient || !switchClient) return;

      const state = brightnessDebounceRef.current.get(deviceId) ?? {};
      brightnessDebounceRef.current.set(deviceId, state);

      const startingLevel = typeof state.target === "number" ? state.target : baseLevel;
      const resolvedStartingLevel =
        typeof startingLevel === "number" && Number.isFinite(startingLevel)
          ? startingLevel
          : await switchLevelClient.getLevel(deviceId);

      if (typeof resolvedStartingLevel !== "number" || !Number.isFinite(resolvedStartingLevel)) {
        if (!state.toast) {
          state.toast = await showToast({ style: Toast.Style.Failure, title: "Brightness unavailable" });
        } else {
          state.toast.style = Toast.Style.Failure;
          state.toast.title = "Brightness unavailable";
          state.toast.message = undefined;
        }
        return;
      }

      const nextTarget = clamp(Math.round(resolvedStartingLevel) + delta, 0, 100);
      state.target = nextTarget;

      if (!state.toast) {
        state.toast = await showToast({
          style: Toast.Style.Animated,
          title: "Adjusting brightness…",
          message: `Target: ${nextTarget}%`,
        });
      } else {
        state.toast.style = Toast.Style.Animated;
        state.toast.title = "Adjusting brightness…";
        state.toast.message = `Target: ${nextTarget}%`;
      }

      const commit = async () => {
        if (!accessToken || !switchLevelClient || !switchClient) return;
        if (state.inFlight) {
          state.commitAfterFlight = true;
          return;
        }

        const desired = state.target;
        if (typeof desired !== "number") return;

        state.inFlight = (async () => {
          try {
            if (!state.toast) {
              state.toast = await showToast({ style: Toast.Style.Animated, title: "Setting brightness…" });
            }

            state.toast.style = Toast.Style.Animated;
            state.toast.title = "Setting brightness…";
            state.toast.message = `${desired}%`;

            const currentSwitch = await switchClient.getState(deviceId);
            if (currentSwitch !== "on") {
              state.toast.style = Toast.Style.Failure;
              state.toast.title = "Device is off";
              state.toast.message = undefined;
              state.target = undefined;
              return;
            }

            await switchLevelClient.setLevel(deviceId, desired);
            const usedAtMs = await markDeviceUsed(LocalStorage, deviceId);
            onDeviceUsed?.(deviceId, usedAtMs);
            state.target = undefined;

            state.toast.style = Toast.Style.Success;
            state.toast.title = `Brightness ${desired}%`;
            state.toast.message = undefined;
            await revalidate();
          } catch (err) {
            if (!state.toast) {
              state.toast = await showToast({ style: Toast.Style.Failure, title: "Failed to set brightness" });
            }
            state.toast.style = Toast.Style.Failure;
            state.toast.title = "Failed to set brightness";
            state.toast.message = String(err);
          } finally {
            state.inFlight = undefined;

            if (state.commitAfterFlight && typeof state.target === "number") {
              state.commitAfterFlight = false;
              await commit();
              return;
            }

            if (state.toast) {
              const toastToHide = state.toast;
              void (async () => {
                await sleep(900);
                if (state.target == null && !state.timer && !state.inFlight) {
                  try {
                    await toastToHide.hide();
                  } catch {
                    // Ignore
                  }
                }
              })();
            }
          }
        })();
      };

      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.timer = undefined;
        void commit();
      }, brightnessDebounceMs);
    },
    [accessToken, brightnessDebounceMs, onDeviceUsed, revalidate, switchClient, switchLevelClient],
  );

  const markUsed = useCallback(
    async (deviceId: string) => {
      const usedAtMs = await markDeviceUsed(LocalStorage, deviceId);
      onDeviceUsed?.(deviceId, usedAtMs);
    },
    [onDeviceUsed],
  );

  const baseModules: DeviceActionModule[] = useMemo(() => {
    const modules: DeviceActionModule[] = [
      switchToggleAction,
      brightnessActions,
      colorControlAction,
      rawDataAction,
      sessionActions,
    ];
    if (extraModules?.length) modules.push(...extraModules);
    const groupOrder: Record<DeviceActionModule["group"], number> = {
      primary: 0,
      secondary: 1,
      debug: 2,
    };
    return modules.sort((a, b) => {
      const groupDelta = groupOrder[a.group] - groupOrder[b.group];
      if (groupDelta !== 0) return groupDelta;
      const orderDelta = a.order - b.order;
      if (orderDelta !== 0) return orderDelta;
      return a.id.localeCompare(b.id);
    });
  }, [extraModules]);

  const getContext = useCallback(
    (device: SmartThingsDevice, ui: DeviceUiInfo): DeviceActionContext => {
      return {
        device,
        ui,
        brokerBaseUrl,
        accessToken,
        revalidate,

        switchClient,
        switchLevelClient,
        colorControlClient,
        colorTemperatureClient,

        brightnessStep,
        queueBrightnessAdjust,

        storageSessionTokenKey,
        onReconnect,
        onDisconnect,

        markDeviceUsed: markUsed,

        LocalStorage,
      };
    },
    [
      accessToken,
      brokerBaseUrl,
      brightnessStep,
      onDisconnect,
      onReconnect,
      queueBrightnessAdjust,
      revalidate,
      storageSessionTokenKey,
      switchClient,
      switchLevelClient,
      colorControlClient,
      colorTemperatureClient,
      markUsed,
    ],
  );

  const renderActionsForDevice = useCallback(
    (device: SmartThingsDevice, ui: DeviceUiInfo) => {
      const ctx = getContext(device, ui);
      const primary: React.ReactNode[] = [];
      const secondary: React.ReactNode[] = [];
      const debug: React.ReactNode[] = [];

      const pushRendered = (
        target: React.ReactNode[],
        moduleId: string,
        rendered: React.ReactNode | React.ReactNode[],
      ) => {
        const items = Array.isArray(rendered) ? rendered : [rendered];
        for (let i = 0; i < items.length; i++) {
          const node = items[i];
          if (isValidElement(node) && node.key == null) {
            target.push(cloneElement(node, { key: `${moduleId}:${i}` }));
          } else {
            target.push(node);
          }
        }
      };

      for (const module of baseModules) {
        if (!module.isAvailable(ctx)) continue;
        const rendered = module.render(ctx);
        const target = module.group === "debug" ? debug : module.group === "secondary" ? secondary : primary;
        pushRendered(target, module.id, rendered);
      }

      const sections: React.ReactNode[] = [];
      if (primary.length)
        sections.push(
          <ActionPanel.Section key="primary" title="Controls">
            {primary}
          </ActionPanel.Section>,
        );
      if (secondary.length)
        sections.push(
          <ActionPanel.Section key="secondary" title="Session">
            {secondary}
          </ActionPanel.Section>,
        );
      if (debug.length)
        sections.push(
          <ActionPanel.Section key="debug" title="Debug">
            {debug}
          </ActionPanel.Section>,
        );
      return sections;
    },
    [baseModules, getContext],
  );

  return {
    renderActionsForDevice,
  };
}
