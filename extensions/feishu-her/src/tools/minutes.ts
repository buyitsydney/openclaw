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

type DriveSearchPage = {
  docs: DriveSearchDoc[];
  hasMore: boolean;
  total: number;
};

const SEARCH_PAGE_SIZE = 50;
const SEARCH_PAGE_OFFSETS = [0, 50, 100, 150] as const;
const SEARCH_MAX_CANDIDATES = 20;
const SEARCH_MAX_RESULTS = 5;
const SEARCH_SNIPPET_RADIUS = 120;

async function searchMinutesDocsPage(
  userToken: string,
  keyword: string,
  count: number,
  offset: number,
): Promise<DriveSearchPage> {
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
        count: Math.min(count, SEARCH_PAGE_SIZE),
        offset,
        owner_ids: [],
        docs_types: [22], // 22 = docx; response may still include non-docx, so filter locally
      },
    });
    if (res.code !== 0) {
      throw new Error(`Drive search failed: code=${res.code} msg=${res.msg}`);
    }
    return {
      docs: res.data?.docs_entities ?? [],
      hasMore: Boolean(res.data?.has_more),
      total: res.data?.total ?? 0,
    };
  } catch (err) {
    throw new Error(`Drive search error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function searchSmartMinutesDocs(
  userToken: string,
  keyword: string,
  count: number,
): Promise<DriveSearchDoc[]> {
  const page = await searchMinutesDocsPage(userToken, keyword, count, 0);
  return page.docs;
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

// ── Docx raw text / AI summary ──

async function getDocxRawContent(
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

async function getAiSummary(
  client: Lark.Client,
  docToken: string,
  userAccessToken: string,
): Promise<string | null> {
  return getDocxRawContent(client, docToken, userAccessToken);
}

// ── Actions ──

/** Parse date from smart minutes title like "智能纪要：XXX 2026年3月4日" */
function parseDateFromTitle(title: string): Date | null {
  const m = title.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Extract meeting name from "智能纪要：XXX 2026年3月1日" → "XXX" */
function parseMeetingNameFromTitle(title: string): string {
  return title
    .replace(/^智能纪要[：:]\s*/, "")
    .replace(/\s+\d{4}年\d{1,2}月\d{1,2}日$/, "")
    .trim();
}

/**
 * Build a MinuteInfo from docx metadata when minutes API is unavailable
 * (either no obcn link in docx blocks, or minutes.get returned 403).
 */
function docxFallbackInfo(doc: DriveSearchDoc, minuteToken?: string): MinuteInfo {
  const date = parseDateFromTitle(doc.title);
  return {
    minute_token: minuteToken ?? `doc:${doc.docs_token}`,
    title: parseMeetingNameFromTitle(doc.title),
    doc_token: doc.docs_token,
    doc_title: doc.title,
    owner_id: doc.owner_id,
    ...(date ? { create_time: String(date.getTime()) } : {}),
  };
}

type SearchMatchSource = "summary" | "transcript";

type SearchTranscriptSnippet = {
  speaker?: string;
  timestamp?: string;
  snippet: string;
};

type SearchCandidate = {
  smart_doc_token: string;
  smart_doc_title: string;
  owner_id: string;
  rank: number;
  match_sources: Set<SearchMatchSource>;
  text_record_doc_token?: string;
  text_record_doc_title?: string;
};

type SearchResult = MinuteInfo & {
  ai_summary: string | null;
  match_sources: SearchMatchSource[];
  why_matched: string;
  transcript_snippets?: SearchTranscriptSnippet[];
};

function isDocxType(docsType: string): boolean {
  const dt = String(docsType).toLowerCase();
  return dt === "docx" || dt === "22";
}

function getMinutesDocKind(doc: DriveSearchDoc): SearchMatchSource | null {
  if (!isDocxType(doc.docs_type)) return null;
  if (doc.title.startsWith("智能纪要")) return "summary";
  if (doc.title.startsWith("文字记录")) return "transcript";
  return null;
}

function includesQuery(text: string | null | undefined, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!text || !normalizedQuery) return false;
  return text.toLowerCase().includes(normalizedQuery);
}

function orderedMatchSources(matchSources: Set<SearchMatchSource>): SearchMatchSource[] {
  const ordered: SearchMatchSource[] = [];
  if (matchSources.has("summary")) ordered.push("summary");
  if (matchSources.has("transcript")) ordered.push("transcript");
  return ordered;
}

function addSearchCandidate(
  candidates: Map<string, SearchCandidate>,
  candidate: {
    smart_doc_token: string;
    smart_doc_title: string;
    owner_id: string;
    rank: number;
    source: SearchMatchSource;
    text_record_doc_token?: string;
    text_record_doc_title?: string;
  },
): void {
  const existing = candidates.get(candidate.smart_doc_token);
  if (!existing) {
    candidates.set(candidate.smart_doc_token, {
      smart_doc_token: candidate.smart_doc_token,
      smart_doc_title: candidate.smart_doc_title,
      owner_id: candidate.owner_id,
      rank: candidate.rank,
      match_sources: new Set([candidate.source]),
      ...(candidate.text_record_doc_token
        ? { text_record_doc_token: candidate.text_record_doc_token }
        : {}),
      ...(candidate.text_record_doc_title
        ? { text_record_doc_title: candidate.text_record_doc_title }
        : {}),
    });
    return;
  }

  existing.rank = Math.min(existing.rank, candidate.rank);
  existing.match_sources.add(candidate.source);
  if (candidate.source === "summary") {
    existing.smart_doc_title = candidate.smart_doc_title;
  }
  if (candidate.text_record_doc_token && !existing.text_record_doc_token) {
    existing.text_record_doc_token = candidate.text_record_doc_token;
  }
  if (candidate.text_record_doc_title && !existing.text_record_doc_title) {
    existing.text_record_doc_title = candidate.text_record_doc_title;
  }
}

function buildTranscriptSnippet(rawContent: string, query: string): SearchTranscriptSnippet | null {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return null;

  const matchIndex = rawContent.toLowerCase().indexOf(normalizedQuery);
  if (matchIndex === -1) return null;

  const start = Math.max(0, matchIndex - SEARCH_SNIPPET_RADIUS);
  const end = Math.min(rawContent.length, matchIndex + query.length + SEARCH_SNIPPET_RADIUS);
  const snippet = rawContent.slice(start, end).replace(/\s+/g, " ").trim();

  const lines = rawContent.split(/\r?\n/);
  let consumed = 0;
  let matchLineIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = consumed + lines[i].length;
    if (matchIndex <= lineEnd) {
      matchLineIndex = i;
      break;
    }
    consumed = lineEnd + 1;
  }

  let speaker: string | undefined;
  let timestamp: string | undefined;
  for (let i = matchLineIndex; i >= 0 && i >= matchLineIndex - 3; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!timestamp) {
      timestamp = line.match(/\d{2}:\d{2}:\d{2}(?:\.\d{3})?/)?.[0];
    }
    if (!speaker) {
      speaker = line.match(/^(说话人\s*\d+)/)?.[1];
    }
    if (speaker || timestamp) break;
  }

  return {
    ...(speaker ? { speaker } : {}),
    ...(timestamp ? { timestamp } : {}),
    snippet,
  };
}

function buildWhyMatched(params: {
  summaryTitleMatch: boolean;
  summaryTextMatch: boolean;
  transcriptTitleMatch: boolean;
  transcriptTextMatch: boolean;
  matchSources: Set<SearchMatchSource>;
}): string {
  if (params.summaryTextMatch && params.transcriptTextMatch) {
    return "关键词同时命中 AI 摘要和文字记录原文";
  }
  if (params.summaryTextMatch) return "关键词命中 AI 摘要";
  if (params.transcriptTextMatch) return "关键词命中文字记录原文";
  if (params.summaryTitleMatch && params.transcriptTitleMatch) {
    return "关键词同时命中智能纪要和文字记录标题";
  }
  if (params.summaryTitleMatch) return "关键词命中智能纪要标题";
  if (params.transcriptTitleMatch) return "关键词命中文字记录标题";
  if (params.matchSources.has("summary") && params.matchSources.has("transcript")) {
    return "飞书搜索同时命中智能纪要和文字记录文档";
  }
  if (params.matchSources.has("summary")) return "飞书搜索命中智能纪要文档";
  return "飞书搜索命中文字记录文档";
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

  const results: MinuteInfo[] = [];
  const errors: string[] = [];
  for (const doc of recentDocs) {
    try {
      const minuteTokens = await extractMinuteTokensFromDoc(
        client,
        doc.docs_token,
        userToken.access_token,
      );

      if (minuteTokens.length > 0) {
        for (const mt of minuteTokens) {
          const info = await getMinuteInfo(client, mt, userToken.access_token);
          if (info) {
            info.doc_token = doc.docs_token;
            info.doc_title = doc.title;
            results.push(info);
          } else {
            // minutes.get failed (403 etc.) — still return docx-based info
            results.push(docxFallbackInfo(doc, mt));
          }
        }
      } else {
        // No minute_token in docx blocks — still discoverable via docx
        results.push(docxFallbackInfo(doc));
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
    tip: "Use get action with minute_token or doc_token to read AI summary. Use transcript action with minute_token for full transcript.",
  };
}

async function getMinute(
  client: Lark.Client,
  userToken: FeishuUserToken,
  minuteToken?: string,
  docToken?: string,
): Promise<unknown> {
  let info: MinuteInfo | null = null;
  if (minuteToken && !minuteToken.startsWith("doc:")) {
    info = await getMinuteInfo(client, minuteToken, userToken.access_token);
  }

  let aiSummary: string | null = null;
  if (docToken) {
    aiSummary = await getAiSummary(client, docToken, userToken.access_token);
  }

  if (!info && !aiSummary) {
    return { error: "minute_token or doc_token required. Could not retrieve any data." };
  }

  return {
    ...(info ?? { minute_token: minuteToken ?? "unknown" }),
    ...(docToken ? { doc_token: docToken } : {}),
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
  const candidates = new Map<string, SearchCandidate>();
  const warnings: string[] = [];
  let pagesScanned = 0;
  let docsScanned = 0;
  let rank = 0;

  for (const offset of SEARCH_PAGE_OFFSETS) {
    const page = await searchMinutesDocsPage(
      userToken.access_token,
      query,
      SEARCH_PAGE_SIZE,
      offset,
    );
    pagesScanned += 1;
    docsScanned += page.docs.length;

    const pendingTranscriptDocs: Array<{ doc: DriveSearchDoc; rank: number }> = [];
    for (const doc of page.docs) {
      const docKind = getMinutesDocKind(doc);
      if (!docKind) continue;

      const currentRank = rank++;
      if (docKind === "summary") {
        addSearchCandidate(candidates, {
          smart_doc_token: doc.docs_token,
          smart_doc_title: doc.title,
          owner_id: doc.owner_id,
          rank: currentRank,
          source: "summary",
        });
        continue;
      }

      pendingTranscriptDocs.push({ doc, rank: currentRank });
    }

    for (const item of pendingTranscriptDocs) {
      if (candidates.size >= SEARCH_MAX_CANDIDATES) break;
      const linkedToken = await extractLinkedSmartMinutesDocToken(
        client,
        item.doc.docs_token,
        userToken.access_token,
      );
      if (!linkedToken) {
        warnings.push(`${item.doc.title}: linked smart minutes doc not found`);
        continue;
      }
      addSearchCandidate(candidates, {
        smart_doc_token: linkedToken,
        smart_doc_title: item.doc.title.replace("文字记录", "智能纪要"),
        owner_id: item.doc.owner_id,
        rank: item.rank,
        source: "transcript",
        text_record_doc_token: item.doc.docs_token,
        text_record_doc_title: item.doc.title,
      });
    }

    if (candidates.size >= SEARCH_MAX_CANDIDATES) break;
    if (!page.hasMore || page.docs.length < SEARCH_PAGE_SIZE) break;
  }

  const orderedCandidates = [...candidates.values()]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, SEARCH_MAX_RESULTS);

  const seenMinuteTokens = new Set<string>();
  const results: SearchResult[] = [];

  for (const candidate of orderedCandidates) {
    const minuteTokens = await extractMinuteTokensFromDoc(
      client,
      candidate.smart_doc_token,
      userToken.access_token,
    );

    // Read AI summary regardless of whether we found a minute_token
    const aiSummary = await getAiSummary(client, candidate.smart_doc_token, userToken.access_token);
    const summaryTitleMatch = includesQuery(candidate.smart_doc_title, query);
    const summaryTextMatch = includesQuery(aiSummary, query);

    let transcriptTitleMatch = false;
    let transcriptTextMatch = false;
    let transcriptSnippet: SearchTranscriptSnippet | null = null;

    if (candidate.match_sources.has("transcript") && candidate.text_record_doc_token) {
      const recordRawContent = await getDocxRawContent(
        client,
        candidate.text_record_doc_token,
        userToken.access_token,
      );
      transcriptTitleMatch = includesQuery(candidate.text_record_doc_title, query);
      transcriptTextMatch = includesQuery(recordRawContent, query);
      if (!summaryTextMatch && transcriptTextMatch && recordRawContent) {
        transcriptSnippet = buildTranscriptSnippet(recordRawContent, query);
      }
    }

    const whyMatched = buildWhyMatched({
      summaryTitleMatch,
      summaryTextMatch,
      transcriptTitleMatch,
      transcriptTextMatch,
      matchSources: candidate.match_sources,
    });

    if (minuteTokens.length > 0) {
      for (const minuteToken of minuteTokens) {
        if (seenMinuteTokens.has(minuteToken)) continue;
        seenMinuteTokens.add(minuteToken);

        const info = await getMinuteInfo(client, minuteToken, userToken.access_token);
        const base =
          info ??
          docxFallbackInfo(
            {
              docs_token: candidate.smart_doc_token,
              docs_type: "docx",
              title: candidate.smart_doc_title,
              owner_id: candidate.owner_id,
            },
            minuteToken,
          );
        results.push({
          ...base,
          doc_token: candidate.smart_doc_token,
          doc_title: candidate.smart_doc_title,
          ai_summary: aiSummary,
          match_sources: orderedMatchSources(candidate.match_sources),
          why_matched: whyMatched,
          ...(transcriptSnippet ? { transcript_snippets: [transcriptSnippet] } : {}),
        });
      }
    } else {
      // No minute_token in docx blocks — still return docx-based result
      const syntheticKey = `doc:${candidate.smart_doc_token}`;
      if (!seenMinuteTokens.has(syntheticKey)) {
        seenMinuteTokens.add(syntheticKey);
        const base = docxFallbackInfo({
          docs_token: candidate.smart_doc_token,
          docs_type: "docx",
          title: candidate.smart_doc_title,
          owner_id: candidate.owner_id,
        });
        results.push({
          ...base,
          doc_token: candidate.smart_doc_token,
          doc_title: candidate.smart_doc_title,
          ai_summary: aiSummary,
          match_sources: orderedMatchSources(candidate.match_sources),
          why_matched: whyMatched,
          ...(transcriptSnippet ? { transcript_snippets: [transcriptSnippet] } : {}),
        });
      }
    }
  }

  return {
    query,
    results,
    count: results.length,
    scan_stats: {
      pages_scanned: pagesScanned,
      docs_scanned: docsScanned,
      minute_candidates: candidates.size,
      results_enriched: results.length,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
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
              if (!params.minute_token && !params.doc_token) {
                return json({
                  error: "minute_token or doc_token is required for get action.",
                });
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
