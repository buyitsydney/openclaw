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
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/feishu";
import type { ResolvedFeishuAccount } from "./accounts.js";
import { getFeishuClient, sendFeishuRichText } from "./outbound.js";

const FEISHU_ALLOWED_HOSTNAMES = ["open.feishu.cn", "accounts.feishu.cn"];

// ── Backend scope detection (single source of truth: Feishu app backend) ──
//
// Design (2026-04-30 — single source of truth refactor):
// The Feishu app backend (open platform → permission management) is the ONLY
// place where OAuth scopes are declared. This plugin does not maintain a local
// hardcoded scope list. At authorization time we call `application.scope.list`
// and request ALL user-type scopes with grant_status=1.
//
// Rationale: hardcoded lists drift from the backend (backend adds scope → code
// forgets to add it → user cannot use the new API). Reading the backend keeps
// both sides in lockstep with zero maintenance.
//
// Cache: 15-minute TTL so normal bursts of concurrent tool calls share a
// single HTTP round-trip without blocking new-scope pickup for long.

export class OAuthBackendUnavailableError extends Error {
  constructor(appId: string, cause: unknown) {
    super(
      `Feishu backend scope query failed for appId=${appId}: ${String(cause)}. ` +
        "OAuth cannot proceed without the backend scope list — check app secret / network / " +
        "Feishu open platform status.",
    );
    this.name = "OAuthBackendUnavailableError";
  }
}

type BackendScopeCacheEntry = {
  scopes: Set<string>;
  fetchedAt: number;
};
const SCOPE_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const backendUserScopesCache = new Map<string, BackendScopeCacheEntry>();

// Inflight dedup so N concurrent callers share one HTTP round-trip.
const inflightBackendProbes = new Map<string, Promise<Set<string>>>();

/**
 * Fetch ALL user-type scopes (grant_status=1) from the Feishu app backend.
 * Cached per appId with a 15-minute TTL; concurrent callers share one HTTP
 * call via inflight dedup. Throws `OAuthBackendUnavailableError` on failure —
 * callers must decide how to surface this (typically return a clear error
 * to Her instead of silently falling back to a stale hardcoded list).
 */
export async function fetchBackendUserScopes(account: ResolvedFeishuAccount): Promise<Set<string>> {
  const cached = backendUserScopesCache.get(account.appId);
  if (cached && Date.now() - cached.fetchedAt < SCOPE_CACHE_TTL_MS) {
    return cached.scopes;
  }

  const inflight = inflightBackendProbes.get(account.appId);
  if (inflight) {
    return inflight;
  }

  const probe = (async () => {
    try {
      const client = getFeishuClient(account);
      // oxlint-disable-next-line typescript/no-explicit-any
      const res: any = await (client.application as any).scope.list({});
      if (res.code !== 0 || !Array.isArray(res.data?.scopes)) {
        throw new Error(`Feishu responded code=${res.code} msg=${res.msg}`);
      }
      const userScopes = new Set<string>();
      for (const s of res.data.scopes) {
        if (s.grant_status === 1 && s.scope_type === "user" && typeof s.scope_name === "string") {
          userScopes.add(s.scope_name);
        }
      }
      if (userScopes.size === 0) {
        throw new Error("backend returned zero user scopes — app misconfigured?");
      }
      backendUserScopesCache.set(account.appId, {
        scopes: userScopes,
        fetchedAt: Date.now(),
      });
      console.log(
        `[feishu-oauth] backend scope probe ok: appId=${account.appId} user_scopes=${userScopes.size}`,
      );
      return userScopes;
    } catch (err) {
      console.warn(
        `[feishu-oauth] backend scope probe FAILED for ${account.appId}: ${String(err)}. No fallback — callers will see OAuthBackendUnavailableError.`,
      );
      throw new OAuthBackendUnavailableError(account.appId, err);
    } finally {
      inflightBackendProbes.delete(account.appId);
    }
  })();

  inflightBackendProbes.set(account.appId, probe);
  return probe;
}

/**
 * Feishu OAuth authorize URL size reduction.
 *
 * Empirical facts (2026-05-01 headless-Chrome E2E, admin her):
 *   - `accounts.feishu.cn/open-apis/authen/v1/authorize` returns 302 to
 *     `passport.feishu.cn/accounts/page/login`, which DOUBLE-encodes the
 *     original URL into its `redirect_uri` parameter (%3A → %253A).
 *   - The passport login endpoint returns HTTP 431 once the request-line +
 *     headers (dominated by that embedded redirect_uri) exceed ~4700 bytes.
 *     Browser then renders "HTTP ERROR 431" / blank page.
 *   - Passport URL bytes ≈ raw URL bytes × 1.22 (measured across 5 scope
 *     counts: 40/60/80/100/115/120/130/140/150/170).
 *
 * Threshold table (measured):
 *   n=115 raw=3736 passport=4518 → 302 OK
 *   n=120 raw=3882 passport=4690 → 431 FAIL
 *   n=140 raw=4428 passport=5346 → 302 OK  (non-monotonic, scope-specific)
 *   n=170 raw=5024 passport=6102 → 431 FAIL
 *
 * Safety: keep raw URL ≤ 3700 bytes so passport URL ≤ ~4500 bytes.
 * MAX_AUTHORIZE_URL_BYTES below encodes this headroom directly.
 *
 * 2-step reduction:
 *   1. dedupSubsumedScopes() — drop `X:readonly|read|write_only|write` when `X`
 *      is also in the backend set (sub-scopes are implied by the parent).
 *   2. applyDynamicQuota() — pick the largest per-domain quota such that the
 *      resulting authorize URL fits MAX_AUTHORIZE_URL_BYTES. Stable under
 *      scope-set growth (adding a new scope never silently drops an older one
 *      from a different domain).
 */
const SCOPE_DOMAIN_QUOTA = 15;
/** Max raw authorize URL bytes. Empirical safe margin: passport URL ≤ ~4500. */
const MAX_AUTHORIZE_URL_BYTES = 3700;

/**
 * Scopes that must survive quota reduction — user-facing capabilities that
 * would be silently crippled if the domain quota happens to drop them.
 * Verified cases that motivated this list (2026-05-01 A/B diff test):
 *   - mail:user_mailbox.message:readonly was truncated by applyDomainQuota(8)
 *     because the mail domain had 15 entries; tools asking for it returned
 *     99991679 Unauthorized without any user-visible hint.
 *
 * Rule: only include scopes that (a) unlock an entire tool surface when
 * present and (b) aren't covered by a parent scope on the backend.
 */
const PRIORITY_SCOPES: readonly string[] = [
  "mail:user_mailbox.message:readonly",
  "mail:user_mailbox.message:send",
  "mail:user_mailbox.folder:read",
  "mail:user_mailbox.mail_contact:read",
  "offline_access",
];

/**
 * Thrown when even the minimal-quota authorize URL exceeds the hard size
 * guard. Callers must surface this to the user instead of silently building
 * a URL that Feishu's passport will reject with HTTP 431.
 */
export class OAuthUrlTooLargeError extends Error {
  constructor(
    public readonly urlBytes: number,
    public readonly maxBytes: number,
    public readonly finalScopeCount: number,
  ) {
    super(
      `OAuth authorize URL ${urlBytes} bytes exceeds hard limit ${maxBytes} ` +
        `even at per-domain quota=1 (${finalScopeCount} scopes kept). ` +
        `The app has so many scopes that even the minimum set cannot fit. ` +
        `Reduce PRIORITY_SCOPES or prune backend scopes.`,
    );
    this.name = "OAuthUrlTooLargeError";
  }
}
const SCOPE_DROP_SUFFIXES = ["readonly", "read", "write_only", "write"] as const;

function dedupSubsumedScopes(scopes: Set<string>): {
  kept: string[];
  dropped: Array<{ scope: string; parent: string }>;
} {
  const kept: string[] = [];
  const dropped: Array<{ scope: string; parent: string }> = [];
  for (const scope of scopes) {
    let subsumed = false;
    for (const suffix of SCOPE_DROP_SUFFIXES) {
      const trailer = `:${suffix}`;
      if (scope.endsWith(trailer)) {
        const parent = scope.slice(0, -trailer.length);
        if (scopes.has(parent)) {
          dropped.push({ scope, parent });
          subsumed = true;
          break;
        }
      }
    }
    if (!subsumed) {
      kept.push(scope);
    }
  }
  return { kept, dropped };
}

function applyDomainQuota(scopes: string[], quota: number): { kept: string[]; dropped: string[] } {
  const byDomain = new Map<string, string[]>();
  for (const s of scopes) {
    const domain = s.split(":")[0];
    if (!byDomain.has(domain)) {
      byDomain.set(domain, []);
    }
    byDomain.get(domain)!.push(s);
  }
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const [, arr] of byDomain) {
    arr.sort();
    kept.push(...arr.slice(0, quota));
    dropped.push(...arr.slice(quota));
  }
  kept.sort();
  return { kept, dropped };
}

/**
 * Resolve the full set of OAuth scopes to request. Backend is the single
 * source of truth; we then apply deterministic reductions to fit Feishu's
 * authorize-URL size limit. Throws `OAuthBackendUnavailableError` if the
 * backend is unreachable — by design, we refuse to authorize with a stale
 * hardcoded list.
 */
/**
 * Estimate the authorize URL size without building the final URL. Used by
 * applyDynamicQuota() to find the largest per-domain quota that still fits.
 * Overhead calibrated against a known-good build (client_id + full callback
 * URL + 64-char hex state). Returns bytes of the raw URL.
 */
function estimateAuthorizeUrlBytes(
  scopes: string[],
  clientId: string,
  redirectUri: string,
): number {
  const encodedRedirect = encodeURIComponent(redirectUri);
  // Each scope encoded with `+` joiner (URLSearchParams converts space → `+`
  // and %-encodes `:`). Use encodeURIComponent to mirror that exactly; the
  // joiner `+` is 1 byte per pair.
  const encodedScopes = scopes.map((s) => encodeURIComponent(s)).join("+");
  // Base template length (empirical, constant for this provider):
  //   "https://accounts.feishu.cn/open-apis/authen/v1/authorize" = 57
  //   + "?client_id=" (11) + clientId.length
  //   + "&redirect_uri=" (14) + encodedRedirect.length
  //   + "&response_type=code" (19)
  //   + "&scope=" (7) + encodedScopes.length
  //   + "&state=" (7) + 64
  return (
    57 +
    11 + clientId.length +
    14 + encodedRedirect.length +
    19 +
    7 + encodedScopes.length +
    7 + 64
  );
}

/**
 * Binary-search-ish: try quota values from SCOPE_DOMAIN_QUOTA down to 1 and
 * keep the largest one whose URL fits. Priority scopes (PRIORITY_SCOPES) are
 * partitioned out before domain reduction so a shrinking quota never drops
 * them. Throws OAuthUrlTooLargeError if even quota=1 + priority exceeds
 * MAX_AUTHORIZE_URL_BYTES.
 */
function applyDynamicQuota(
  scopes: string[],
  clientId: string,
  redirectUri: string,
): {
  kept: string[];
  dropped: string[];
  quota: number;
  urlBytes: number;
  priorityKept: string[];
} {
  const granted = new Set(scopes);
  const priorityKept = PRIORITY_SCOPES.filter((s) => granted.has(s));
  const priorityKeptSet = new Set(priorityKept);
  const regulars = scopes.filter((s) => !priorityKeptSet.has(s));

  // Try quota values from SCOPE_DOMAIN_QUOTA down to 1 exactly once each.
  // Remember the last attempt so we can throw with accurate telemetry if even
  // quota=1 can't fit (no dead-code duplicate call after the loop).
  let lastResult: { kept: string[]; dropped: string[]; urlBytes: number; quota: number } | null =
    null;
  for (let quota = SCOPE_DOMAIN_QUOTA; quota >= 1; quota--) {
    const r = applyDomainQuota(regulars, quota);
    const combined = [...priorityKept, ...r.kept].sort();
    const urlBytes = estimateAuthorizeUrlBytes(combined, clientId, redirectUri);
    lastResult = { kept: combined, dropped: r.dropped, urlBytes, quota };
    if (urlBytes <= MAX_AUTHORIZE_URL_BYTES) {
      return { ...lastResult, priorityKept };
    }
  }

  // Even quota=1 + priority set doesn't fit; surface a typed error so callers
  // can tell the user instead of silently building a URL that Feishu 431s.
  /* istanbul ignore next -- defensive: SCOPE_DOMAIN_QUOTA ≥ 1 guarantees the loop runs */
  if (!lastResult) {
    throw new Error("applyDynamicQuota: SCOPE_DOMAIN_QUOTA must be >= 1");
  }
  throw new OAuthUrlTooLargeError(
    lastResult.urlBytes,
    MAX_AUTHORIZE_URL_BYTES,
    lastResult.kept.length,
  );
}

/**
 * Conservative fallback when callers don't know the final redirect_uri yet.
 * Matches typical CarHer callback length (~55 chars) plus a 30-byte margin so
 * the dynamic quota still produces a safe URL.
 */
const FALLBACK_REDIRECT_URI = "https://example-very-long-subdomain.example.com/feishu/oauth/callback";

export async function resolveEffectiveOAuthScopes(
  account: ResolvedFeishuAccount,
  redirectUri?: string,
): Promise<string[]> {
  const backend = await fetchBackendUserScopes(account);
  const dedupResult = dedupSubsumedScopes(backend);
  const effectiveRedirect = redirectUri || FALLBACK_REDIRECT_URI;
  const dyn = applyDynamicQuota(dedupResult.kept, account.appId, effectiveRedirect);

  if (dedupResult.dropped.length > 0) {
    console.log(
      `[feishu-oauth] scope dedup: ${dedupResult.dropped.length} sub-scope(s) subsumed by parent. Sample: ${dedupResult.dropped
        .slice(0, 3)
        .map((d) => `${d.scope}⊂${d.parent}`)
        .join(", ")}`,
    );
  }
  if (dyn.dropped.length > 0) {
    console.warn(
      `[feishu-oauth] scope quota: ${dyn.dropped.length} scope(s) dropped (dynamic domain cap=${dyn.quota}) to fit ${MAX_AUTHORIZE_URL_BYTES}-byte URL limit (actual=${dyn.urlBytes}). Sample: ${dyn.dropped.slice(0, 3).join(", ")}`,
    );
  }
  if (dyn.priorityKept.length > 0) {
    console.log(
      `[feishu-oauth] priority scopes kept (never quota-cut): ${dyn.priorityKept.join(", ")}`,
    );
  }
  console.log(
    `[feishu-oauth] effective scopes: backend=${backend.size} dedup_dropped=${dedupResult.dropped.length} quota_dropped=${dyn.dropped.length} final=${dyn.kept.length} quota=${dyn.quota} url_bytes=${dyn.urlBytes} priority=${dyn.priorityKept.length}`,
  );
  return dyn.kept;
}

/** Test-only: exported internals for unit testing. */
export const __scopeReduction = {
  dedupSubsumedScopes,
  applyDomainQuota,
  applyDynamicQuota,
  estimateAuthorizeUrlBytes,
  SCOPE_DOMAIN_QUOTA,
  MAX_AUTHORIZE_URL_BYTES,
  PRIORITY_SCOPES,
};

/**
 * Check if a specific scope is available in this app's backend.
 * Returns true if the probe hasn't run yet (optimistic — do not block tool
 * registration on the probe). Returns accurate results once cache is populated.
 */
export function isBackendScopeAvailable(appId: string, scope: string): boolean {
  const cached = backendUserScopesCache.get(appId);
  if (!cached) {
    return true;
  } // optimistic: not probed yet
  return cached.scopes.has(scope);
}

/** Test-only: clear the scope cache between unit tests. */
export function __clearScopeCacheForTests(): void {
  backendUserScopesCache.clear();
  inflightBackendProbes.clear();
}

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
  if (!existsSync(filePath)) {
    return null;
  }
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
  if (!existsSync(dir)) {
    return;
  }
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
    // Guard: if another concurrent call already refreshed the token successfully
    // (inflight dedup), the new token is valid — don't nuke it.
    const currentToken = findAnyUserToken();
    if (currentToken && Date.now() < currentToken.access_token_expires_at - 60_000) {
      console.log(
        `[feishu-oauth] token error (code=${code}) but a fresh token exists (expires ${new Date(currentToken.access_token_expires_at).toISOString()}). Skipping invalidation — likely stale concurrent call.`,
      );
      return null; // let the caller retry with the fresh token
    }
    console.warn(
      `[feishu-oauth] Feishu token error (code=${code}). Deleting local tokens to trigger re-authorization.`,
    );
    invalidateAllUserTokens();

    // Generate auth URL so the tool can return it directly to her
    if (account && redirectUri) {
      let effectiveScopes: string[];
      try {
        effectiveScopes = await resolveEffectiveOAuthScopes(account, redirectUri);
      } catch (scopeErr) {
        console.warn(
          `[feishu-oauth] cannot re-auth after token error: backend unavailable (${String(scopeErr)})`,
        );
        const details = {
          error: "oauth_backend_unavailable",
          message:
            "用户 OAuth 授权已失效，且飞书后台权限列表查询失败，无法生成重新授权链接。" +
            "请检查 app secret、网络、或飞书开放平台后台状态后重试。",
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
          details,
        };
      }
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

/** Find the best user token from the store — prefer newest valid token over stale ones. */
export function findAnyUserToken(): FeishuUserToken | null {
  const dir = resolveTokenDir();
  if (!existsSync(dir)) {
    return null;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  let best: FeishuUserToken | null = null;
  for (const file of files) {
    try {
      const token = JSON.parse(readFileSync(join(dir, file), "utf-8")) as FeishuUserToken;
      if (!token.open_id || !token.refresh_token) {
        continue;
      }
      if (!best || token.updated_at > best.updated_at) {
        best = token;
      }
    } catch {
      continue;
    }
  }
  return best;
}

// ── Token refresh ──

// Inflight dedup: all concurrent callers share one refresh promise per open_id.
// Prevents N parallel tool calls from firing N refresh requests, where N-1 fail
// (Feishu refresh_token is single-use) and trigger invalidateAllUserTokens().
const inflightRefreshes = new Map<string, Promise<FeishuUserToken | null>>();

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
    if (res.code !== 0 || !res.data?.access_token) {
      return null;
    }

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
    console.log(`[feishu-oauth] token refreshed for ${token.open_id}`);
    return updated;
  } catch {
    return null;
  }
}

async function ensureValidUserToken(
  account: ResolvedFeishuAccount,
  token: FeishuUserToken | null,
): Promise<FeishuUserToken | null> {
  if (!token) {
    return null;
  }

  const now = Date.now();
  const REFRESH_MARGIN_MS = 10 * 60 * 1000; // refresh 10min before expiry

  // refresh_token expired → user must re-authorize
  if (now >= token.refresh_token_expires_at) {
    return null;
  }

  // Scope drift detection: compare the saved token's scopes against the
  // current backend-granted set. Backend is the single source of truth — if
  // it added new scopes since the user authorized, warn but do not invalidate
  // the token (the user can re-authorize if they need the new scope).
  //
  // Skipped when the token's stored scopes are empty: some Feishu OAuth
  // responses do not include the `scope` field, and we save `scopes: []` in
  // that case. Comparing against the backend set would then report every
  // backend scope as "missing" — a false positive, because Feishu still
  // enforces at request time and every tool call succeeds.
  const storedScopes = token.scopes ?? [];
  if (storedScopes.length > 0) {
    try {
      const backend = await fetchBackendUserScopes(account);
      const granted = new Set(storedScopes);
      const missing = Array.from(backend).filter((s) => !granted.has(s));
      if (missing.length > 0) {
        console.warn(
          `[feishu-oauth] scope drift: token missing ${missing.length} backend-granted scope(s) (user can re-auth to pick up). Sample: ${missing.slice(0, 3).join(", ")}`,
        );
      }
    } catch {
      // Non-fatal: backend unavailable during token validity check.
    }
  }

  // access_token still valid
  if (now < token.access_token_expires_at - REFRESH_MARGIN_MS) {
    return token;
  }

  // access_token expired or about to expire → refresh with inflight dedup
  const key = token.open_id;
  const inflight = inflightRefreshes.get(key);
  if (inflight) {
    console.log(`[feishu-oauth] dedup: joining inflight refresh for ${key}`);
    return inflight;
  }

  const client = getFeishuClient(account);
  const promise = refreshUserToken(client, token).finally(() => {
    inflightRefreshes.delete(key);
  });
  inflightRefreshes.set(key, promise);
  return promise;
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
  scopes: string[],
): string {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error(
      "buildOAuthAuthorizeUrl: scopes is required and must be non-empty. " +
        "Callers must resolve scopes from the Feishu backend (single source of truth) " +
        "via resolveEffectiveOAuthScopes() before building the URL.",
    );
  }
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
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
    if (now - val.createdAt > STATE_TTL_MS) {
      pendingStates.delete(key);
    }
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
  if (done) {
    return done;
  }

  const state = pendingStates.get(nonce);
  if (!state) {
    return null;
  }
  pendingStates.delete(nonce);
  if (Date.now() - state.createdAt > STATE_TTL_MS) {
    return null;
  }
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

    // Use actual granted scopes from Feishu response so scope drift detection
    // works correctly if backend permissions change later.
    const grantedScopeStr: string = tokenRes.data.scope ?? "";
    const grantedScopes = grantedScopeStr ? grantedScopeStr.split(/[\s,]+/).filter(Boolean) : [];
    if (!grantedScopeStr) {
      callbackDeps.warn(
        "OAuth token response did not include scope field; token saved with empty scopes (Feishu still enforces at request time).",
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

    // Diff against backend single-source-of-truth (best effort).
    let missingFromGrant: string[] = [];
    try {
      const backend = await fetchBackendUserScopes(account);
      const grantedSet = new Set(grantedScopes);
      missingFromGrant = Array.from(backend).filter((s) => !grantedSet.has(s));
    } catch {
      // Backend probe failed; skip diff.
    }
    callbackDeps.log(
      `OAuth success: ${userToken.name ?? userToken.open_id} (${userToken.open_id}) — ${grantedScopes.length} scopes granted` +
        (missingFromGrant.length > 0
          ? `, ${missingFromGrant.length} backend-scope(s) not in grant: ${missingFromGrant.slice(0, 5).join(", ")}`
          : ""),
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
  scopes: string[],
): string {
  const state = createOAuthState(chatId, account.accountId);
  return buildOAuthAuthorizeUrl(account.appId, redirectUri, state, scopes);
}

// ── Standalone OAuth HTTP server ──
// The gateway HTTP server binds to loopback only, unreachable from the Docker-based
// Cloudflare tunnel. This standalone server binds to 0.0.0.0 so the tunnel can reach it.

const DEFAULT_OAUTH_PORT = 18891;
// oxlint-disable-next-line typescript-eslint/no-redundant-type-constituents
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
    if (buffer.length === 0) {
      return null;
    }
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
  if (token) {
    return { ok: true as const, token };
  }

  // Backend is the single source of truth for scopes. If the backend probe
  // fails we refuse to authorize with a stale local list — return a clear
  // error instead so the caller / user can investigate.
  let effectiveScopes: string[];
  try {
    effectiveScopes = await resolveEffectiveOAuthScopes(params.account, params.redirectUri);
  } catch (err) {
    const details = {
      error: "oauth_backend_unavailable",
      message:
        `需要用户 OAuth 授权才能使用${params.toolLabel}，` +
        "但飞书后台权限列表查询失败，无法生成授权链接。" +
        `原因：${String(err)}。请检查 app secret、网络、或飞书开放平台后台状态。`,
    };
    return {
      ok: false as const,
      authResponse: {
        content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
        details,
      },
    };
  }
  const chatId = params.account.accountId;
  const authUrl = getAuthUrlForChat(params.account, chatId, params.redirectUri, effectiveScopes);
  const details = {
    error: "user_auth_required",
    message:
      `需要用户 OAuth 授权才能使用${params.toolLabel}。` +
      "请将下方链接发送给用户，用户在飞书中点击后完成授权，然后重试。" +
      "链接一次性授权所有飞书后台已开通的权限（单一信源）。",
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
  if (typeof feishuConfig.oauthRedirectUri === "string") {
    return feishuConfig.oauthRedirectUri;
  }
  const minutesConfig = (feishuConfig.minutes ?? {}) as Record<string, unknown>;
  if (typeof minutesConfig.oauthRedirectUri === "string") {
    return minutesConfig.oauthRedirectUri;
  }
  return "https://auth.carher.net/feishu/oauth/callback";
}
