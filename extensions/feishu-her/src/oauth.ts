/**
 * Feishu OAuth — user_access_token management for all tools that need user identity.
 *
 * Flow:
 *   1. Tool calls requireUserToken() → checks for valid token
 *   2. If missing, returns auth URL in a ready-to-return tool result
 *   3. Her sends the link to the user as a clickable card
 *   4. User clicks → Feishu OAuth page → user confirms → redirect to callback
 *   5. Callback exchanges code for token, persists to disk, notifies user
 *   6. Subsequent tool calls use the stored user_access_token
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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

async function ensureValidUserToken(
  account: ResolvedFeishuAccount,
  token: FeishuUserToken | null,
): Promise<FeishuUserToken | null> {
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

/**
 * Get a valid user_access_token. Auto-refreshes if the access_token is expired
 * but refresh_token is still valid.
 * Returns null if no token exists, refresh_token has expired, or token is
 * missing scopes that OAUTH_SCOPES now requires (triggers re-authorization).
 */
export async function getValidUserToken(
  account: ResolvedFeishuAccount,
): Promise<FeishuUserToken | null> {
  return ensureValidUserToken(account, findAnyUserToken());
}

export async function getValidUserTokenForOpenId(
  account: ResolvedFeishuAccount,
  openId: string,
): Promise<FeishuUserToken | null> {
  return ensureValidUserToken(account, loadUserToken(openId));
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

export function buildOAuthSuccessPageHtml(displayName: string): string {
  return (
    `<h2>授权成功</h2><p>${displayName}，飞书授权已完成。` +
    "Her 现在可以读取你授权范围内的飞书内容了。</p>" +
    "<p>你可以关闭此页面，回到飞书继续对话。</p>"
  );
}

export function buildOAuthSuccessNotificationText(displayName: string): string {
  return (
    `**授权成功** ✓\n${displayName}，飞书授权已完成。\n` +
    "我现在可以读取你授权范围内的飞书内容了。\n" +
    "你可以继续让我查看群聊历史、会议纪要等需要用户权限的内容。"
  );
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

  // Feishu mobile opens callback in internal WebView first (consuming the code),
  // then shows "即将离开飞书" and opens Chrome with the same URL. Detect this
  // duplicate and show success immediately without re-exchanging the code.
  if (completedStates.has(stateNonce)) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<h2>授权成功</h2><p>授权已完成。你可以关闭此页面，回到飞书继续对话。</p>");
    return;
  }

  const state = consumeOAuthState(stateNonce);

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
      // code=20003 means the authorization code was already exchanged (e.g. Feishu
      // mobile WebView consumed it, now Chrome retries with the same code). If we
      // already have a valid token on disk, treat this as success.
      if (tokenRes.code === 20003) {
        const existing = findAnyUserToken();
        if (existing) {
          markStateCompleted(stateNonce, state);
          callbackDeps.log(
            `OAuth code already used but token exists for ${existing.name ?? existing.open_id} — showing success`,
          );
          const displayName = existing.name ?? "用户";
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(buildOAuthSuccessPageHtml(displayName));
          return;
        }
      }
      callbackDeps.warn(`OAuth token exchange failed: code=${tokenRes.code} msg=${tokenRes.msg}`);
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        `<h2>授权失败</h2><p>Token 交换失败: ${tokenRes.msg ?? "unknown error"}</p><p>请重新从飞书发起授权。</p>`,
      );
      return;
    }

    const now = Date.now();

    // Use actual granted scopes from Feishu (not our requested list) so scope
    // drift detection works correctly when the app backend is missing permissions.
    const grantedScopeStr: string = tokenRes.data.scope ?? "";
    const grantedScopes = grantedScopeStr
      ? grantedScopeStr.split(/[\s,]+/).filter(Boolean)
      : OAUTH_SCOPES;

    const userToken: FeishuUserToken = {
      open_id: tokenRes.data.open_id ?? "",
      name: tokenRes.data.name,
      access_token: tokenRes.data.access_token,
      refresh_token: tokenRes.data.refresh_token ?? "",
      access_token_expires_at: now + (tokenRes.data.expires_in ?? 7200) * 1000,
      refresh_token_expires_at: now + (tokenRes.data.refresh_expires_in ?? 2592000) * 1000,
      scopes: grantedScopes,
      created_at: now,
      updated_at: now,
    };

    saveUserToken(userToken);
    markStateCompleted(stateNonce, state);

    const missing = OAUTH_SCOPES.filter((s) => !grantedScopes.includes(s));
    callbackDeps.log(
      `OAuth success: ${userToken.name ?? userToken.open_id} (${userToken.open_id}) — ${grantedScopes.length} scopes granted` +
        (missing.length > 0 ? `, MISSING: ${missing.join(", ")}` : ""),
    );

    // Respond with success page
    const displayName = userToken.name ?? "用户";
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(buildOAuthSuccessPageHtml(displayName));

    // Notify user in Feishu chat (best-effort).
    // state.chatId may be a placeholder (e.g. "default") when the tool lacks the real chat ID;
    // real Feishu chat IDs start with "oc_".
    if (state.chatId.startsWith("oc_")) {
      sendFeishuRichText({
        account,
        chatId: state.chatId,
        text: buildOAuthSuccessNotificationText(displayName),
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
let oauthServer: Server | null = null;
let oauthServerPort: number | null = null;
let oauthServerStartingPort: number | null = null;

export function startOAuthServer(params: {
  port?: number;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}): void {
  const port = params.port ?? DEFAULT_OAUTH_PORT;
  const activePort = oauthServerPort ?? oauthServerStartingPort;
  if (activePort != null) {
    if (activePort === port) {
      params.log(
        `OAuth HTTP server already initialized on 0.0.0.0:${port}; skipping duplicate start`,
      );
      return;
    }
    params.warn(
      `OAuth HTTP server already initialized on port ${activePort}; refusing duplicate start on ${port}`,
    );
    return;
  }

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

  oauthServerStartingPort = port;
  server.listen(port, "0.0.0.0", () => {
    oauthServer = server;
    oauthServerPort = port;
    oauthServerStartingPort = null;
    params.log(`OAuth HTTP server listening on 0.0.0.0:${port}`);
  });
  server.on("error", (err) => {
    oauthServerStartingPort = null;
    if (oauthServer === server) {
      oauthServer = null;
      oauthServerPort = null;
    }
    params.warn(`OAuth HTTP server failed to start on port ${port}: ${String(err)}`);
  });
  server.on("close", () => {
    if (oauthServer === server) {
      oauthServer = null;
      oauthServerPort = null;
    }
    if (oauthServerStartingPort === port) {
      oauthServerStartingPort = null;
    }
  });
}

// ── Raw HTTP helper for user_access_token calls (e.g. Drive search) ──

type FeishuApiResponse<T = unknown> = {
  code: number;
  msg: string;
  data: T | null;
};

export async function callFeishuApiWithUserToken<T = unknown>(params: {
  method: "GET" | "POST" | "PATCH" | "DELETE";
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

export async function downloadFeishuMessageResourceWithUserToken(params: {
  userToken: string;
  messageId: string;
  fileKey: string;
  type: "file" | "image";
}): Promise<{ buffer: Buffer; contentType?: string } | null> {
  const url = new URL(
    `https://open.feishu.cn/open-apis/im/v1/messages/${params.messageId}/resources/${params.fileKey}`,
  );
  url.searchParams.set("type", params.type);
  const { response, release } = await fetchWithSsrFGuard({
    url: url.toString(),
    init: {
      headers: {
        Authorization: `Bearer ${params.userToken}`,
      },
    },
    policy: { allowedHostnames: FEISHU_ALLOWED_HOSTNAMES },
    auditContext: `feishu-user-resource:${params.type}:${params.messageId}`,
  });
  try {
    if (!response.ok) {
      const body = (await response.text()).trim();
      throw new Error(
        `feishu user resource download failed: HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ""}`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) return null;
    return {
      buffer,
      contentType: response.headers.get("content-type")?.trim() ?? "application/octet-stream",
    };
  } finally {
    await release();
  }
}

// ── Unified user-token guard ──

export type RequireUserTokenResult =
  | { ok: true; token: FeishuUserToken }
  | { ok: false; authResponse: { content: { type: "text"; text: string }[]; details: unknown } };

/**
 * Unified guard: check for a valid user_access_token and, if missing,
 * return a tool result containing the auth URL so Her can forward it.
 *
 * Every tool that needs user_access_token should call this once at the top.
 */
export function requireUserToken(params: {
  account: ResolvedFeishuAccount;
  redirectUri: string;
  tokenPromise: Promise<FeishuUserToken | null>;
  toolLabel: string;
}): Promise<RequireUserTokenResult> {
  return params.tokenPromise.then((token) => {
    if (token) return { ok: true as const, token };
    const chatId = params.account.accountId;
    const authUrl = getAuthUrlForChat(params.account, chatId, params.redirectUri);
    const details = {
      error: "user_auth_required",
      message:
        `需要用户 OAuth 授权才能使用${params.toolLabel}。` +
        "请将下方链接发送给用户，用户在飞书中点击后完成授权，然后重试。",
      auth_url: authUrl,
    };
    return {
      ok: false as const,
      authResponse: {
        content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
        details,
      },
    };
  });
}

/**
 * Resolve the OAuth redirect URI from plugin config.
 * Looks at channels.feishu.oauthRedirectUri first (new unified location),
 * then falls back to channels.feishu.minutes.oauthRedirectUri (legacy).
 */
export function resolveOAuthRedirectUri(config: Record<string, unknown>): string {
  const feishuConfig = ((config.channels as Record<string, unknown>)?.["feishu"] ?? {}) as Record<
    string,
    unknown
  >;
  if (typeof feishuConfig.oauthRedirectUri === "string") return feishuConfig.oauthRedirectUri;
  const minutesConfig = (feishuConfig.minutes ?? {}) as Record<string, unknown>;
  if (typeof minutesConfig.oauthRedirectUri === "string") return minutesConfig.oauthRedirectUri;
  return "https://auth.carher.net/feishu/oauth/callback";
}
