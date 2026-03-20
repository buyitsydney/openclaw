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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk";
import type { ResolvedFeishuAccount } from "./accounts.js";
import { getFeishuClient, sendFeishuRichText } from "./outbound.js";

const FEISHU_ALLOWED_HOSTNAMES = ["open.feishu.cn", "accounts.feishu.cn"];

// ── Backend scope detection ──
// Cached per app: what user scopes are actually granted in the Feishu app backend.
const backendUserScopesCache = new Map<string, Set<string>>();

/**
 * Fetch the user scopes actually granted in the Feishu app backend via
 * `application.scope.list` (tenant token). Results are cached per appId.
 * Returns null on failure (caller should fallback to full OAUTH_SCOPES).
 */
export async function fetchBackendUserScopes(
  account: ResolvedFeishuAccount,
): Promise<Set<string> | null> {
  const cached = backendUserScopesCache.get(account.appId);
  if (cached) return cached;

  try {
    const client = getFeishuClient(account);
    // oxlint-disable-next-line typescript/no-explicit-any
    const res: any = await (client.application as any).scope.list({});
    if (res.code !== 0 || !Array.isArray(res.data?.scopes)) return null;

    const userScopes = new Set<string>();
    for (const s of res.data.scopes) {
      if (s.grant_status === 1 && s.scope_type === "user" && typeof s.scope_name === "string") {
        userScopes.add(s.scope_name);
      }
    }
    backendUserScopesCache.set(account.appId, userScopes);
    console.log(
      `[feishu-oauth] backend scope probe: appId=${account.appId} user_scopes=${userScopes.size}`,
    );
    return userScopes;
  } catch (err) {
    console.warn(
      `[feishu-oauth] backend scope probe failed for ${account.appId}: ${String(err)}. Falling back to full OAUTH_SCOPES.`,
    );
    return null;
  }
}

/**
 * Resolve the effective OAuth scopes: intersection of OAUTH_SCOPES (code)
 * and backend granted scopes (Feishu app config). Falls back to full
 * OAUTH_SCOPES if backend probe fails.
 */
export async function resolveEffectiveOAuthScopes(
  account: ResolvedFeishuAccount,
): Promise<string[]> {
  const backend = await fetchBackendUserScopes(account);
  if (!backend) return OAUTH_SCOPES;
  const effective = OAUTH_SCOPES.filter((s) => backend.has(s));
  if (effective.length < OAUTH_SCOPES.length) {
    const skipped = OAUTH_SCOPES.filter((s) => !backend.has(s));
    console.log(
      `[feishu-oauth] filtered ${skipped.length} scope(s) not in backend: ${skipped.join(", ")}`,
    );
  }
  return effective;
}

/**
 * Check if a specific scope is available in this app's backend.
 * Returns true if backend probe hasn't been done yet (optimistic).
 */
export function isBackendScopeAvailable(appId: string, scope: string): boolean {
  const cached = backendUserScopesCache.get(appId);
  if (!cached) return true; // optimistic: not probed yet
  return cached.has(scope);
}

// All desired user scopes. At runtime, resolveEffectiveOAuthScopes() intersects
// this list with the app's actual backend scopes (via application.scope.list API),
// so scopes not enabled in the Feishu app backend are automatically skipped.
const OAUTH_SCOPES = [
  // ── AI assistant (aily) ──
  "aily:data_asset:read",
  "aily:data_asset:upload_file",
  "aily:data_asset:write",
  "aily:file:read",
  "aily:file:write",
  "aily:knowledge:ask",
  "aily:knowledge:read",
  "aily:knowledge:write",
  "aily:message:read",
  "aily:message:write",
  "aily:run:read",
  "aily:run:write",
  "aily:session:read",
  "aily:session:write",
  "aily:skill:read",
  "aily:skill:write",
  // ── Bitable ──
  "bitable:app:readonly",
  // ── Calendar ──
  "calendar:calendar",
  "calendar:calendar.acl:read",
  "calendar:calendar.event:read",
  "calendar:calendar.free_busy:read",
  "calendar:calendar:read",
  "calendar:calendar:readonly",
  // ── Contact ──
  "contact:user.base:readonly",
  "contact:user:search", // auto-filtered if app backend doesn't have this scope
  // ── Docs ──
  "docs:doc:readonly",
  "docx:document:readonly",
  // ── Drive ──
  "drive:drive.metadata:readonly",
  "drive:drive.search:readonly",
  "drive:drive:readonly",
  "drive:export:readonly",
  "drive:file:readonly",
  // ── Messages & chat ──
  "im:chat:readonly",
  "im:message.group_msg:get_as_user",
  "im:message.p2p_msg:get_as_user",
  "im:message.pins:read",
  "im:message.reactions:read",
  "im:message:readonly",
  // ── Minutes (妙记) ──
  "minutes:minutes",
  "minutes:minutes.basic:read",
  "minutes:minutes.media:export",
  "minutes:minutes.statistics:read",
  "minutes:minutes.transcript:export",
  "minutes:minutes:readonly",
  // ── Search ──
  "search:app",
  "search:department:read",
  "search:docs:read",
  "search:knowledge_qa:read", // auto-filtered if app backend doesn't have this capability
  "search:message",
  // ── Sheets ──
  "sheets:spreadsheet:readonly",
  // ── Tasks ──
  "task:task:readonly",
  // ── Video conference ──
  "vc:export",
  "vc:meeting:readonly",
  "vc:record:readonly",
  "vc:room:readonly",
  // ── Wiki ──
  "wiki:wiki:readonly",
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

/** Delete all user tokens so the next OAuth tool call triggers re-authorization. */
function invalidateAllUserTokens(): void {
  const dir = resolveTokenDir();
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".json")) {
      try {
        unlinkSync(join(dir, file));
      } catch {
        // best-effort cleanup
      }
    }
  }
}

// Feishu error codes that DEFINITELY mean the token itself is broken.
// 99991679 (Unauthorized) is intentionally EXCLUDED — it fires for both
// "token revoked" AND "scope insufficient". Nuking all tokens on a scope
// error destroys calendar/minutes/search OAuth for the entire session.
// If a token is truly revoked, the refresh mechanism handles it naturally
// (access_token expires → refresh fails → triggers re-authorization).
const TOKEN_INVALID_CODES = new Set([
  99991668, // user_access_token invalid or expired
  99991677, // user_access_token expired, needs refresh
]);

/**
 * Check if a Feishu API error indicates the user token is invalid/revoked.
 * If so, delete local token files and return an auth-required response
 * that the tool can return directly to prompt re-authorization.
 *
 * Returns null if the error is not a token error (caller handles normally).
 * Returns an auth response object if token was invalidated (caller returns this).
 */
export async function handleFeishuTokenError(
  err: unknown,
  account?: ResolvedFeishuAccount,
  redirectUri?: string,
): Promise<{ content: { type: "text"; text: string }[]; details: unknown } | null> {
  // Extract error code from various error shapes
  let code: number | undefined;

  if (err && typeof err === "object") {
    // Lark SDK error: err.code or err.response.data.code
    // oxlint-disable-next-line typescript/no-explicit-any
    const e = err as any;
    code = typeof e.code === "number" ? e.code : undefined;
    if (code === undefined && e.response?.data?.code != null) {
      code = e.response.data.code;
    }
    // Tool result JSON: { code: 99991677, msg: "..." }
    if (code === undefined && typeof e.msg === "string" && typeof e.code === "number") {
      code = e.code;
    }
  }

  // Also check error message string for known codes
  if (code === undefined && err instanceof Error) {
    for (const c of TOKEN_INVALID_CODES) {
      if (err.message.includes(String(c))) {
        code = c;
        break;
      }
    }
  }

  if (code !== undefined && TOKEN_INVALID_CODES.has(code)) {
    console.warn(
      `[feishu-oauth] Feishu token error (code=${code}). Deleting local tokens to trigger re-authorization.`,
    );
    invalidateAllUserTokens();

    // Generate auth URL so the tool can return it directly to her
    if (account && redirectUri) {
      const effectiveScopes = await resolveEffectiveOAuthScopes(account);
      const chatId = account.accountId;
      const authUrl = getAuthUrlForChat(account, chatId, redirectUri, effectiveScopes);
      const details = {
        error: "user_auth_required",
        message:
          "用户 OAuth 授权已失效，需要重新授权。" +
          "请将下方链接发送给用户，用户在飞书中点击后完成授权，然后重试。",
        auth_url: authUrl,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
        details,
      };
    }
    // No account/redirectUri → caller must handle re-auth separately
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "user_auth_required",
            message: "用户 OAuth 授权已失效，请重新授权后重试。",
          }),
        },
      ],
      details: { error: "user_auth_required" },
    };
  }
  return null;
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
    // Update scopes from refresh response if Feishu returns them;
    // otherwise keep the existing scopes unchanged.
    const refreshScopeStr: string = res.data.scope ?? "";
    const refreshedScopes = refreshScopeStr
      ? refreshScopeStr.split(/[\s,]+/).filter(Boolean)
      : token.scopes;
    const updated: FeishuUserToken = {
      ...token,
      access_token: res.data.access_token,
      refresh_token: res.data.refresh_token ?? token.refresh_token,
      access_token_expires_at: now + (res.data.expires_in ?? 7200) * 1000,
      refresh_token_expires_at:
        res.data.refresh_expires_in != null
          ? now + res.data.refresh_expires_in * 1000
          : token.refresh_token_expires_at,
      scopes: refreshedScopes,
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
  // log a warning but still use the token. Let the API call fail naturally
  // rather than preemptively invalidating a token that may still work
  // (Feishu's granted scopes in the token file are not always reliable).
  const granted = new Set(token.scopes ?? []);
  const missing = OAUTH_SCOPES.filter((s) => !granted.has(s));
  if (missing.length > 0) {
    console.warn(
      `[feishu-oauth] scope drift: token missing ${missing.length} scope(s): ${missing.join(", ")}. Continuing with existing token.`,
    );
  }

  // access_token still valid
  if (now < token.access_token_expires_at - REFRESH_MARGIN_MS) return token;

  // access_token expired or about to expire → refresh
  const client = getFeishuClient(account);
  return refreshUserToken(client, token);
}

/**
 * Get a valid user_access_token. Auto-refreshes if the access_token is expired
 * but refresh_token is still valid.
 * Returns null if no token exists or refresh_token has expired.
 * Scope drift is logged as a warning but does not invalidate the token.
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

export function buildOAuthAuthorizeUrl(
  appId: string,
  redirectUri: string,
  state: string,
  scopes?: string[],
): string {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: (scopes ?? OAUTH_SCOPES).join(" "),
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
    if (!grantedScopeStr) {
      callbackDeps.warn(
        "OAuth token response did not include scope field; falling back to OAUTH_SCOPES. Actual granted scopes may differ.",
      );
    }

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
  scopes?: string[],
): string {
  const state = createOAuthState(chatId, account.accountId);
  return buildOAuthAuthorizeUrl(account.appId, redirectUri, state, scopes);
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
    const code = parsed.code ?? -1;
    // If Feishu says the token is definitely invalid/expired, delete local
    // token files so the next tool call triggers re-authorization.
    // NOTE: 99991679 (Unauthorized) is NOT handled here — it can mean
    // "scope insufficient" (not just "token revoked"), and nuking tokens
    // on a scope error would break all OAuth tools in the session.
    if (TOKEN_INVALID_CODES.has(code)) {
      console.warn(
        `[feishu-oauth] Feishu rejected user token (code=${code}): ${parsed.msg}. Deleting local tokens to trigger re-authorization.`,
      );
      invalidateAllUserTokens();
    }
    return {
      code,
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
export async function requireUserToken(params: {
  account: ResolvedFeishuAccount;
  redirectUri: string;
  tokenPromise: Promise<FeishuUserToken | null>;
  toolLabel: string;
}): Promise<RequireUserTokenResult> {
  const token = await params.tokenPromise;
  if (token) return { ok: true as const, token };

  // Use effective scopes (intersection with backend) to avoid 20027 errors
  const effectiveScopes = await resolveEffectiveOAuthScopes(params.account);
  const chatId = params.account.accountId;
  const authUrl = getAuthUrlForChat(params.account, chatId, params.redirectUri, effectiveScopes);
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
