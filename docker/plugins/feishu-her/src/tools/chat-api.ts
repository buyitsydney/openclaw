import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/feishu";
import type { ResolvedFeishuAccount } from "../accounts.js";
import { getFeishuClient } from "../outbound.js";

const FEISHU_OPEN_API_BASE = "https://open.feishu.cn/open-apis";
const FEISHU_ALLOWED_HOSTNAMES = ["open.feishu.cn"];

type QueryValue = string | number | boolean | undefined;
type QueryParams = Record<string, QueryValue>;

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

export type ChatApiResult<TData = unknown> = {
  ok: boolean;
  code: number;
  msg: string;
  data: TData | null;
  http_status: number;
  method: string;
  endpoint: string;
};

export type ChatApiRequest = {
  account: ResolvedFeishuAccount;
  method: "GET" | "POST" | "PUT" | "DELETE";
  endpoint: string;
  query?: QueryParams;
  body?: Record<string, unknown>;
};

function buildOpenApiUrl(endpoint: string, query?: QueryParams): string {
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const url = new URL(`${FEISHU_OPEN_API_BASE}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function getTenantAccessToken(account: ResolvedFeishuAccount): Promise<string> {
  const client = getFeishuClient(account) as unknown as TokenClient;
  const token = await client.tokenManager?.getTenantAccessToken({});
  if (!token) {
    throw new Error("failed_to_get_tenant_access_token");
  }
  return token;
}

function parseFeishuEnvelope<TData>(raw: string): FeishuEnvelope<TData> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  return parsed as FeishuEnvelope<TData>;
}

export async function callChatApi<TData = unknown>(
  request: ChatApiRequest,
): Promise<ChatApiResult<TData>> {
  const url = buildOpenApiUrl(request.endpoint, request.query);
  try {
    const token = await getTenantAccessToken(request.account);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    const init: RequestInit = {
      method: request.method,
      headers,
    };
    if (request.body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      init.body = JSON.stringify(request.body);
    }

    const { response, release } = await fetchWithSsrFGuard({
      url,
      init,
      policy: { allowedHostnames: FEISHU_ALLOWED_HOSTNAMES },
      auditContext: `feishu-chat-api:${request.method}:${request.endpoint}`,
    });
    try {
      const raw = await response.text();
      const payload = parseFeishuEnvelope<TData>(raw);
      if (!payload) {
        return {
          ok: false,
          code: -1,
          msg: "non_json_response",
          data: null,
          http_status: response.status,
          method: request.method,
          endpoint: request.endpoint,
        };
      }
      const code = typeof payload.code === "number" ? payload.code : -1;
      const msg = typeof payload.msg === "string" ? payload.msg : "";
      return {
        ok: code === 0,
        code,
        msg,
        data: (payload.data as TData | undefined) ?? null,
        http_status: response.status,
        method: request.method,
        endpoint: request.endpoint,
      };
    } finally {
      await release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: -1,
      msg: `request_failed:${message}`,
      data: null,
      http_status: 0,
      method: request.method,
      endpoint: request.endpoint,
    };
  }
}

export function makeToolResult<TData>(result: ChatApiResult<TData>) {
  const payload = {
    ok: result.ok,
    code: result.code,
    msg: result.msg,
    data: result.data,
    http_status: result.http_status,
    method: result.method,
    endpoint: result.endpoint,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export function makeLocalErrorResult(message: string) {
  return makeToolResult({
    ok: false,
    code: -1,
    msg: message,
    data: null,
    http_status: 0,
    method: "LOCAL",
    endpoint: "LOCAL",
  });
}
