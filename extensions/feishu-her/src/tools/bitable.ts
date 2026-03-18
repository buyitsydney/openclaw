/**
 * Feishu Bitable (multi-dimensional spreadsheet) tools — metadata, fields, records CRUD.
 * Adapted from @m1heng-clawd/feishu with schema guardrails (no Type.Union).
 */

import type * as Lark from "@larksuiteoapi/node-sdk";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import {
  callFeishuApiWithUserToken,
  getValidUserToken,
  handleFeishuTokenError,
  requireUserToken,
  resolveOAuthRedirectUri,
} from "../oauth.js";
import { getFeishuClient } from "../outbound.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

const FIELD_TYPE_NAMES: Record<number, string> = {
  1: "Text",
  2: "Number",
  3: "SingleSelect",
  4: "MultiSelect",
  5: "DateTime",
  7: "Checkbox",
  11: "User",
  13: "Phone",
  15: "URL",
  17: "Attachment",
  18: "SingleLink",
  19: "Lookup",
  20: "Formula",
  21: "DuplexLink",
  22: "Location",
  23: "GroupChat",
  1001: "CreatedTime",
  1002: "ModifiedTime",
  1003: "CreatedUser",
  1004: "ModifiedUser",
  1005: "AutoNumber",
};

type BitableAppResponse = {
  app?: {
    name?: string;
  };
};

type BitableTableListResponse = {
  items?: Array<{
    table_id?: string;
    name?: string;
  }>;
};

type BitableFieldListResponse = {
  items?: Array<{
    field_id?: string;
    field_name?: string;
    type?: number;
    is_primary?: boolean;
    property?: unknown;
  }>;
};

type BitableRecordListResponse = {
  items?: unknown[];
  has_more?: boolean;
  page_token?: string;
  total?: number;
};

type BitableRecordGetResponse = {
  record?: unknown;
};

type WikiNodeResolveResponse = {
  node?: {
    obj_type?: string;
    obj_token?: string;
  };
};

type UserBitableApiResult<TData> = {
  ok: boolean;
  code: number;
  msg: string;
  data: TData | null;
  http_status: number;
  method: string;
  endpoint: string;
};

async function callBitableUserApi<TData>(params: {
  userToken: string;
  method: "GET";
  endpoint: string;
  query?: Record<string, string>;
}): Promise<UserBitableApiResult<TData>> {
  const result = await callFeishuApiWithUserToken<TData>({
    method: params.method,
    endpoint: params.endpoint,
    userToken: params.userToken,
    query: params.query,
  });
  return {
    ok: result.code === 0,
    code: result.code,
    msg: result.msg,
    data: result.data,
    http_status: 200,
    method: params.method,
    endpoint: params.endpoint,
  };
}

// ── Core functions ──

function parseBitableUrl(url: string): { token: string; tableId?: string; isWiki: boolean } | null {
  try {
    const u = new URL(url);
    const tableId = u.searchParams.get("table") ?? undefined;
    const wikiMatch = u.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
    if (wikiMatch) return { token: wikiMatch[1], tableId, isWiki: true };
    const baseMatch = u.pathname.match(/\/base\/([A-Za-z0-9]+)/);
    if (baseMatch) return { token: baseMatch[1], tableId, isWiki: false };
    return null;
  } catch {
    return null;
  }
}

async function resolveAppToken(
  client: Lark.Client,
  parsed: { token: string; isWiki: boolean },
): Promise<string> {
  if (!parsed.isWiki) return parsed.token;
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.wiki.space.getNode({ params: { token: parsed.token } });
  if (res.code !== 0) throw new Error(res.msg);
  if (res.data?.node?.obj_type !== "bitable")
    throw new Error(`Node is not a bitable (type: ${res.data?.node?.obj_type})`);
  return res.data.node.obj_token!;
}

async function resolveAppTokenByUser(
  userToken: string,
  parsed: { token: string; isWiki: boolean },
): Promise<string> {
  if (!parsed.isWiki) return parsed.token;
  const res = await callBitableUserApi<WikiNodeResolveResponse>({
    userToken,
    method: "GET",
    endpoint: "/wiki/v2/spaces/get_node",
    query: { token: parsed.token },
  });
  if (!res.ok) throw new Error(res.msg);
  if (res.data?.node?.obj_type !== "bitable") {
    throw new Error(`Node is not a bitable (type: ${res.data?.node?.obj_type})`);
  }
  const objToken = res.data?.node?.obj_token?.trim();
  if (!objToken) throw new Error("bitable obj_token missing");
  return objToken;
}

async function getBitableMeta(client: Lark.Client, url: string) {
  const parsed = parseBitableUrl(url);
  if (!parsed) throw new Error("Invalid URL format. Expected /base/XXX or /wiki/XXX URL");
  const appToken = await resolveAppToken(client, parsed);
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.bitable.app.get({ path: { app_token: appToken } });
  if (res.code !== 0) throw new Error(res.msg);
  let tables: { table_id: string; name: string }[] = [];
  if (!parsed.tableId) {
    // oxlint-disable-next-line typescript/no-explicit-any
    const tablesRes: any = await client.bitable.appTable.list({ path: { app_token: appToken } });
    if (tablesRes.code === 0) {
      // oxlint-disable-next-line typescript/no-explicit-any
      tables = (tablesRes.data?.items ?? []).map((t: any) => ({
        table_id: t.table_id!,
        name: t.name!,
      }));
    }
  }
  return {
    app_token: appToken,
    table_id: parsed.tableId,
    name: res.data?.app?.name,
    url_type: parsed.isWiki ? "wiki" : "base",
    ...(tables.length > 0 && { tables }),
    hint: parsed.tableId
      ? `Use app_token="${appToken}" and table_id="${parsed.tableId}" for other bitable actions`
      : `Use app_token="${appToken}" for other bitable actions. Select a table_id from the tables list.`,
  };
}

async function getBitableMetaByUser(userToken: string, url: string) {
  const parsed = parseBitableUrl(url);
  if (!parsed) throw new Error("Invalid URL format. Expected /base/XXX or /wiki/XXX URL");
  const appToken = await resolveAppTokenByUser(userToken, parsed);
  const res = await callBitableUserApi<BitableAppResponse>({
    userToken,
    method: "GET",
    endpoint: `/bitable/v1/apps/${encodeURIComponent(appToken)}`,
  });
  if (!res.ok) throw new Error(res.msg);
  let tables: { table_id: string; name: string }[] = [];
  if (!parsed.tableId) {
    const tablesRes = await callBitableUserApi<BitableTableListResponse>({
      userToken,
      method: "GET",
      endpoint: `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`,
    });
    if (tablesRes.ok) {
      tables = (tablesRes.data?.items ?? [])
        .filter((t) => typeof t.table_id === "string" && typeof t.name === "string")
        .map((t) => ({
          table_id: t.table_id!,
          name: t.name!,
        }));
    }
  }
  return {
    app_token: appToken,
    table_id: parsed.tableId,
    name: res.data?.app?.name,
    url_type: parsed.isWiki ? "wiki" : "base",
    ...(tables.length > 0 && { tables }),
    hint: parsed.tableId
      ? `Use app_token="${appToken}" and table_id="${parsed.tableId}" for other bitable actions`
      : `Use app_token="${appToken}" for other bitable actions. Select a table_id from the tables list.`,
  };
}

async function listFields(client: Lark.Client, appToken: string, tableId: string) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
  });
  if (res.code !== 0) throw new Error(res.msg);
  // oxlint-disable-next-line typescript/no-explicit-any
  return {
    fields: (res.data?.items ?? []).map((f: any) => ({
      field_id: f.field_id,
      field_name: f.field_name,
      type: f.type,
      type_name: FIELD_TYPE_NAMES[f.type ?? 0] || `type_${f.type}`,
      is_primary: f.is_primary,
      ...(f.property && { property: f.property }),
    })),
    total: (res.data?.items ?? []).length,
  };
}

async function listFieldsByUser(userToken: string, appToken: string, tableId: string) {
  const res = await callBitableUserApi<BitableFieldListResponse>({
    userToken,
    method: "GET",
    endpoint: `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
  });
  if (!res.ok) throw new Error(res.msg);
  return {
    fields: (res.data?.items ?? []).map((f) => ({
      field_id: f.field_id,
      field_name: f.field_name,
      type: f.type,
      type_name: FIELD_TYPE_NAMES[f.type ?? 0] || `type_${f.type}`,
      is_primary: f.is_primary,
      ...(f.property && { property: f.property }),
    })),
    total: (res.data?.items ?? []).length,
  };
}

async function listRecords(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  pageSize?: number,
  pageToken?: string,
) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.bitable.appTableRecord.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: pageSize ?? 100, ...(pageToken && { page_token: pageToken }) },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    records: res.data?.items ?? [],
    has_more: res.data?.has_more ?? false,
    page_token: res.data?.page_token,
    total: res.data?.total,
  };
}

async function listRecordsByUser(
  userToken: string,
  appToken: string,
  tableId: string,
  pageSize?: number,
  pageToken?: string,
) {
  const res = await callBitableUserApi<BitableRecordListResponse>({
    userToken,
    method: "GET",
    endpoint: `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
    query: {
      page_size: String(pageSize ?? 100),
      ...(pageToken ? { page_token: pageToken } : {}),
    },
  });
  if (!res.ok) throw new Error(res.msg);
  return {
    records: res.data?.items ?? [],
    has_more: res.data?.has_more ?? false,
    page_token: res.data?.page_token,
    total: res.data?.total,
  };
}

async function getRecord(client: Lark.Client, appToken: string, tableId: string, recordId: string) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.bitable.appTableRecord.get({
    path: { app_token: appToken, table_id: tableId, record_id: recordId },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { record: res.data?.record };
}

async function getRecordByUser(
  userToken: string,
  appToken: string,
  tableId: string,
  recordId: string,
) {
  const res = await callBitableUserApi<BitableRecordGetResponse>({
    userToken,
    method: "GET",
    endpoint: `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
  });
  if (!res.ok) throw new Error(res.msg);
  return { record: res.data?.record };
}

async function createRecord(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  fields: Record<string, unknown>,
) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.bitable.appTableRecord.create({
    path: { app_token: appToken, table_id: tableId },
    // oxlint-disable-next-line typescript/no-explicit-any
    data: { fields: fields as any },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { record: res.data?.record };
}

async function updateRecord(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  recordId: string,
  fields: Record<string, unknown>,
) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.bitable.appTableRecord.update({
    path: { app_token: appToken, table_id: tableId, record_id: recordId },
    // oxlint-disable-next-line typescript/no-explicit-any
    data: { fields: fields as any },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { record: res.data?.record };
}

// ── Schemas ──

const BITABLE_ACTIONS = [
  "get_meta",
  "list_fields",
  "list_records",
  "get_record",
  "create_record",
  "update_record",
] as const;

const FeishuBitableSchema = Type.Object({
  action: stringEnum(BITABLE_ACTIONS, { description: "Bitable operation to perform" }),
  url: Type.Optional(
    Type.String({ description: "Bitable URL /base/XXX or /wiki/XXX (for get_meta)" }),
  ),
  app_token: Type.Optional(
    Type.String({ description: "Bitable app token (use get_meta to get from URL)" }),
  ),
  table_id: Type.Optional(Type.String({ description: "Table ID (from URL: ?table=YYY)" })),
  record_id: Type.Optional(
    Type.String({ description: "Record ID (for get_record/update_record)" }),
  ),
  fields: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        "Field values keyed by field name. Text='string', Number=123, SingleSelect='Option', MultiSelect=['A','B'], DateTime=timestamp_ms",
    }),
  ),
  page_size: Type.Optional(Type.Number({ description: "Records per page 1-500 (default 100)" })),
  page_token: Type.Optional(Type.String({ description: "Pagination token" })),
});

// ── Registration ──

export function registerFeishuBitableTools(api: OpenClawPluginApi) {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const firstAccount: ResolvedFeishuAccount = accounts[0];
  const getClient = () => getFeishuClient(firstAccount);
  const oauthRedirectUri = resolveOAuthRedirectUri(api.config as Record<string, unknown>);

  api.registerTool(
    {
      name: "feishu_bitable",
      label: "Feishu Bitable",
      description:
        "Feishu multi-dimensional table operations. Actions: get_meta, list_fields, list_records, get_record, create_record, update_record",
      parameters: FeishuBitableSchema,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        try {
          const client = getClient();
          const requireReadAccess = () =>
            requireUserToken({
              account: firstAccount,
              redirectUri: oauthRedirectUri,
              tokenPromise: getValidUserToken(firstAccount),
              toolLabel: "飞书多维表格读取",
            });
          switch (params.action) {
            case "get_meta": {
              const guard = await requireReadAccess();
              if (!guard.ok) return guard.authResponse;
              return json(await getBitableMetaByUser(guard.token.access_token, params.url));
            }
            case "list_fields": {
              const guard = await requireReadAccess();
              if (!guard.ok) return guard.authResponse;
              return json(
                await listFieldsByUser(guard.token.access_token, params.app_token, params.table_id),
              );
            }
            case "list_records": {
              const guard = await requireReadAccess();
              if (!guard.ok) return guard.authResponse;
              return json(
                await listRecordsByUser(
                  guard.token.access_token,
                  params.app_token,
                  params.table_id,
                  params.page_size,
                  params.page_token,
                ),
              );
            }
            case "get_record": {
              const guard = await requireReadAccess();
              if (!guard.ok) return guard.authResponse;
              return json(
                await getRecordByUser(
                  guard.token.access_token,
                  params.app_token,
                  params.table_id,
                  params.record_id,
                ),
              );
            }
            case "create_record":
              return json(
                await createRecord(client, params.app_token, params.table_id, params.fields),
              );
            case "update_record":
              return json(
                await updateRecord(
                  client,
                  params.app_token,
                  params.table_id,
                  params.record_id,
                  params.fields,
                ),
              );
            default:
              return json({ error: `Unknown action: ${params.action}` });
          }
        } catch (err) {
          handleFeishuTokenError(err);
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_bitable" },
  );
  api.logger.info?.("feishu: registered feishu_bitable tool");
}
