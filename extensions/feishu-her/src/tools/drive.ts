/**
 * Feishu Drive (cloud storage) tool — list, create folder, move, delete files.
 * Adapted from @m1heng-clawd/feishu with schema guardrails (no Type.Union).
 */

import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { stringEnum } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import { getFeishuClient } from "../outbound.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ── Actions ──

async function listFolder(client: Lark.Client, folderToken?: string) {
  const validFolderToken = folderToken && folderToken !== "0" ? folderToken : undefined;
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.drive.file.list({
    params: validFolderToken ? { folder_token: validFolderToken } : {},
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    files: (res.data?.files ?? []).map((f: any) => ({
      token: f.token,
      name: f.name,
      type: f.type,
      url: f.url,
      created_time: f.created_time,
      modified_time: f.modified_time,
      owner_id: f.owner_id,
    })),
    next_page_token: res.data?.next_page_token,
  };
}

async function createFolder(client: Lark.Client, name: string, folderToken?: string) {
  const effectiveToken = folderToken && folderToken !== "0" ? folderToken : "0";
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.drive.file.createFolder({
    data: { name, folder_token: effectiveToken },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { token: res.data?.token, url: res.data?.url };
}

async function moveFile(
  client: Lark.Client,
  fileToken: string,
  fileType: string,
  folderToken: string,
) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.drive.file.move({
    path: { file_token: fileToken },
    // oxlint-disable-next-line typescript/no-explicit-any
    data: { type: fileType as any, folder_token: folderToken },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { success: true, task_id: res.data?.task_id };
}

async function deleteFile(client: Lark.Client, fileToken: string, fileType: string) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.drive.file.delete({
    path: { file_token: fileToken },
    // oxlint-disable-next-line typescript/no-explicit-any
    params: { type: fileType as any },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { success: true, task_id: res.data?.task_id };
}

// ── Schema ──

const DRIVE_ACTIONS = ["list", "create_folder", "move", "delete"] as const;

const FeishuDriveSchema = Type.Object({
  action: stringEnum(DRIVE_ACTIONS, { description: "Drive operation to perform" }),
  folder_token: Type.Optional(
    Type.String({ description: "Folder token (for list/create_folder/move target)" }),
  ),
  name: Type.Optional(Type.String({ description: "Folder name (for create_folder)" })),
  file_token: Type.Optional(Type.String({ description: "File token (for move/delete)" })),
  file_type: Type.Optional(
    Type.String({
      description:
        "File type: doc, docx, sheet, bitable, folder, file, mindnote, shortcut (for move/delete)",
    }),
  ),
});

// ── Registration ──

export function registerFeishuDriveTools(api: OpenClawPluginApi) {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const firstAccount: ResolvedFeishuAccount = accounts[0];
  const getClient = () => getFeishuClient(firstAccount);

  api.registerTool(
    {
      name: "feishu_drive",
      label: "Feishu Drive",
      description: "Feishu cloud storage operations. Actions: list, create_folder, move, delete",
      parameters: FeishuDriveSchema,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        try {
          const client = getClient();
          switch (params.action) {
            case "list":
              return json(await listFolder(client, params.folder_token));
            case "create_folder":
              return json(await createFolder(client, params.name, params.folder_token));
            case "move":
              return json(
                await moveFile(client, params.file_token, params.file_type, params.folder_token),
              );
            case "delete":
              return json(await deleteFile(client, params.file_token, params.file_type));
            default:
              return json({ error: `Unknown action: ${params.action}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_drive" },
  );
  api.logger.info?.("feishu: registered feishu_drive tool");
}
