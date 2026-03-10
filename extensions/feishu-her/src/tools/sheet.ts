import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import {
  callFeishuApiWithUserToken,
  getValidUserToken,
  requireUserToken,
  resolveOAuthRedirectUri,
} from "../oauth.js";
import { callChatApi, makeLocalErrorResult, makeToolResult } from "./chat-api.js";
import { resolveDriveShareUrl } from "./share-url.js";

const SHEET_ACTIONS = [
  "get_share_url",
  "get_meta",
  "read_range",
  "read_ranges",
  "write_range",
  "write_ranges",
  "append",
] as const;
const VALUE_RENDER_OPTIONS = ["ToString", "FormattedValue", "Formula", "UnformattedValue"] as const;
const DATE_TIME_RENDER_OPTIONS = ["FormattedString"] as const;
const USER_ID_TYPES = ["open_id", "union_id"] as const;
const INSERT_DATA_OPTIONS = ["OVERWRITE", "INSERT_ROWS"] as const;

const RangeValuesSchema = Type.Object({
  range: Type.String({
    description: "Range in Feishu format: sheetId!A1:B5",
  }),
  values: Type.Array(Type.Array(Type.Any()), {
    description: "2D matrix of cell values.",
  }),
});

const FeishuSheetSchema = Type.Object({
  action: stringEnum(SHEET_ACTIONS, {
    description:
      "Sheet action: get_share_url, get_meta, read_range, read_ranges, write_range, write_ranges, append",
  }),
  spreadsheet_token: Type.Optional(
    Type.String({
      description: "Spreadsheet token (sht...). Required unless url is provided.",
    }),
  ),
  url: Type.Optional(
    Type.String({
      description:
        "Feishu sheet URL (https://.../sheets/{spreadsheetToken}?sheet={sheetId}). Can be used instead of spreadsheet_token.",
    }),
  ),
  range: Type.Optional(
    Type.String({
      description: "Single range in Feishu format: sheetId!A1:B5",
    }),
  ),
  ranges: Type.Optional(
    Type.Array(Type.String(), {
      description: "Multiple ranges, each in Feishu format: sheetId!A1:B5",
    }),
  ),
  values: Type.Optional(
    Type.Array(Type.Array(Type.Any()), {
      description: "2D matrix for write_range/append.",
    }),
  ),
  value_ranges: Type.Optional(
    Type.Array(RangeValuesSchema, {
      description: "Multiple range+values payload for write_ranges.",
    }),
  ),
  value_render_option: Type.Optional(
    stringEnum(VALUE_RENDER_OPTIONS, {
      description:
        "Read mode: ToString, FormattedValue, Formula, UnformattedValue (read_range/read_ranges).",
    }),
  ),
  date_time_render_option: Type.Optional(
    stringEnum(DATE_TIME_RENDER_OPTIONS, {
      description: "Date render mode for reads. Currently supports FormattedString.",
    }),
  ),
  user_id_type: Type.Optional(
    stringEnum(USER_ID_TYPES, {
      description: "Returned user id type for read APIs: open_id or union_id.",
    }),
  ),
  insert_data_option: Type.Optional(
    stringEnum(INSERT_DATA_OPTIONS, {
      description: "Append mode: OVERWRITE (default) or INSERT_ROWS.",
    }),
  ),
});

type SheetParams = {
  action: (typeof SHEET_ACTIONS)[number];
  spreadsheet_token?: string;
  url?: string;
  range?: string;
  ranges?: string[];
  values?: unknown[][];
  value_ranges?: Array<{ range: string; values: unknown[][] }>;
  value_render_option?: (typeof VALUE_RENDER_OPTIONS)[number];
  date_time_render_option?: (typeof DATE_TIME_RENDER_OPTIONS)[number];
  user_id_type?: (typeof USER_ID_TYPES)[number];
  insert_data_option?: (typeof INSERT_DATA_OPTIONS)[number];
};

type UserSheetApiResult<TData> = {
  ok: boolean;
  code: number;
  msg: string;
  data: TData | null;
  http_status: number;
  method: string;
  endpoint: string;
};

function getFirstAccountOrNull(api: OpenClawPluginApi): ResolvedFeishuAccount | null {
  const accounts = listEnabledFeishuAccounts(api.config);
  return accounts[0] ?? null;
}

function parseSpreadsheetUrl(url: string): { spreadsheetToken: string; sheetId?: string } | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/sheets\/([A-Za-z0-9_-]+)/);
    if (!match) return null;
    const sheetId = parsed.searchParams.get("sheet") ?? undefined;
    return { spreadsheetToken: match[1], sheetId };
  } catch {
    return null;
  }
}

function encodePathSegmentStrict(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function resolveSpreadsheetToken(params: SheetParams): { token: string } | { error: string } {
  const directToken = params.spreadsheet_token?.trim();
  if (directToken) return { token: directToken };
  const url = params.url?.trim();
  if (!url) {
    return { error: "spreadsheet_token is required (or provide url)" };
  }
  const parsed = parseSpreadsheetUrl(url);
  if (!parsed) {
    return { error: "url must be a valid Feishu sheet URL: https://.../sheets/{spreadsheetToken}" };
  }
  return { token: parsed.spreadsheetToken };
}

function validateRange(range: string | undefined, fieldName: "range" | "ranges"): string | null {
  if (!range) return `${fieldName} is required`;
  if (!range.includes("!")) return `${fieldName} must include sheetId prefix, e.g. sheetId!A1:B5`;
  return null;
}

function validateAppendRange(range: string | undefined): string | null {
  const rangeError = validateRange(range, "range");
  if (rangeError) return rangeError;
  const cells = range!.split("!")[1];
  if (!cells || !/^[A-Za-z]+:[A-Za-z]+$/.test(cells)) {
    return "append range must be column range like sheetId!A:A or sheetId!A:J";
  }
  return null;
}

function validateValues(values: unknown[][] | undefined, fieldName: "values"): string | null {
  if (!Array.isArray(values) || values.length === 0)
    return `${fieldName} must be a non-empty 2D array`;
  if (!values.every((row) => Array.isArray(row))) return `${fieldName} must be a 2D array`;
  return null;
}

function validateValueRanges(
  valueRanges: Array<{ range: string; values: unknown[][] }> | undefined,
): string | null {
  if (!Array.isArray(valueRanges) || valueRanges.length === 0) {
    return "value_ranges must be a non-empty array";
  }
  for (const item of valueRanges) {
    const rangeError = validateRange(item.range, "ranges");
    if (rangeError) return `value_ranges item invalid: ${rangeError}`;
    const valuesError = validateValues(item.values, "values");
    if (valuesError) return `value_ranges item invalid: ${valuesError}`;
  }
  return null;
}

async function callSheetUserApi<TData>(params: {
  userToken: string;
  method: "GET" | "POST";
  endpoint: string;
  query?: Record<string, string>;
}): Promise<UserSheetApiResult<TData>> {
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

export function registerFeishuSheetTools(api: OpenClawPluginApi) {
  const account = getFirstAccountOrNull(api);
  if (!account) return;
  const oauthRedirectUri = resolveOAuthRedirectUri(api.config as Record<string, unknown>);

  api.registerTool(
    {
      name: "feishu_sheet",
      label: "Feishu Sheet",
      description:
        "Feishu Sheet cell operations: get_share_url, get_meta, read_range, read_ranges, write_range, write_ranges, append.",
      parameters: FeishuSheetSchema,
      async execute(_toolCallId: string, rawParams: unknown) {
        const params = rawParams as SheetParams;
        const tokenResolved = resolveSpreadsheetToken(params);
        if ("error" in tokenResolved) return makeLocalErrorResult(tokenResolved.error);
        const token = tokenResolved.token;
        const encodedToken = encodeURIComponent(token);
        const requireReadAccess = () =>
          requireUserToken({
            account,
            redirectUri: oauthRedirectUri,
            tokenPromise: getValidUserToken(account),
            toolLabel: "飞书表格读取",
          });

        switch (params.action) {
          case "get_share_url": {
            const guard = await requireReadAccess();
            if (!guard.ok) return guard.authResponse;
            const share = await resolveDriveShareUrl(account, token, "sheet", {
              userToken: guard.token.access_token,
            });
            if (!share.ok) {
              const details =
                share.code !== undefined
                  ? ` (code=${share.code}, msg=${share.msg ?? ""}, http_status=${share.http_status ?? 0})`
                  : "";
              return makeLocalErrorResult(
                `failed_to_resolve_sheet_share_url:${share.error}${details}`,
              );
            }
            return makeToolResult({
              ok: true,
              code: 0,
              msg: "success",
              data: {
                spreadsheetToken: token,
                share_url: share.share_url,
              },
              http_status: 200,
              method: "LOCAL",
              endpoint: "LOCAL:share_url",
            });
          }
          case "get_meta": {
            const guard = await requireReadAccess();
            if (!guard.ok) return guard.authResponse;
            const result = await callSheetUserApi({
              userToken: guard.token.access_token,
              method: "GET",
              endpoint: `/sheets/v2/spreadsheets/${encodedToken}/metainfo`,
            });
            return makeToolResult(result);
          }
          case "read_range": {
            const rangeError = validateRange(params.range, "range");
            if (rangeError) return makeLocalErrorResult(rangeError);
            const guard = await requireReadAccess();
            if (!guard.ok) return guard.authResponse;
            const result = await callSheetUserApi({
              userToken: guard.token.access_token,
              method: "GET",
              endpoint: `/sheets/v2/spreadsheets/${encodedToken}/values/${encodePathSegmentStrict(params.range!)}`,
              query: {
                ...(params.value_render_option
                  ? { valueRenderOption: params.value_render_option }
                  : {}),
                ...(params.date_time_render_option
                  ? { dateTimeRenderOption: params.date_time_render_option }
                  : {}),
                ...(params.user_id_type ? { user_id_type: params.user_id_type } : {}),
              },
            });
            return makeToolResult(result);
          }
          case "read_ranges": {
            if (!Array.isArray(params.ranges) || params.ranges.length === 0) {
              return makeLocalErrorResult("ranges must be a non-empty array");
            }
            for (const item of params.ranges) {
              const rangeError = validateRange(item, "ranges");
              if (rangeError) return makeLocalErrorResult(rangeError);
            }
            const guard = await requireReadAccess();
            if (!guard.ok) return guard.authResponse;
            const result = await callSheetUserApi({
              userToken: guard.token.access_token,
              method: "GET",
              endpoint: `/sheets/v2/spreadsheets/${encodedToken}/values_batch_get`,
              query: {
                ranges: params.ranges.join(","),
                ...(params.value_render_option
                  ? { valueRenderOption: params.value_render_option }
                  : {}),
                ...(params.date_time_render_option
                  ? { dateTimeRenderOption: params.date_time_render_option }
                  : {}),
                ...(params.user_id_type ? { user_id_type: params.user_id_type } : {}),
              },
            });
            return makeToolResult(result);
          }
          case "write_range": {
            const rangeError = validateRange(params.range, "range");
            if (rangeError) return makeLocalErrorResult(rangeError);
            const valuesError = validateValues(params.values, "values");
            if (valuesError) return makeLocalErrorResult(valuesError);
            const result = await callChatApi({
              account,
              method: "PUT",
              endpoint: `/sheets/v2/spreadsheets/${encodedToken}/values`,
              body: {
                valueRange: {
                  range: params.range,
                  values: params.values,
                },
              },
            });
            return makeToolResult(result);
          }
          case "write_ranges": {
            const valueRangesError = validateValueRanges(params.value_ranges);
            if (valueRangesError) return makeLocalErrorResult(valueRangesError);
            const result = await callChatApi({
              account,
              method: "POST",
              endpoint: `/sheets/v2/spreadsheets/${encodedToken}/values_batch_update`,
              body: {
                valueRanges: params.value_ranges,
              },
            });
            return makeToolResult(result);
          }
          case "append": {
            const rangeError = validateAppendRange(params.range);
            if (rangeError) return makeLocalErrorResult(rangeError);
            const valuesError = validateValues(params.values, "values");
            if (valuesError) return makeLocalErrorResult(valuesError);
            const result = await callChatApi({
              account,
              method: "POST",
              endpoint: `/sheets/v2/spreadsheets/${encodedToken}/values_append`,
              query: {
                ...(params.insert_data_option
                  ? { insertDataOption: params.insert_data_option }
                  : {}),
              },
              body: {
                valueRange: {
                  range: params.range,
                  values: params.values,
                },
              },
            });
            return makeToolResult(result);
          }
          default:
            return makeLocalErrorResult(`unknown action: ${String(params.action)}`);
        }
      },
    },
    { name: "feishu_sheet" },
  );
  api.logger.info?.("feishu: registered feishu_sheet tool");
}
