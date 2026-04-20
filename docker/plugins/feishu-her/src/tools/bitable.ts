/**
 * Feishu Bitable (multi-dimensional spreadsheet) tools — metadata, fields, records CRUD.
 * Adapted from @m1heng-clawd/feishu with schema guardrails (no Type.Union).
 */

import type * as Lark from "@larksuiteoapi/node-sdk";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
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
  method: "GET" | "POST" | "PATCH" | "DELETE";
  endpoint: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}): Promise<UserBitableApiResult<TData>> {
  const result = await callFeishuApiWithUserToken<TData>({
    method: params.method,
    endpoint: params.endpoint,
    userToken: params.userToken,
    query: params.query,
    body: params.body,
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
      ...(f.property ? { property: f.property } : {}),
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
      ...(f.property ? { property: f.property } : {}),
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

/** Normalize rich text arrays to plain strings (search API returns [{text:"...",type:"text"}] for Text fields). */
// oxlint-disable-next-line typescript/no-explicit-any
function normalizeRichText(value: any): any {
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    typeof value[0]?.text === "string" &&
    value[0]?.type === "text"
  ) {
    return value.map((s: { text: string }) => s.text).join("");
  }
  return value;
}

/** Coerce Number fields from string back to number (REST API returns strings for Number type). */
function coerceRecordFields(
  // oxlint-disable-next-line typescript/no-explicit-any
  record: any,
  numberFieldNames: Set<string>,
  // oxlint-disable-next-line typescript/no-explicit-any
): any {
  if (!record?.fields) return record;
  const fields = { ...record.fields };
  for (const key of Object.keys(fields)) {
    // Normalize rich text arrays to plain strings
    fields[key] = normalizeRichText(fields[key]);
    // Coerce Number fields from string to number
    if (numberFieldNames.has(key) && typeof fields[key] === "string" && fields[key] !== "") {
      const n = Number(fields[key]);
      if (Number.isFinite(n)) fields[key] = n;
    }
  }
  return { ...record, fields };
}

/** Get the set of Number field names for a table (for type coercion). */
async function getNumberFieldNames(
  userToken: string,
  appToken: string,
  tableId: string,
): Promise<Set<string>> {
  try {
    const fields = await listFieldsByUser(userToken, appToken, tableId);
    return new Set(
      fields.fields
        .filter((f: { type?: number }) => f.type === 2)
        .map((f: { field_name?: string }) => f.field_name!)
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

async function listRecordsByUser(
  userToken: string,
  appToken: string,
  tableId: string,
  pageSize?: number,
  pageToken?: string,
) {
  const [res, numberFields] = await Promise.all([
    callBitableUserApi<BitableRecordListResponse>({
      userToken,
      method: "GET",
      endpoint: `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
      query: {
        page_size: String(pageSize ?? 100),
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    }),
    getNumberFieldNames(userToken, appToken, tableId),
  ]);
  if (!res.ok) throw new Error(res.msg);
  const records = (res.data?.items ?? []).map((r) => coerceRecordFields(r, numberFields));
  return {
    records,
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
  const [res, numberFields] = await Promise.all([
    callBitableUserApi<BitableRecordGetResponse>({
      userToken,
      method: "GET",
      endpoint: `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
    }),
    getNumberFieldNames(userToken, appToken, tableId),
  ]);
  if (!res.ok) throw new Error(res.msg);
  return { record: coerceRecordFields(res.data?.record, numberFields) };
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

// Default field types created for new Bitable tables (to be cleaned up)
const DEFAULT_CLEANUP_FIELD_TYPES = new Set([3, 5, 17]); // SingleSelect, DateTime, Attachment

/** Clean up default placeholder rows and fields in a newly created Bitable table */
async function cleanupNewBitable(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  tableName: string,
): Promise<{ cleanedRows: number; cleanedFields: number }> {
  let cleanedRows = 0;
  let cleanedFields = 0;

  // Rename primary field to table name + delete default placeholder fields
  // oxlint-disable-next-line typescript/no-explicit-any
  const fieldsRes: any = await client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
  });
  if (fieldsRes.code === 0 && fieldsRes.data?.items) {
    // oxlint-disable-next-line typescript/no-explicit-any
    const primaryField = fieldsRes.data.items.find((f: any) => f.is_primary);
    if (primaryField?.field_id) {
      try {
        await client.bitable.appTableField.update({
          path: { app_token: appToken, table_id: tableId, field_id: primaryField.field_id },
          data: { field_name: tableName.length <= 20 ? tableName : "Name", type: 1 },
        });
        cleanedFields++;
      } catch {
        /* non-critical */
      }
    }
    // oxlint-disable-next-line typescript/no-explicit-any
    for (const field of fieldsRes.data.items.filter(
      (f: any) => !f.is_primary && DEFAULT_CLEANUP_FIELD_TYPES.has(f.type ?? 0),
    )) {
      if (field.field_id) {
        try {
          await client.bitable.appTableField.delete({
            path: { app_token: appToken, table_id: tableId, field_id: field.field_id },
          });
          cleanedFields++;
        } catch {
          /* non-critical */
        }
      }
    }
  }

  // Delete empty placeholder rows
  // oxlint-disable-next-line typescript/no-explicit-any
  const recordsRes: any = await client.bitable.appTableRecord.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 100 },
  });
  if (recordsRes.code === 0 && recordsRes.data?.items) {
    // Feishu placeholder rows have fields like { "多行文本": null } — all values null/empty
    // oxlint-disable-next-line typescript/no-explicit-any
    const emptyIds = recordsRes.data.items
      .filter((r: any) => {
        if (!r.fields) return true;
        const keys = Object.keys(r.fields);
        if (keys.length === 0) return true;
        return keys.every((k: string) => r.fields[k] == null || r.fields[k] === "");
      })
      .map((r: any) => r.record_id)
      .filter(Boolean);
    if (emptyIds.length > 0) {
      try {
        await client.bitable.appTableRecord.batchDelete({
          path: { app_token: appToken, table_id: tableId },
          data: { records: emptyIds },
        });
        cleanedRows = emptyIds.length;
      } catch {
        // Fallback: delete one by one
        for (const id of emptyIds) {
          try {
            // oxlint-disable-next-line typescript/no-explicit-any
            await (client.bitable.appTableRecord as any).delete({
              path: { app_token: appToken, table_id: tableId, record_id: id },
            });
            cleanedRows++;
          } catch {
            /* skip */
          }
        }
      }
    }
  }

  return { cleanedRows, cleanedFields };
}

async function createApp(client: Lark.Client, name: string, folderToken?: string) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.bitable.app.create({
    data: { name, ...(folderToken && { folder_token: folderToken }) },
  });
  if (res.code !== 0) throw new Error(res.msg);
  const appToken = res.data?.app?.app_token;
  if (!appToken) throw new Error("Failed to create Bitable: no app_token returned");

  let tableId: string | undefined;
  let cleanedRows = 0;
  let cleanedFields = 0;
  try {
    // oxlint-disable-next-line typescript/no-explicit-any
    const tablesRes: any = await client.bitable.appTable.list({ path: { app_token: appToken } });
    if (tablesRes.code === 0 && tablesRes.data?.items?.length > 0) {
      tableId = tablesRes.data.items[0].table_id;
      if (tableId) {
        const cleanup = await cleanupNewBitable(client, appToken, tableId, name);
        cleanedRows = cleanup.cleanedRows;
        cleanedFields = cleanup.cleanedFields;
      }
    }
  } catch {
    /* cleanup is non-critical */
  }

  return {
    app_token: appToken,
    table_id: tableId,
    name: res.data?.app?.name,
    url: res.data?.app?.url,
    cleaned_placeholder_rows: cleanedRows,
    cleaned_default_fields: cleanedFields,
    hint: tableId
      ? `Table created. Use app_token="${appToken}" and table_id="${tableId}" for other bitable actions.`
      : "Table created. Use get_meta to get table_id and field details.",
  };
}

async function createField(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  fieldName: string,
  fieldType: number,
  property?: Record<string, unknown>,
) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.bitable.appTableField.create({
    path: { app_token: appToken, table_id: tableId },
    data: { field_name: fieldName, type: fieldType, ...(property && { property }) },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    field_id: res.data?.field?.field_id,
    field_name: res.data?.field?.field_name,
    type: res.data?.field?.type,
    type_name: FIELD_TYPE_NAMES[res.data?.field?.type ?? 0] || `type_${res.data?.field?.type}`,
  };
}

async function deleteRecords(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  recordIds: string[],
) {
  if (recordIds.length === 0) throw new Error("No record IDs provided");
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.bitable.appTableRecord.batchDelete({
    path: { app_token: appToken, table_id: tableId },
    data: { records: recordIds },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { deleted: recordIds.length };
}

async function searchRecordsByUser(
  userToken: string,
  appToken: string,
  tableId: string,
  // oxlint-disable-next-line typescript/no-explicit-any
  opts: { filter?: any; sort?: string[]; pageSize?: number; pageToken?: string },
) {
  const numberFields = await getNumberFieldNames(userToken, appToken, tableId);
  // oxlint-disable-next-line typescript/no-explicit-any
  const body: Record<string, any> = {};
  // Filter: accept structured JSON object (Feishu native format)
  // e.g. { conjunction: "and", conditions: [{ field_name: "Status", operator: "is", value: ["Done"] }] }
  if (opts.filter)
    body.filter = typeof opts.filter === "string" ? JSON.parse(opts.filter) : opts.filter;
  if (opts.sort?.length) {
    body.sort = opts.sort.map((s) => {
      const [field, order] = s.split(":");
      return { field_name: field, desc: order === "desc" };
    });
  }
  // page_size and page_token go as query params, not body (Feishu search API requirement)
  const query: Record<string, string> = {};
  if (opts.pageSize) query.page_size = String(Math.min(opts.pageSize, 500));
  if (opts.pageToken) query.page_token = opts.pageToken;
  const res = await callBitableUserApi<BitableRecordListResponse>({
    userToken,
    method: "POST",
    endpoint: `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/search`,
    body,
    query: Object.keys(query).length > 0 ? query : undefined,
  });
  if (!res.ok) throw new Error(res.msg);
  const records = (res.data?.items ?? []).map((r) => coerceRecordFields(r, numberFields));
  return {
    records,
    has_more: res.data?.has_more ?? false,
    page_token: res.data?.page_token,
    total: res.data?.total,
  };
}

async function batchCreateRecords(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  records: Array<{ fields: Record<string, unknown> }>,
) {
  if (records.length === 0) throw new Error("No records provided");
  if (records.length > 500) throw new Error("Max 500 records per batch");
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.bitable.appTableRecord.batchCreate({
    path: { app_token: appToken, table_id: tableId },
    // oxlint-disable-next-line typescript/no-explicit-any
    data: { records: records as any },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { records: res.data?.records ?? [], total: res.data?.records?.length ?? 0 };
}

async function batchUpdateRecords(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  records: Array<{ record_id: string; fields: Record<string, unknown> }>,
) {
  if (records.length === 0) throw new Error("No records provided");
  if (records.length > 500) throw new Error("Max 500 records per batch");
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.bitable.appTableRecord.batchUpdate({
    path: { app_token: appToken, table_id: tableId },
    // oxlint-disable-next-line typescript/no-explicit-any
    data: { records: records as any },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { records: res.data?.records ?? [], total: res.data?.records?.length ?? 0 };
}

async function updateField(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  fieldId: string,
  fieldName?: string,
  fieldType?: number,
  property?: Record<string, unknown>,
) {
  // Auto-fill type and property from current field to avoid clearing options (Bug #7/#8)
  // oxlint-disable-next-line typescript/no-explicit-any
  const currentRes: any = await client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
  });
  // oxlint-disable-next-line typescript/no-explicit-any
  const currentField =
    currentRes.code === 0 ? currentRes.data?.items?.find((f: any) => f.field_id === fieldId) : null;
  // oxlint-disable-next-line typescript/no-explicit-any
  const data: Record<string, any> = {};
  data.field_name = fieldName ?? currentField?.field_name;
  data.type = fieldType ?? currentField?.type;
  // Preserve existing property (e.g. select options) if not explicitly overridden
  data.property = property ?? currentField?.property;
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.bitable.appTableField.update({
    path: { app_token: appToken, table_id: tableId, field_id: fieldId },
    data,
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    field_id: res.data?.field?.field_id,
    field_name: res.data?.field?.field_name,
    type: res.data?.field?.type,
    type_name: FIELD_TYPE_NAMES[res.data?.field?.type ?? 0] || `type_${res.data?.field?.type}`,
  };
}

async function deleteField(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  fieldId: string,
) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.bitable.appTableField.delete({
    path: { app_token: appToken, table_id: tableId, field_id: fieldId },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { deleted: true, field_id: fieldId };
}

// ── Schemas ──

const BITABLE_ACTIONS = [
  "get_meta",
  "list_fields",
  "list_records",
  "search_records",
  "get_record",
  "create_record",
  "batch_create_records",
  "update_record",
  "batch_update_records",
  "delete_records",
  "create_app",
  "create_field",
  "update_field",
  "delete_field",
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
  record_ids: Type.Optional(
    Type.Array(Type.String(), { description: "Record IDs for delete_records" }),
  ),
  records: Type.Optional(
    Type.Array(Type.Any(), {
      description:
        "Array of {fields:{...}} for batch_create or {record_id,fields:{...}} for batch_update (max 500)",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description: "Name for create_app, or field_name for create_field/update_field",
    }),
  ),
  folder_token: Type.Optional(
    Type.String({ description: "Folder token to create app in (optional)" }),
  ),
  field_id: Type.Optional(Type.String({ description: "Field ID for update_field/delete_field" })),
  field_type: Type.Optional(
    Type.Number({
      description:
        "Field type: 1=Text, 2=Number, 3=SingleSelect, 4=MultiSelect, 5=DateTime, 7=Checkbox, 11=User, 13=Phone, 15=URL, 17=Attachment, 22=Location, 1005=AutoNumber",
    }),
  ),
  field_property: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: "Field property config (e.g. select options)",
    }),
  ),
  filter: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        'Filter for search_records. Feishu structured format: { conjunction: "and", conditions: [{ field_name: "Status", operator: "is", value: ["Done"] }] }. Operators: is, isNot, contains, doesNotContain, isEmpty, isNotEmpty, isGreater, isLess, etc.',
    }),
  ),
  sort: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Sort for search_records. Array of "field_name:asc" or "field_name:desc"',
    }),
  ),
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
        "Feishu multi-dimensional table (bitable) full CRUD. Actions: get_meta, list_fields, list_records, search_records, get_record, create_record, batch_create_records, update_record, batch_update_records, delete_records, create_app, create_field, update_field, delete_field",
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
            case "search_records": {
              const guard = await requireReadAccess();
              if (!guard.ok) return guard.authResponse;
              return json(
                await searchRecordsByUser(
                  guard.token.access_token,
                  params.app_token,
                  params.table_id,
                  {
                    filter: params.filter,
                    sort: params.sort,
                    pageSize: params.page_size,
                    pageToken: params.page_token,
                  },
                ),
              );
            }
            case "batch_create_records":
              return json(
                await batchCreateRecords(client, params.app_token, params.table_id, params.records),
              );
            case "batch_update_records":
              return json(
                await batchUpdateRecords(client, params.app_token, params.table_id, params.records),
              );
            case "delete_records":
              return json(
                await deleteRecords(client, params.app_token, params.table_id, params.record_ids),
              );
            case "create_app":
              return json(await createApp(client, params.name, params.folder_token));
            case "create_field":
              return json(
                await createField(
                  client,
                  params.app_token,
                  params.table_id,
                  params.name,
                  params.field_type,
                  params.field_property,
                ),
              );
            case "update_field":
              return json(
                await updateField(
                  client,
                  params.app_token,
                  params.table_id,
                  params.field_id,
                  params.name,
                  params.field_type,
                  params.field_property,
                ),
              );
            case "delete_field":
              return json(
                await deleteField(client, params.app_token, params.table_id, params.field_id),
              );
            default:
              return json({ error: `Unknown action: ${params.action}` });
          }
        } catch (err) {
          const authResp = await handleFeishuTokenError(err, firstAccount, oauthRedirectUri);
          if (authResp) return authResp;
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_bitable" },
  );
  api.logger.info?.("feishu: registered feishu_bitable tool");
}
