import { Action, ActionPanel, Detail, Icon } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";

import { formatAsPrettyJson } from "../shared/json";
import { getDeviceStatus, getSmartThingsDevice } from "../smartthings/api";
import type { SmartThingsDevice } from "../smartthings/types";

export function DeviceRawDataDetail(props: { accessToken: string; device: SmartThingsDevice }) {
  const { accessToken, device } = props;

  const { data, isLoading, error, revalidate } = useCachedPromise(
    async (token: string, deviceId: string) => {
      const [fullDevice, status] = await Promise.all([
        getSmartThingsDevice(token, deviceId),
        getDeviceStatus(token, deviceId),
      ]);
      return { fullDevice, status };
    },
    [accessToken, device.deviceId],
    { keepPreviousData: true },
  );

  const title = device.label || device.name || device.deviceId;
  const deviceJson = formatAsPrettyJson(data?.fullDevice);
  const statusJson = formatAsPrettyJson(data?.status);
  const listItemJson = formatAsPrettyJson(device);

  const combinedJson =
    JSON.stringify(
      {
        deviceId: device.deviceId,
        device: data?.fullDevice,
        status: data?.status,
        listItem: device,
      },
      null,
      2,
    ) || "";

  const markdown =
    `# ${title}\n\n` +
    `**Device ID:** ${device.deviceId}\n\n` +
    (error ? `## Error\n\n\`${String(error)}\`\n\n` : "") +
    `## Device (GET /v1/devices/${device.deviceId})\n\n` +
    `\`\`\`json\n${deviceJson}\n\`\`\`\n\n` +
    `## Status (GET /v1/devices/${device.deviceId}/status)\n\n` +
    `\`\`\`json\n${statusJson}\n\`\`\`\n\n` +
    `## List Item (GET /v1/devices)\n\n` +
    `\`\`\`json\n${listItemJson}\n\`\`\`\n`;

  return (
    <Detail
      isLoading={isLoading}
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action title="Refresh" icon={Icon.RotateClockwise} onAction={revalidate} />
          <Action.CopyToClipboard title="Copy Device JSON" content={deviceJson} />
          <Action.CopyToClipboard title="Copy Status JSON" content={statusJson} />
          <Action.CopyToClipboard title="Copy All (Combined)" content={combinedJson} />
        </ActionPanel>
      }
    />
  );
}
