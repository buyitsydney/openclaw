/**
 * Feishu Minutes tool — discover and read meeting minutes (妙记) and AI summaries.
 *
 * Discovery path (no "list all minutes" API exists):
 *   Drive search for "智能纪要" docx → read docx blocks → extract /minutes/obcnXXXX links
 *   → minutes.v1.minute.get for metadata → minuteTranscript.get for transcript
 *   → docx rawContent for AI summary text
 *
 * Full-text search path (keyword appears only in transcript, not AI summary):
 *   Drive search finds "文字记录" docx (full transcript) → read blocks → extract
 *   linked "智能纪要" docx token → follow standard discovery path above
 *
 * Requires user_access_token (OAuth) for Drive search and minutes API.
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import {
  callFeishuApiWithUserToken,
  getAuthUrlForChat,
  getValidUserToken,
  type FeishuUserToken,
} from "../oauth.js";
import { getFeishuClient } from "../outbound.js";

// ── Schema ──

const MINUTES_ACTIONS = ["list", "get", "transcript", "search"] as const;

const FeishuMinutesSchema = Type.Object({
  action: stringEnum(MINUTES_ACTIONS, {
    description:
      "list: discover recent meeting minutes (default 7 days). " +
      "get: get minute details + AI summary by minute_token. " +
      "transcript: get full transcript by minute_token. " +
      "search: search minutes by keyword.",
  }),
  minute_token: Type.Optional(
    Type.String({
      description: "Minute token (e.g. obcnXXXX). Required for get/transcript actions.",
    }),
  ),
  doc_token: Type.Optional(
    Type.String({
      description: "Document token of the 智能纪要 docx. Used by get action to read AI summary.",
    }),
  ),
  query: Type.Optional(Type.String({ description: "Search keyword for search action." })),
  days: Type.Optional(
    Type.Number({
      description: "Time range in days for list action (default 7, max 30).",
    }),
  ),
});

// ── Helpers ──

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function authRequiredResult(account: ResolvedFeishuAccount, redirectUri: string) {
  const authInfo = {
    error: "user_auth_required",
    message:
      "需要用户 OAuth 授权才能读取飞书妙记。请发送以下授权链接给用户，让用户在飞书中点击授权。",
    instructions:
      "Send the user this authorization link. After they authorize, retry the minutes action.",
    note: "The redirect_uri must be configured in the Feishu app backend security settings.",
    redirect_uri: redirectUri,
  };
  return json(authInfo);
}

function buildAuthUrl(account: ResolvedFeishuAccount, redirectUri: string, chatId: string) {
  return getAuthUrlForChat(account, chatId, redirectUri);
}

// ── Drive search: find "智能纪要" documents ──

type DriveSearchDoc = {
  docs_token: string;
  docs_type: string;
  title: string;
  owner_id: string;
};

async function searchSmartMinutesDocs(
  userToken: string,
  keyword: string,
  count: number,
): Promise<DriveSearchDoc[]> {
  try {
    const res = await callFeishuApiWithUserToken<{
      docs_entities?: DriveSearchDoc[];
      has_more?: boolean;
      total?: number;
    }>({
      method: "POST",
      endpoint: "/suite/docs-api/search/object",
      userToken,
      body: {
        search_key: keyword,
        count: Math.min(count, 50),
        offset: 0,
        owner_ids: [],
        docs_types: [22], // 22 = docx
      },
    });
    if (res.code !== 0) {
      throw new Error(`Drive search failed: code=${res.code} msg=${res.msg}`);
    }
    return res.data?.docs_entities ?? [];
  } catch (err) {
    throw new Error(`Drive search error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Extract tokens from docx blocks ──

const MINUTES_URL_PATTERN = /\/minutes\/(obcn[a-zA-Z0-9]+)/g;
const DOCX_URL_PATTERN = /\/docx\/([a-zA-Z0-9]+)/g;

async function extractMinuteTokensFromDoc(
  client: Lark.Client,
  docToken: string,
  userAccessToken: string,
): Promise<string[]> {
  const tokens = new Set<string>();
  let pageToken: string | undefined;

  do {
    // oxlint-disable-next-line typescript/no-explicit-any
    const res: any = await client.docx.documentBlock.list(
      {
        path: { document_id: docToken },
        params: { page_size: 500, ...(pageToken ? { page_token: pageToken } : {}) },
      },
      Lark.withUserAccessToken(userAccessToken),
    );
    if (res.code !== 0) break;

    const blocks = res.data?.items ?? [];
    for (const block of blocks) {
      const blockJson = JSON.stringify(block);
      let match: RegExpExecArray | null;
      MINUTES_URL_PATTERN.lastIndex = 0;
      while ((match = MINUTES_URL_PATTERN.exec(blockJson)) !== null) {
        tokens.add(match[1]);
      }
    }
    pageToken = res.data?.has_more ? res.data.page_token : undefined;
  } while (pageToken);

  return [...tokens];
}

/**
 * "文字记录" docx links to its corresponding "智能纪要" docx via a /docx/XXXX URL in blocks.
 * Returns the first linked docx token that isn't the document itself.
 */
async function extractLinkedSmartMinutesDocToken(
  client: Lark.Client,
  docToken: string,
  userAccessToken: string,
): Promise<string | null> {
  try {
    // oxlint-disable-next-line typescript/no-explicit-any
    const res: any = await client.docx.documentBlock.list(
      {
        path: { document_id: docToken },
        params: { page_size: 500 },
      },
      Lark.withUserAccessToken(userAccessToken),
    );
    if (res.code !== 0) return null;

    for (const block of res.data?.items ?? []) {
      const blockJson = JSON.stringify(block);
      let match: RegExpExecArray | null;
      DOCX_URL_PATTERN.lastIndex = 0;
      while ((match = DOCX_URL_PATTERN.exec(blockJson)) !== null) {
        if (match[1] !== docToken) return match[1];
      }
    }
  } catch {
    // best-effort
  }
  return null;
}

// ── Minute metadata ──

type MinuteInfo = {
  minute_token: string;
  title?: string;
  duration?: string;
  url?: string;
  owner_id?: string;
  create_time?: string;
  doc_token?: string;
  doc_title?: string;
};

async function getMinuteInfo(
  client: Lark.Client,
  minuteToken: string,
  userAccessToken: string,
): Promise<MinuteInfo | null> {
  try {
    // oxlint-disable-next-line typescript/no-explicit-any
    const res: any = await client.minutes.v1.minute.get(
      { path: { minute_token: minuteToken } },
      Lark.withUserAccessToken(userAccessToken),
    );
    if (res.code !== 0) return null;
    const m = res.data?.minute;
    return {
      minute_token: m?.minute_token ?? minuteToken,
      title: m?.title,
      duration: m?.duration,
      url: m?.url,
      owner_id: m?.owner_id,
      create_time: m?.create_time,
    };
  } catch {
    return null;
  }
}

// ── Transcript ──

async function getTranscript(
  client: Lark.Client,
  minuteToken: string,
  userAccessToken: string,
): Promise<string | null> {
  try {
    const res = await client.minutes.v1.minuteTranscript.get(
      { path: { minute_token: minuteToken } },
      Lark.withUserAccessToken(userAccessToken),
    );
    if (!res) return null;
    const stream = res.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
  } catch {
    return null;
  }
}

// ── AI summary (read smart minutes docx content) ──

async function getAiSummary(
  client: Lark.Client,
  docToken: string,
  userAccessToken: string,
): Promise<string | null> {
  try {
    // oxlint-disable-next-line typescript/no-explicit-any
    const res: any = await client.docx.document.rawContent(
      { path: { document_id: docToken } },
      Lark.withUserAccessToken(userAccessToken),
    );
    if (res.code !== 0) return null;
    return res.data?.content ?? null;
  } catch {
    return null;
  }
}

// ── Actions ──

/** Parse date from smart minutes title like "智能纪要：XXX 2026年3月4日" */
function parseDateFromTitle(title: string): Date | null {
  const m = title.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

async function listMinutes(
  client: Lark.Client,
  userToken: FeishuUserToken,
  days: number,
): Promise<unknown> {
  const docs = await searchSmartMinutesDocs(userToken.access_token, "智能纪要", 50);

  // Filter: only "智能纪要" titles + recent N days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  cutoff.setHours(0, 0, 0, 0);
  const recentDocs = docs.filter((d) => {
    if (!d.title.startsWith("智能纪要")) return false;
    const date = parseDateFromTitle(d.title);
    return date ? date >= cutoff : true;
  });

  if (recentDocs.length === 0) {
    return { minutes: [], message: `最近 ${days} 天未找到智能纪要文档。` };
  }

  // Extract minute tokens from each smart minutes docx
  const results: MinuteInfo[] = [];
  const errors: string[] = [];
  for (const doc of recentDocs) {
    try {
      const minuteTokens = await extractMinuteTokensFromDoc(
        client,
        doc.docs_token,
        userToken.access_token,
      );
      for (const mt of minuteTokens) {
        const info = await getMinuteInfo(client, mt, userToken.access_token);
        if (info) {
          info.doc_token = doc.docs_token;
          info.doc_title = doc.title;
          results.push(info);
        }
      }
    } catch (err) {
      errors.push(`${doc.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Deduplicate by minute_token
  const seen = new Set<string>();
  const unique = results.filter((r) => {
    if (seen.has(r.minute_token)) return false;
    seen.add(r.minute_token);
    return true;
  });

  return {
    minutes: unique,
    count: unique.length,
    days,
    ...(errors.length > 0 ? { warnings: errors } : {}),
    tip: "Use get action with minute_token to read AI summary. Use transcript action for full transcript.",
  };
}

async function getMinute(
  client: Lark.Client,
  userToken: FeishuUserToken,
  minuteToken: string,
  docToken?: string,
): Promise<unknown> {
  const info = await getMinuteInfo(client, minuteToken, userToken.access_token);
  if (!info) {
    return { error: `minute_token ${minuteToken} not found or no permission.` };
  }

  let aiSummary: string | null = null;
  if (docToken) {
    aiSummary = await getAiSummary(client, docToken, userToken.access_token);
  }

  return {
    ...info,
    ai_summary: aiSummary,
    tip: aiSummary
      ? undefined
      : "Provide doc_token (from list results) to also read the AI summary.",
  };
}

async function getMinuteTranscript(
  client: Lark.Client,
  userToken: FeishuUserToken,
  minuteToken: string,
): Promise<unknown> {
  const info = await getMinuteInfo(client, minuteToken, userToken.access_token);
  if (!info) {
    return { error: `minute_token ${minuteToken} not found or no permission.` };
  }

  const transcript = await getTranscript(client, minuteToken, userToken.access_token);
  return {
    minute_token: minuteToken,
    title: info.title,
    transcript: transcript ?? "Transcript not available.",
  };
}

async function searchMinutes(
  client: Lark.Client,
  userToken: FeishuUserToken,
  query: string,
): Promise<unknown> {
  // Drive search is full-text: finds keyword in both AI summaries ("智能纪要")
  // and full transcripts ("文字记录"). We only need one search call.
  const docs = await searchSmartMinutesDocs(userToken.access_token, query, 50);

  // Classify results: only docx, split into "智能纪要" and "文字记录"
  // docs_type comes back as "docx" (string name), despite request using numeric 22
  const smartDocs: DriveSearchDoc[] = [];
  const textRecordDocs: DriveSearchDoc[] = [];
  for (const d of docs) {
    const dt = String(d.docs_type);
    if (dt !== "docx" && dt !== "22") continue;
    if (d.title.startsWith("智能纪要")) smartDocs.push(d);
    else if (d.title.startsWith("文字记录")) textRecordDocs.push(d);
  }

  // Resolve "文字记录" → linked "智能纪要" (if not already discovered)
  const smartDocTokens = new Set(smartDocs.map((d) => d.docs_token));
  for (const trd of textRecordDocs.slice(0, 10)) {
    try {
      const linkedToken = await extractLinkedSmartMinutesDocToken(
        client,
        trd.docs_token,
        userToken.access_token,
      );
      if (linkedToken && !smartDocTokens.has(linkedToken)) {
        smartDocTokens.add(linkedToken);
        smartDocs.push({
          docs_token: linkedToken,
          docs_type: "22",
          title: trd.title.replace("文字记录", "智能纪要"),
          owner_id: trd.owner_id,
        });
      }
    } catch {
      // best-effort: if we can't resolve the link, skip this transcript doc
    }
  }

  // Extract minute tokens from "智能纪要" docs
  const results: MinuteInfo[] = [];
  const errors: string[] = [];
  for (const doc of smartDocs.slice(0, 10)) {
    try {
      const minuteTokens = await extractMinuteTokensFromDoc(
        client,
        doc.docs_token,
        userToken.access_token,
      );
      for (const mt of minuteTokens) {
        const info = await getMinuteInfo(client, mt, userToken.access_token);
        if (info) {
          info.doc_token = doc.docs_token;
          info.doc_title = doc.title;
          results.push(info);
        }
      }
    } catch (err) {
      errors.push(`${doc.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const deduped = new Set<string>();
  const finalResults = results.filter((r) => {
    if (deduped.has(r.minute_token)) return false;
    deduped.add(r.minute_token);
    return true;
  });

  return {
    query,
    minutes: finalResults,
    count: finalResults.length,
    ...(errors.length > 0 ? { warnings: errors } : {}),
  };
}

// ── Registration ──

export function registerFeishuMinutesTools(api: OpenClawPluginApi): void {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const firstAccount: ResolvedFeishuAccount = accounts[0];
  const getClient = () => getFeishuClient(firstAccount);

  // Resolve redirect URI from config, with sensible default
  const feishuConfig = (api.config.channels?.["feishu"] ?? {}) as Record<string, unknown>;
  const minutesConfig = (feishuConfig.minutes ?? {}) as Record<string, unknown>;
  const redirectUri =
    (minutesConfig.oauthRedirectUri as string) ?? "https://auth.carher.net/feishu/oauth/callback";

  api.registerTool(
    {
      name: "feishu_minutes",
      label: "Feishu Minutes",
      description:
        "Read Feishu meeting minutes (妙记) and AI summaries (智能纪要). " +
        "Actions: list (discover recent minutes), get (minute details + AI summary), " +
        "transcript (full speech-to-text), search (find minutes by keyword). " +
        "Requires user OAuth authorization on first use — the tool will return an auth URL " +
        "if authorization is needed; send it to the user as a clickable link.",
      parameters: FeishuMinutesSchema,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        try {
          const userToken = await getValidUserToken(firstAccount);

          if (!userToken) {
            // Build auth URL with a placeholder chatId;
            // Her will send the link to the user in the current conversation
            const authUrl = buildAuthUrl(firstAccount, redirectUri, firstAccount.accountId);
            return json({
              error: "user_auth_required",
              message:
                "需要用户 OAuth 授权才能读取飞书妙记。请将下方链接发送给用户，" +
                "用户在飞书中点击后完成授权，然后重试。",
              auth_url: authUrl,
            });
          }

          const client = getClient();

          switch (params.action) {
            case "list": {
              const days = Math.min(Math.max(params.days ?? 7, 1), 30);
              return json(await listMinutes(client, userToken, days));
            }
            case "get": {
              if (!params.minute_token) {
                return json({ error: "minute_token is required for get action." });
              }
              return json(
                await getMinute(client, userToken, params.minute_token, params.doc_token),
              );
            }
            case "transcript": {
              if (!params.minute_token) {
                return json({
                  error: "minute_token is required for transcript action.",
                });
              }
              return json(await getMinuteTranscript(client, userToken, params.minute_token));
            }
            case "search": {
              if (!params.query) {
                return json({ error: "query is required for search action." });
              }
              return json(await searchMinutes(client, userToken, params.query));
            }
            default:
              return json({ error: `Unknown action: ${params.action}` });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return json({ error: message });
        }
      },
    },
    { name: "feishu_minutes" },
  );
  api.logger.info?.("feishu: registered feishu_minutes tool");
}
