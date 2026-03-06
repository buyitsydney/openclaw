/**
 * Feishu OAuth — user_access_token management for minutes/calendar/drive APIs.
 *
 * Flow:
 *   1. Tool detects no valid token → returns guidance for Her to send auth card
 *   2. Her sends interactive card with "点击授权" URL button
 *   3. User clicks → Feishu OAuth page → user confirms → redirect to callback
 *   4. Callback exchanges code for token, persists to disk, notifies user
 *   5. Subsequent tool calls use the stored user_access_token
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk";
import type { ResolvedFeishuAccount } from "./accounts.js";
import { getFeishuClient, sendFeishuRichText } from "./outbound.js";

const FEISHU_ALLOWED_HOSTNAMES = ["open.feishu.cn", "accounts.feishu.cn"];

// Comprehensive read-only scopes so Her has the same visibility as the user.
const OAUTH_SCOPES = [
  // ── Messages & chat ──
  "im:message:readonly",
  "im:message.group_msg:get_as_user",
  "im:message.p2p_msg:readonly",
  "im:chat:readonly",
  "im:resource",
  // ── Drive & docs (read-only) ──
  "drive:drive:readonly",
  "drive:drive.search:readonly",
  "drive:drive.metadata:readonly",
  "drive:file:readonly",
  "drive:export:readonly",
  "docx:document:readonly",
  "docs:doc:readonly",
  "sheets:spreadsheet:readonly",
  "bitable:app:readonly",
  // ── Wiki ──
  "wiki:wiki:readonly",
  // ── Search ──
  "search:docs:read",
  "search:message",
  // ── Calendar ──
  "calendar:calendar",
  "calendar:calendar:readonly",
  // ── Minutes (妙记) ──
  "minutes:minutes",
  "minutes:minutes:readonly",
  "minutes:minutes.basic:read",
  "minutes:minutes.transcript:export",
  // ── Video conference ──
  "vc:meeting:readonly",
  "vc:record:readonly",
  "vc:room:readonly",
  "vc:export",
  // ── Contact (resolve user names) ──
  "contact:user.base:readonly",
  // ── Tasks ──
  "task:task:readonly",
];

// ── Types ──

export type FeishuUserToken = {
  open_id: string;
  name?: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: number;
  refresh_token_expires_at: number;
  scopes: string[];
  created_at: number;
  updated_at: number;
};

type OAuthState = {
  nonce: string;
  chatId: string;
  accountId: string;
  createdAt: number;
};

// ── Token storage ──

function resolveTokenDir(): string {
  const base = process.env.OPENCLAW_HOME ?? join(homedir(), ".openclaw");
  return join(base, "feishu-user-tokens");
}

function ensureTokenDir(): string {
  const dir = resolveTokenDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function loadUserToken(openId: string): FeishuUserToken | null {
  const filePath = join(resolveTokenDir(), `${openId}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as FeishuUserToken;
  } catch {
    return null;
  }
}

function saveUserToken(token: FeishuUserToken): void {
  const dir = ensureTokenDir();
  const filePath = join(dir, `${token.open_id}.json`);
  writeFileSync(filePath, JSON.stringify(token, null, 2), "utf-8");
}

/** Find any valid user token from the store. For single-user (personal Her) this is sufficient. */
export function findAnyUserToken(): FeishuUserToken | null {
  const dir = resolveTokenDir();
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    try {
      const token = JSON.parse(readFileSync(join(dir, file), "utf-8")) as FeishuUserToken;
      if (token.open_id && token.refresh_token) return token;
    } catch {
      continue;
    }
  }
  return null;
}

// ── Token refresh ──

async function refreshUserToken(
  client: Lark.Client,
  token: FeishuUserToken,
): Promise<FeishuUserToken | null> {
  try {
    // oxlint-disable-next-line typescript/no-explicit-any
    const res: any = await client.authen.refreshAccessToken.create({
      data: {
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
      },
    });
    if (res.code !== 0 || !res.data?.access_token) return null;

    const now = Date.now();
    const updated: FeishuUserToken = {
      ...token,
      access_token: res.data.access_token,
      refresh_token: res.data.refresh_token ?? token.refresh_token,
      access_token_expires_at: now + (res.data.expires_in ?? 7200) * 1000,
      refresh_token_expires_at:
        res.data.refresh_expires_in != null
          ? now + res.data.refresh_expires_in * 1000
          : token.refresh_token_expires_at,
      updated_at: now,
    };
    saveUserToken(updated);
    return updated;
  } catch {
    return null;
  }
}

/**
 * Get a valid user_access_token. Auto-refreshes if the access_token is expired
 * but refresh_token is still valid.
 * Returns null if no token exists, refresh_token has expired, or token is
 * missing scopes that OAUTH_SCOPES now requires (triggers re-authorization).
 */
export async function getValidUserToken(
  account: ResolvedFeishuAccount,
): Promise<FeishuUserToken | null> {
  const token = findAnyUserToken();
  if (!token) return null;

  const now = Date.now();
  const REFRESH_MARGIN_MS = 10 * 60 * 1000; // refresh 10min before expiry

  // refresh_token expired → user must re-authorize
  if (now >= token.refresh_token_expires_at) return null;

  // Scope drift: if code now requests scopes the saved token doesn't have,
  // treat the token as invalid so the user gets prompted to re-authorize.
  const granted = new Set(token.scopes ?? []);
  const missing = OAUTH_SCOPES.filter((s) => !granted.has(s));
  if (missing.length > 0) return null;

  // access_token still valid
  if (now < token.access_token_expires_at - REFRESH_MARGIN_MS) return token;

  // access_token expired or about to expire → refresh
  const client = getFeishuClient(account);
  return refreshUserToken(client, token);
}

// ── OAuth URL ──

export function buildOAuthAuthorizeUrl(appId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    state,
  });
  return `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${params.toString()}`;
}

// ── State management (in-memory, short-lived) ──

const pendingStates = new Map<string, OAuthState>();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function createOAuthState(chatId: string, accountId: string): string {
  const nonce = randomBytes(16).toString("hex");
  const state: OAuthState = { nonce, chatId, accountId, createdAt: Date.now() };
  pendingStates.set(nonce, state);
  // Prune expired states
  const now = Date.now();
  for (const [key, val] of pendingStates) {
    if (now - val.createdAt > STATE_TTL_MS) pendingStates.delete(key);
  }
  return nonce;
}

// States that were already consumed (OAuth completed). Kept briefly so
// duplicate/retry requests from Cloudflare tunnels still show the success page.
const completedStates = new Map<string, OAuthState>();
const COMPLETED_TTL_MS = 5 * 60 * 1000;

function consumeOAuthState(nonce: string): OAuthState | null {
  // Already completed — return the state again for the success page.
  const done = completedStates.get(nonce);
  if (done) return done;

  const state = pendingStates.get(nonce);
  if (!state) return null;
  pendingStates.delete(nonce);
  if (Date.now() - state.createdAt > STATE_TTL_MS) return null;
  return state;
}

function markStateCompleted(nonce: string, state: OAuthState): void {
  completedStates.set(nonce, state);
  setTimeout(() => completedStates.delete(nonce), COMPLETED_TTL_MS);
}

// ── OAuth callback handler ──

type OAuthCallbackDeps = {
  resolveAccount: (accountId: string) => ResolvedFeishuAccount | null;
  log: (msg: string) => void;
  warn: (msg: string) => void;
};

let callbackDeps: OAuthCallbackDeps | null = null;

export function initOAuthCallback(deps: OAuthCallbackDeps): void {
  callbackDeps = deps;
}

/** HTTP handler for /feishu/oauth/callback — registered via api.registerHttpRoute */
export async function handleOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const code = url.searchParams.get("code");
  const stateNonce = url.searchParams.get("state");

  if (!code || !stateNonce) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<h2>授权失败</h2><p>缺少 code 或 state 参数。请重新从飞书发起授权。</p>");
    return;
  }

  const isRetry = completedStates.has(stateNonce);
  const state = consumeOAuthState(stateNonce);

  // Retry of an already-completed OAuth — show success without re-exchanging.
  if (!state && isRetry) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<h2>授权成功</h2><p>授权已完成。你可以关闭此页面，回到飞书继续对话。</p>");
    return;
  }

  if (!state) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<h2>授权失败</h2><p>授权链接已过期或无效，请重新从飞书发起授权。</p>");
    return;
  }

  if (!callbackDeps) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<h2>服务错误</h2><p>OAuth 模块未初始化。</p>");
    return;
  }

  const account = callbackDeps.resolveAccount(state.accountId);
  if (!account) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<h2>服务错误</h2><p>找不到飞书应用配置。</p>");
    return;
  }

  // Exchange code for access_token + refresh_token
  const client = getFeishuClient(account);
  try {
    // oxlint-disable-next-line typescript/no-explicit-any
    const tokenRes: any = await client.authen.accessToken.create({
      data: { grant_type: "authorization_code", code },
    });

    if (tokenRes.code !== 0 || !tokenRes.data?.access_token) {
      callbackDeps.warn(`OAuth token exchange failed: code=${tokenRes.code} msg=${tokenRes.msg}`);
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        `<h2>授权失败</h2><p>Token 交换失败: ${tokenRes.msg ?? "unknown error"}</p><p>请重新从飞书发起授权。</p>`,
      );
      return;
    }

    const now = Date.now();
    const userToken: FeishuUserToken = {
      open_id: tokenRes.data.open_id ?? "",
      name: tokenRes.data.name,
      access_token: tokenRes.data.access_token,
      refresh_token: tokenRes.data.refresh_token ?? "",
      access_token_expires_at: now + (tokenRes.data.expires_in ?? 7200) * 1000,
      refresh_token_expires_at: now + (tokenRes.data.refresh_expires_in ?? 2592000) * 1000,
      scopes: OAUTH_SCOPES,
      created_at: now,
      updated_at: now,
    };

    saveUserToken(userToken);
    markStateCompleted(stateNonce, state);
    callbackDeps.log(
      `OAuth success: ${userToken.name ?? userToken.open_id} (${userToken.open_id})`,
    );

    // Respond with success page
    const displayName = userToken.name ?? "用户";
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      `<h2>授权成功</h2><p>${displayName}，Her 现在可以读取你的飞书妙记/会议纪要了。</p><p>你可以关闭此页面，回到飞书继续对话。</p>`,
    );

    // Notify user in Feishu chat (best-effort).
    // state.chatId may be a placeholder (e.g. "default") when the tool lacks the real chat ID;
    // real Feishu chat IDs start with "oc_".
    if (state.chatId.startsWith("oc_")) {
      sendFeishuRichText({
        account,
        chatId: state.chatId,
        text: `**授权成功** ✓\n${displayName}，我现在可以读取你的飞书妙记和会议纪要了。\n你可以说"帮我看看今天的会议纪要"来试试。`,
      }).catch(() => {
        // best-effort notification
      });
    }
  } catch (err) {
    callbackDeps.warn(`OAuth callback error: ${String(err)}`);
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<h2>授权失败</h2><p>服务器内部错误，请稍后重试。</p>");
  }
}

// ── Authorization card ──

/**
 * Build an OAuth authorize URL for a given user/chat and return it.
 * The caller (minutes tool) returns this URL in the tool result so Her
 * can send it to the user as a clickable link or card.
 */
export function getAuthUrlForChat(
  account: ResolvedFeishuAccount,
  chatId: string,
  redirectUri: string,
): string {
  const state = createOAuthState(chatId, account.accountId);
  return buildOAuthAuthorizeUrl(account.appId, redirectUri, state);
}

// ── Standalone OAuth HTTP server ──
// The gateway HTTP server binds to loopback only, unreachable from the Docker-based
// Cloudflare tunnel. This standalone server binds to 0.0.0.0 so the tunnel can reach it.

const DEFAULT_OAUTH_PORT = 18891;

export function startOAuthServer(params: {
  port?: number;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}): void {
  const port = params.port ?? DEFAULT_OAUTH_PORT;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/feishu/oauth/callback") {
      try {
        await handleOAuthCallback(req, res);
      } catch (err) {
        params.warn(`OAuth callback unhandled error: ${String(err)}`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end("Internal Server Error");
        }
      }
      return;
    }
    res.statusCode = 404;
    res.end("Not Found");
  });

  server.listen(port, "0.0.0.0", () => {
    params.log(`OAuth HTTP server listening on 0.0.0.0:${port}`);
  });
  server.on("error", (err) => {
    params.warn(`OAuth HTTP server failed to start on port ${port}: ${String(err)}`);
  });
}

// ── Raw HTTP helper for user_access_token calls (e.g. Drive search) ──

type FeishuApiResponse<T = unknown> = {
  code: number;
  msg: string;
  data: T | null;
};

export async function callFeishuApiWithUserToken<T = unknown>(params: {
  method: "GET" | "POST";
  endpoint: string;
  userToken: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
}): Promise<FeishuApiResponse<T>> {
  const base = "https://open.feishu.cn/open-apis";
  const path = params.endpoint.startsWith("/") ? params.endpoint : `/${params.endpoint}`;
  const url = new URL(`${base}${path}`);
  if (params.query) {
    for (const [k, v] of Object.entries(params.query)) {
      url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.userToken}`,
  };
  const init: RequestInit = { method: params.method, headers };
  if (params.body) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    init.body = JSON.stringify(params.body);
  }

  const { response, release } = await fetchWithSsrFGuard({
    url: url.toString(),
    init,
    policy: { allowedHostnames: FEISHU_ALLOWED_HOSTNAMES },
    auditContext: `feishu-user-api:${params.method}:${params.endpoint}`,
  });
  try {
    const raw = await response.text();
    const parsed = JSON.parse(raw) as FeishuApiResponse<T>;
    return {
      code: parsed.code ?? -1,
      msg: parsed.msg ?? "",
      data: parsed.data ?? null,
    };
  } catch {
    return { code: -1, msg: "non_json_response", data: null };
  } finally {
    await release();
  }
}
