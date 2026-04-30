/**
 * Feishu Drive (cloud storage) tool — list/create/move/delete plus online create and multipart upload.
 * Adapted from @m1heng-clawd/feishu with schema guardrails (no Type.Union).
 */

import { existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type * as Lark from "@larksuiteoapi/node-sdk";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/feishu";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import {
  getValidUserToken,
  handleFeishuTokenError,
  requireUserToken,
  resolveOAuthRedirectUri,
} from "../oauth.js";
import { getFeishuClient } from "../outbound.js";
import { getOAuthDirectSender } from "./oauth-direct.js";
import { callChatApi } from "./chat-api.js";
import { listDriveItemsByUser, type DriveBrowseItem } from "./drive-browse.js";
import { resolveDriveShareUrl, type DriveDocType } from "./share-url.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

const FEISHU_OPEN_API_BASE = "https://open.feishu.cn/open-apis";
const FEISHU_ALLOWED_HOSTNAMES = ["open.feishu.cn"];
const DRIVE_UPLOAD_PARENT_TYPE = "explorer";
const DRIVE_UPLOAD_CHUNK_MIN_BYTES = 1;
const HOME_DIR = homedir();

type FeishuEnvelope<TData> = {
  code?: number;
  msg?: string;
  data?: TData;
};

type TokenClient = {
  tokenManager?: {
    getTenantAccessToken: (params: Record<string, never>) => Promise<string | null | undefined>;
  };
};

type DriveUploadPrepareData = {
  upload_id?: string;
  block_size?: number;
  block_num?: number;
};

type DriveUploadFinishData = {
  file_token?: string;
};

type DriveFolderListItem = Required<Pick<DriveBrowseItem, "token" | "name">> &
  DriveBrowseItem & {
    type: "folder";
  };

type DriveFileListItem = Required<Pick<DriveBrowseItem, "token" | "name" | "type">> &
  DriveBrowseItem;

type DriveListResult = {
  scope: "root" | "folder";
  folder_count: number;
  file_count: number;
  folders: DriveFolderListItem[];
  files: DriveFileListItem[];
  next_page_token?: string;
  folder_token?: string;
};

const DRIVE_FILE_TYPES = new Set([
  "doc",
  "docx",
  "sheet",
  "bitable",
  "folder",
  "file",
  "mindnote",
  "shortcut",
]);

const DRIVE_ONLINE_TYPES = new Set(["docx", "sheet", "bitable"]);

function requireStringParam(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  return trimmed;
}

function requireFolderToken(value: unknown, action: string): string {
  const token = requireStringParam(value, "folder_token");
  if (token === "0" || token.toLowerCase() === "root") {
    throw new Error(
      `${action} requires a real folder token. For root listing, omit folder_token entirely. Root is not supported for write actions.`,
    );
  }
  return token;
}

function requireListFolderToken(value: unknown): string {
  const token = requireStringParam(value, "folder_token");
  if (token === "0" || token.toLowerCase() === "root") {
    throw new Error(
      "list_folder requires a real folder token. Root browsing must use action=list_root.",
    );
  }
  return token;
}

function rejectFolderTokenForRoot(value: unknown): void {
  if (value === undefined) return;
  throw new Error(
    "list_root does not accept folder_token. To browse a specific folder, use action=list_folder.",
  );
}

function requireFileType(value: unknown): string {
  const fileType = requireStringParam(value, "file_type");
  if (!DRIVE_FILE_TYPES.has(fileType)) {
    throw new Error(
      `file_type must be one of: doc, docx, sheet, bitable, folder, file, mindnote, shortcut`,
    );
  }
  return fileType;
}

function requireOnlineType(value: unknown): string {
  const onlineType = requireStringParam(value, "online_type");
  if (!DRIVE_ONLINE_TYPES.has(onlineType)) {
    throw new Error(`online_type must be one of: docx, sheet, bitable`);
  }
  return onlineType;
}

function resolveUploadFilePath(value: unknown): string {
  let filePath = requireStringParam(value, "file_path");
  if (filePath.startsWith("~/")) {
    filePath = join(HOME_DIR, filePath.slice(2));
  }
  if (!isAbsolute(filePath)) {
    throw new Error(`file_path must be an absolute path`);
  }
  if (!existsSync(filePath)) {
    throw new Error(`file_path not found: ${filePath}`);
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`file_path is not a file: ${filePath}`);
  }
  if (stat.size <= 0) {
    throw new Error(`file_path is empty: ${filePath}`);
  }
  return filePath;
}

function resolveUploadFileName(filePath: string, value: unknown): string {
  const candidate =
    value === undefined ? basename(filePath) : requireStringParam(value, "file_name");
  if (candidate.length > 250) {
    throw new Error(`file_name exceeds 250 characters`);
  }
  return candidate;
}

function buildOpenApiUrl(endpoint: string): string {
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${FEISHU_OPEN_API_BASE}${path}`;
}

function parseFeishuEnvelope<TData>(raw: string): FeishuEnvelope<TData> | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  return parsed as FeishuEnvelope<TData>;
}

function toPositiveInt(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (parsed > 0) {
      return parsed;
    }
  }
  throw new Error(`${field} must be a positive integer`);
}

async function getTenantAccessToken(account: ResolvedFeishuAccount): Promise<string> {
  const client = getFeishuClient(account) as unknown as TokenClient;
  const token = await client.tokenManager?.getTenantAccessToken({});
  if (!token) {
    throw new Error(`failed_to_get_tenant_access_token`);
  }
  return token;
}

async function callDriveMultipartApi<TData>(
  account: ResolvedFeishuAccount,
  endpoint: string,
  formData: FormData,
): Promise<{ ok: boolean; code: number; msg: string; data: TData | null; http_status: number }> {
  try {
    const token = await getTenantAccessToken(account);
    const { response, release } = await fetchWithSsrFGuard({
      url: buildOpenApiUrl(endpoint),
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      },
      policy: { allowedHostnames: FEISHU_ALLOWED_HOSTNAMES },
      auditContext: `feishu-drive-multipart:${endpoint}`,
    });
    try {
      const raw = await response.text();
      const envelope = parseFeishuEnvelope<TData>(raw);
      if (!envelope) {
        return {
          ok: false,
          code: -1,
          msg: "non_json_response",
          data: null,
          http_status: response.status,
        };
      }
      const code = typeof envelope.code === "number" ? envelope.code : -1;
      const msg = typeof envelope.msg === "string" ? envelope.msg : "";
      return {
        ok: code === 0,
        code,
        msg,
        data: (envelope.data as TData | undefined) ?? null,
        http_status: response.status,
      };
    } finally {
      await release();
    }
  } catch (err) {
    return {
      ok: false,
      code: -1,
      msg: `request_failed:${err instanceof Error ? err.message : String(err)}`,
      data: null,
      http_status: 0,
    };
  }
}

// ── Actions ──

function isDriveFolderItem(item: DriveBrowseItem): item is DriveFolderListItem {
  return (
    item.type === "folder" &&
    typeof item.token === "string" &&
    item.token.trim().length > 0 &&
    typeof item.name === "string" &&
    item.name.trim().length > 0
  );
}

function isDriveFileItem(item: DriveBrowseItem): item is DriveFileListItem {
  return (
    item.type !== "folder" &&
    typeof item.type === "string" &&
    item.type.trim().length > 0 &&
    typeof item.token === "string" &&
    item.token.trim().length > 0 &&
    typeof item.name === "string" &&
    item.name.trim().length > 0
  );
}

function toDriveListResult(params: {
  scope: "root" | "folder";
  folderToken?: string;
  result: Awaited<ReturnType<typeof listDriveItemsByUser>>;
}): DriveListResult {
  const folders = params.result.files.filter(isDriveFolderItem);
  const files = params.result.files.filter(isDriveFileItem);
  return {
    scope: params.scope,
    ...(params.folderToken ? { folder_token: params.folderToken } : {}),
    folder_count: folders.length,
    file_count: files.length,
    folders,
    files,
    ...(params.result.next_page_token ? { next_page_token: params.result.next_page_token } : {}),
  };
}

async function createFolder(client: Lark.Client, name: string, folderToken: string) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.drive.file.createFolder({
    data: { name, folder_token: folderToken },
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

async function createOnlineFile(
  account: ResolvedFeishuAccount,
  folderToken: string,
  title: string,
  onlineType: string,
) {
  if (onlineType === "docx") {
    const client = getFeishuClient(account);
    // oxlint-disable-next-line typescript/no-explicit-any
    const res: any = await client.docx.document.create({
      data: { title, folder_token: folderToken },
    });
    if (res.code !== 0) {
      throw new Error(`create_online failed: code=${res.code} msg=${res.msg}`);
    }
    const documentId =
      typeof res.data?.document?.document_id === "string"
        ? res.data.document.document_id.trim()
        : "";
    if (!documentId) {
      throw new Error(`create_online failed: missing document_id`);
    }
    const shareResult = await resolveDriveShareUrl(account, documentId, "docx");
    if (!shareResult.ok) {
      throw new Error(
        `create_online(docx) share_url resolve failed: token=${documentId} error=${shareResult.error}`,
      );
    }
    return {
      token: documentId,
      url: shareResult.share_url,
      revision: res.data?.document?.revision_id,
      online_type: onlineType,
      title,
      folder_token: folderToken,
    };
  }

  const endpoint = `/drive/explorer/v2/file/${encodeURIComponent(folderToken)}`;
  const result = await callChatApi<{ token?: string; url?: string; revision?: number }>({
    account,
    method: "POST",
    endpoint,
    body: { title, type: onlineType },
  });
  if (!result.ok) {
    throw new Error(`create_online failed: code=${result.code} msg=${result.msg}`);
  }
  const createdToken = typeof result.data?.token === "string" ? result.data.token.trim() : "";
  if (!createdToken) {
    throw new Error(`create_online(${onlineType}) failed: missing token`);
  }
  const docType: DriveDocType = onlineType as DriveDocType;
  const shareResult = await resolveDriveShareUrl(account, createdToken, docType);
  if (!shareResult.ok) {
    throw new Error(
      `create_online(${onlineType}) share_url resolve failed: token=${createdToken} error=${shareResult.error}`,
    );
  }
  return {
    token: createdToken,
    url: shareResult.share_url,
    revision: result.data?.revision,
    online_type: onlineType,
    title,
    folder_token: folderToken,
  };
}

async function uploadFileByMultipart(
  account: ResolvedFeishuAccount,
  folderToken: string,
  filePath: string,
  fileName: string,
) {
  const fileStat = statSync(filePath);
  const fileSize = fileStat.size;
  const prepare = await callChatApi<DriveUploadPrepareData>({
    account,
    method: "POST",
    endpoint: "/drive/v1/files/upload_prepare",
    body: {
      file_name: fileName,
      parent_type: DRIVE_UPLOAD_PARENT_TYPE,
      parent_node: folderToken,
      size: fileSize,
    },
  });
  if (!prepare.ok) {
    throw new Error(`upload_prepare failed: code=${prepare.code} msg=${prepare.msg}`);
  }
  const uploadId = prepare.data?.upload_id?.trim();
  const blockSize = toPositiveInt(prepare.data?.block_size, "block_size");
  const blockNum = toPositiveInt(prepare.data?.block_num, "block_num");
  if (!uploadId) {
    throw new Error(`upload_prepare response missing upload_id`);
  }
  if (blockSize < DRIVE_UPLOAD_CHUNK_MIN_BYTES) {
    throw new Error(`upload_prepare response missing valid block_size`);
  }

  const fileHandle = await open(filePath, "r");
  let uploadedBytes = 0;
  try {
    for (let seq = 0; seq < blockNum; seq++) {
      const expectedSize = Math.min(blockSize, fileSize - uploadedBytes);
      if (expectedSize <= 0) {
        throw new Error(
          `upload_part size mismatch before seq=${seq}: uploaded=${uploadedBytes} total=${fileSize}`,
        );
      }
      const chunk = Buffer.alloc(expectedSize);
      const { bytesRead } = await fileHandle.read(chunk, 0, expectedSize, uploadedBytes);
      if (bytesRead !== expectedSize) {
        throw new Error(
          `upload_part read mismatch at seq=${seq}: expected=${expectedSize} actual=${bytesRead}`,
        );
      }
      uploadedBytes += bytesRead;

      const formData = new FormData();
      formData.append("upload_id", uploadId);
      formData.append("seq", String(seq));
      formData.append("size", String(bytesRead));
      formData.append("file", new Blob([chunk]), `${fileName}.part${seq}`);

      const part = await callDriveMultipartApi<Record<string, never>>(
        account,
        "/drive/v1/files/upload_part",
        formData,
      );
      if (!part.ok) {
        throw new Error(`upload_part failed at seq=${seq}: code=${part.code} msg=${part.msg}`);
      }
    }
  } finally {
    await fileHandle.close();
  }

  if (uploadedBytes !== fileSize) {
    throw new Error(`upload_part total size mismatch: uploaded=${uploadedBytes} total=${fileSize}`);
  }

  const finish = await callChatApi<DriveUploadFinishData>({
    account,
    method: "POST",
    endpoint: "/drive/v1/files/upload_finish",
    body: { upload_id: uploadId, block_num: blockNum },
  });
  if (!finish.ok) {
    throw new Error(`upload_finish failed: code=${finish.code} msg=${finish.msg}`);
  }
  const fileToken = finish.data?.file_token?.trim();
  if (!fileToken) {
    throw new Error(`upload_finish response missing file_token`);
  }

  const shareResult = await resolveDriveShareUrl(account, fileToken, "file");
  if (!shareResult.ok) {
    throw new Error(
      `upload_file completed but share_url resolve failed: file_token=${fileToken} error=${shareResult.error} code=${shareResult.code ?? "none"} msg=${shareResult.msg ?? ""}`,
    );
  }

  return {
    file_token: fileToken,
    file_name: fileName,
    folder_token: folderToken,
    file_size: fileSize,
    upload_id: uploadId,
    block_size: blockSize,
    block_num: blockNum,
    share_url: shareResult.share_url,
  };
}

// ── Schema ──

const DRIVE_ACTIONS = [
  "list_root",
  "list_folder",
  "create_folder",
  "create_online",
  "move",
  "delete",
  "upload_file",
] as const;

const FeishuDriveSchema = Type.Object({
  action: stringEnum(DRIVE_ACTIONS, { description: "Drive operation to perform" }),
  folder_token: Type.Optional(
    Type.String({
      description:
        "Folder token (required for list_folder/create_folder/create_online/move target/upload_file). Do not pass it to list_root.",
    }),
  ),
  name: Type.Optional(Type.String({ description: "Folder name (required for create_folder)" })),
  title: Type.Optional(
    Type.String({ description: "Online file title (required for create_online)" }),
  ),
  online_type: Type.Optional(
    Type.String({ description: "Online file type for create_online: docx, sheet, bitable" }),
  ),
  file_token: Type.Optional(Type.String({ description: "File token (required for move/delete)" })),
  file_type: Type.Optional(
    Type.String({
      description:
        "File type: doc, docx, sheet, bitable, folder, file, mindnote, shortcut (for move/delete)",
    }),
  ),
  file_path: Type.Optional(
    Type.String({
      description:
        "Absolute local file path to upload (required for upload_file, supports ~/ expansion)",
    }),
  ),
  file_name: Type.Optional(
    Type.String({
      description: "Optional uploaded file name override (required length <= 250)",
    }),
  ),
});

// ── Registration ──

export function registerFeishuDriveTools(api: OpenClawPluginApi) {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const firstAccount: ResolvedFeishuAccount = accounts[0];
  const getClient = () => getFeishuClient(firstAccount);
  const oauthRedirectUri = resolveOAuthRedirectUri(api.config as Record<string, unknown>);

  api.registerTool(
    {
      name: "feishu_drive",
      label: "Feishu Drive",
      description:
        "Feishu cloud storage operations using user-visible Drive contents. " +
        "Use list_root to browse the user's Drive root, and list_folder to open a specific folder token. " +
        "Write actions still require an explicit folder token.",
      parameters: FeishuDriveSchema,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        try {
          const client = getClient();
          switch (params.action) {
            case "list_root": {
              rejectFolderTokenForRoot(params.folder_token);
              const guard = await requireUserToken({
                account: firstAccount,
                redirectUri: oauthRedirectUri,
                tokenPromise: getValidUserToken(firstAccount),
                toolLabel: "飞书云盘读取",
                sendDirectToUser: getOAuthDirectSender(firstAccount),
              });
              if (!guard.ok) return guard.authResponse;
              return json(
                toDriveListResult({
                  scope: "root",
                  result: await listDriveItemsByUser(guard.token.access_token),
                }),
              );
            }
            case "list_folder": {
              const folderToken = requireListFolderToken(params.folder_token);
              const guard = await requireUserToken({
                account: firstAccount,
                redirectUri: oauthRedirectUri,
                tokenPromise: getValidUserToken(firstAccount),
                toolLabel: "飞书云盘读取",
                sendDirectToUser: getOAuthDirectSender(firstAccount),
              });
              if (!guard.ok) return guard.authResponse;
              return json(
                toDriveListResult({
                  scope: "folder",
                  folderToken,
                  result: await listDriveItemsByUser(guard.token.access_token, folderToken),
                }),
              );
            }
            case "create_folder": {
              const name = requireStringParam(params.name, "name");
              const folderToken = requireFolderToken(params.folder_token, "create_folder");
              return json(await createFolder(client, name, folderToken));
            }
            case "create_online": {
              const title = requireStringParam(params.title, "title");
              const onlineType = requireOnlineType(params.online_type);
              const folderToken = requireFolderToken(params.folder_token, "create_online");
              return json(await createOnlineFile(firstAccount, folderToken, title, onlineType));
            }
            case "move": {
              const fileToken = requireStringParam(params.file_token, "file_token");
              const fileType = requireFileType(params.file_type);
              const folderToken = requireFolderToken(params.folder_token, "move");
              return json(await moveFile(client, fileToken, fileType, folderToken));
            }
            case "delete": {
              const fileToken = requireStringParam(params.file_token, "file_token");
              const fileType = requireFileType(params.file_type);
              return json(await deleteFile(client, fileToken, fileType));
            }
            case "upload_file": {
              const folderToken = requireFolderToken(params.folder_token, "upload_file");
              const filePath = resolveUploadFilePath(params.file_path);
              const fileName = resolveUploadFileName(filePath, params.file_name);
              return json(
                await uploadFileByMultipart(firstAccount, folderToken, filePath, fileName),
              );
            }
            default:
              return json({ error: `Unknown action: ${params.action}` });
          }
        } catch (err) {
          const authResp = await handleFeishuTokenError(err, firstAccount, oauthRedirectUri, getOAuthDirectSender(firstAccount));
          if (authResp) return authResp;
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_drive" },
  );
  api.logger.info?.("feishu: registered feishu_drive tool");
}
