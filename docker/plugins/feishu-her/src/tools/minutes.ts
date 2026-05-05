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
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import {
  callFeishuApiWithUserToken,
  getValidUserToken,
  handleFeishuTokenError,
  requireUserToken,
  resolveOAuthRedirectUri,
  type FeishuUserToken,
} from "../oauth.js";
import { getFeishuClient } from "../outbound.js";
import { getOAuthDirectSender } from "./oauth-direct.js";

// ── Schema ──

const MINUTES_ACTIONS = ["list", "get", "transcript", "search"] as const;

const FeishuMinutesSchema = Type.Object({
  action: stringEnum(MINUTES_ACTIONS, {
    description:
      "list: discover recent meeting minutes (default 7 days). " +
      "get: get minute details + AI summary by minute_token. " +
      "transcript: get full transcript by minute_token or doc_token. " +
      "search: search minutes by keyword.",
  }),
  minute_token: Type.Optional(
    Type.String({
      description: "Minute token (e.g. obcnXXXX). Required for get/transcript actions.",
    }),
  ),
  doc_token: Type.Optional(
    Type.String({
      description:
        "Document token of the 智能纪要 docx. Used by get action to read AI summary, " +
        "and by transcript action as fallback when minutes API is unavailable.",
    }),
  ),
  query: Type.Optional(Type.String({ description: "Search keyword for search action." })),
  days: Type.Optional(
    Type.Number({
      description: "Time range in days for list action (default 30, max 30).",
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
    throw new Error(`Drive search error: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
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
    if (res.code !== 0) {break;}

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

// ── Combined blocks scan: extract minute tokens + linked docx in one pass ──

type DocxLinksResult = {
  minuteTokens: string[];
  linkedDocToken: string | null;
};

async function extractDocxLinks(
  client: Lark.Client,
  docToken: string,
  userAccessToken: string,
): Promise<DocxLinksResult> {
  const minuteTokens = new Set<string>();
  let linkedDocToken: string | null = null;
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
    if (res.code !== 0) {break;}

    const blocks = res.data?.items ?? [];
    for (const block of blocks) {
      const blockJson = JSON.stringify(block);
      let match: RegExpExecArray | null;
      MINUTES_URL_PATTERN.lastIndex = 0;
      while ((match = MINUTES_URL_PATTERN.exec(blockJson)) !== null) {
        minuteTokens.add(match[1]);
      }
      if (!linkedDocToken) {
        DOCX_URL_PATTERN.lastIndex = 0;
        while ((match = DOCX_URL_PATTERN.exec(blockJson)) !== null) {
          if (match[1] !== docToken) {
            linkedDocToken = match[1];
            break;
          }
        }
      }
    }
    pageToken = res.data?.has_more ? res.data.page_token : undefined;
  } while (pageToken);

  return { minuteTokens: [...minuteTokens], linkedDocToken };
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
    if (res.code !== 0) {return null;}

    for (const block of res.data?.items ?? []) {
      const blockJson = JSON.stringify(block);
      let match: RegExpExecArray | null;
      DOCX_URL_PATTERN.lastIndex = 0;
      while ((match = DOCX_URL_PATTERN.exec(blockJson)) !== null) {
        if (match[1] !== docToken) {return match[1];}
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
  text_record_doc_token?: string;
  has_ai_summary?: boolean;
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
    if (res.code !== 0) {return null;}
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
    if (!res) {return null;}
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
    if (res.code !== 0) {return null;}
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

// ── Calendar + VC recording discovery ──
// Primary discovery: calendar events → VC meeting_no → recording URL → minute_token.
// This finds ALL meetings the user participated in, not just those in their Drive space.

const MINUTES_TOKEN_FROM_URL = /\/minutes\/(obcn[a-zA-Z0-9]+)/;
const MEETING_NO_FROM_URL = /\/j\/(\d+)/;

type CalendarEvent = {
  summary: string;
  start_time?: { timestamp?: string };
  end_time?: { timestamp?: string };
  vchat?: { vc_type?: string; meeting_url?: string };
};

async function listUserCalendars(
  userToken: string,
): Promise<Array<{ calendar_id: string; type: string; role: string }>> {
  const res = await callFeishuApiWithUserToken<{
    calendar_list?: Array<{ calendar_id: string; type: string; role: string }>;
  }>({ method: "GET", endpoint: "/calendar/v4/calendars", userToken });
  if (res.code !== 0) {return [];}
  return res.data?.calendar_list ?? [];
}

async function listCalendarEvents(
  userToken: string,
  calendarId: string,
  startTime: number,
  endTime: number,
): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;

  do {
    const query: Record<string, string> = {
      start_time: String(startTime),
      end_time: String(endTime),
      page_size: "50",
    };
    if (pageToken) {query.page_token = pageToken;}

    const res = await callFeishuApiWithUserToken<{
      items?: CalendarEvent[];
      page_token?: string;
      has_more?: boolean;
    }>({
      method: "GET",
      endpoint: `/calendar/v4/calendars/${calendarId}/events`,
      userToken,
      query,
    });
    if (res.code !== 0) {break;}
    events.push(...(res.data?.items ?? []));
    pageToken = res.data?.has_more ? res.data.page_token : undefined;
  } while (pageToken);

  return events;
}

// One meeting_no can map to multiple sessions (same VC room reused).
async function getMeetingIdsByNo(
  userToken: string,
  meetingNo: string,
  startTime: number,
  endTime: number,
  log?: (msg: string) => void,
): Promise<string[]> {
  const res = await callFeishuApiWithUserToken<{
    meeting_briefs?: Array<{ id: string; meeting_no: string; topic: string }>;
  }>({
    method: "GET",
    endpoint: "/vc/v1/meetings/list_by_no",
    userToken,
    query: {
      meeting_no: meetingNo,
      start_time: String(startTime),
      end_time: String(endTime),
    },
  });
  if (res.code !== 0) {
    log?.(
      `[calendar-discovery] list_by_no meetingNo=${meetingNo} FAILED: code=${res.code} msg=${res.msg}`,
    );
    return [];
  }
  if (!res.data?.meeting_briefs?.length) {return [];}
  return res.data.meeting_briefs.map((b) => b.id);
}

async function getMeetingRecordingUrl(
  userToken: string,
  meetingId: string,
  log?: (msg: string) => void,
): Promise<string | null> {
  const res = await callFeishuApiWithUserToken<{
    recording?: { url?: string; duration?: string };
  }>({
    method: "GET",
    endpoint: `/vc/v1/meetings/${meetingId}/recording`,
    userToken,
  });
  if (res.code !== 0) {
    log?.(
      `[calendar-discovery] recording meetingId=${meetingId} FAILED: code=${res.code} msg=${res.msg}`,
    );
    return null;
  }
  return res.data?.recording?.url ?? null;
}

/**
 * Discover minutes via Calendar → VC meeting → recording URL → minute_token.
 * This path finds meetings regardless of who created them.
 */
async function discoverViaCalendar(
  client: Lark.Client,
  userToken: FeishuUserToken,
  days: number,
  log?: (msg: string) => void,
): Promise<MinuteInfo[]> {
  const _log = log ?? (() => {});
  const calendars = await listUserCalendars(userToken.access_token);
  _log(`[calendar-discovery] calendars found: ${calendars.length}`);
  const primaryCal = calendars.find((c) => c.type === "primary" && c.role === "owner");
  if (!primaryCal) {
    _log("[calendar-discovery] no primary calendar found — aborting");
    return [];
  }
  _log(`[calendar-discovery] primary calendar: ${primaryCal.calendar_id}`);

  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - days * 86400;
  const events = await listCalendarEvents(
    userToken.access_token,
    primaryCal.calendar_id,
    startTime,
    endTime,
  );
  _log(`[calendar-discovery] events in range: ${events.length}`);

  const vcMeetings = events.filter((e) => e.vchat?.meeting_url && e.summary);
  _log(`[calendar-discovery] VC meetings with URL: ${vcMeetings.length}`);

  const results: MinuteInfo[] = [];
  const seen = new Set<string>();
  for (const meeting of vcMeetings) {
    try {
      const meetingNo = meeting.vchat!.meeting_url!.match(MEETING_NO_FROM_URL)?.[1];
      if (!meetingNo) {continue;}

      const eventStart = Number(meeting.start_time?.timestamp ?? startTime);
      const lookupStart = eventStart - 86400;
      const lookupEnd = eventStart + 86400;

      const meetingIds = await getMeetingIdsByNo(
        userToken.access_token,
        meetingNo,
        lookupStart,
        lookupEnd,
        log,
      );
      _log(
        `[calendar-discovery] "${meeting.summary}" meetingNo=${meetingNo} → ${meetingIds.length} session(s)`,
      );

      for (const meetingId of meetingIds) {
        const recordingUrl = await getMeetingRecordingUrl(userToken.access_token, meetingId, log);
        if (!recordingUrl) {
          _log(`[calendar-discovery]   meetingId=${meetingId} → no recording`);
          continue;
        }

        const minuteToken = recordingUrl.match(MINUTES_TOKEN_FROM_URL)?.[1];
        if (!minuteToken || seen.has(minuteToken)) {continue;}
        seen.add(minuteToken);
        _log(`[calendar-discovery]   → minute_token=${minuteToken}`);

        const info = await getMinuteInfo(client, minuteToken, userToken.access_token);
        if (info) {
          results.push(info);
        } else {
          results.push({
            minute_token: minuteToken,
            title: meeting.summary,
            url: recordingUrl,
            create_time: meeting.start_time?.timestamp
              ? String(Number(meeting.start_time.timestamp) * 1000)
              : undefined,
          });
        }
      }
    } catch (err) {
      _log(
        `[calendar-discovery] "${meeting.summary}" error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  _log(`[calendar-discovery] total minutes found: ${results.length}`);
  return results;
}

// ── Actions ──

/** Parse date from smart minutes title like "智能纪要：XXX 2026年3月4日" */
function parseDateFromTitle(title: string): Date | null {
  const m = title.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) {return null;}
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
  if (!isDocxType(doc.docs_type)) {return null;}
  if (doc.title.startsWith("智能纪要")) {return "summary";}
  if (doc.title.startsWith("文字记录")) {return "transcript";}
  return null;
}

function includesQuery(text: string | null | undefined, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!text || !normalizedQuery) {return false;}
  return text.toLowerCase().includes(normalizedQuery);
}

function orderedMatchSources(matchSources: Set<SearchMatchSource>): SearchMatchSource[] {
  const ordered: SearchMatchSource[] = [];
  if (matchSources.has("summary")) {ordered.push("summary");}
  if (matchSources.has("transcript")) {ordered.push("transcript");}
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
  if (!normalizedQuery) {return null;}

  const matchIndex = rawContent.toLowerCase().indexOf(normalizedQuery);
  if (matchIndex === -1) {return null;}

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
    if (!line) {continue;}
    if (!timestamp) {
      timestamp = line.match(/\d{2}:\d{2}:\d{2}(?:\.\d{3})?/)?.[0];
    }
    if (!speaker) {
      speaker = line.match(/^(说话人\s*\d+)/)?.[1];
    }
    if (speaker || timestamp) {break;}
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
  if (params.summaryTextMatch) {return "关键词命中 AI 摘要";}
  if (params.transcriptTextMatch) {return "关键词命中文字记录原文";}
  if (params.summaryTitleMatch && params.transcriptTitleMatch) {
    return "关键词同时命中智能纪要和文字记录标题";
  }
  if (params.summaryTitleMatch) {return "关键词命中智能纪要标题";}
  if (params.transcriptTitleMatch) {return "关键词命中文字记录标题";}
  if (params.matchSources.has("summary") && params.matchSources.has("transcript")) {
    return "飞书搜索同时命中智能纪要和文字记录文档";
  }
  if (params.matchSources.has("summary")) {return "飞书搜索命中智能纪要文档";}
  return "飞书搜索命中文字记录文档";
}

async function listMinutes(
  client: Lark.Client,
  userToken: FeishuUserToken,
  days: number,
  log?: (msg: string) => void,
): Promise<unknown> {
  const _log = log ?? (() => {});
  // ── Path A: Drive Search (finds docs in user's own Drive space) ──
  const driveResults: MinuteInfo[] = [];
  const errors: string[] = [];

  try {
    const docs = await searchSmartMinutesDocs(userToken.access_token, "智能纪要", 50);
    _log(`[minutes] Drive search returned ${docs.length} docs`);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    cutoff.setHours(0, 0, 0, 0);
    const recentDocs = docs.filter((d) => {
      if (!d.title.startsWith("智能纪要")) {return false;}
      const date = parseDateFromTitle(d.title);
      return date ? date >= cutoff : true;
    });
    _log(`[minutes] recent "智能纪要" docs (${days}d): ${recentDocs.length}`);

    for (const doc of recentDocs) {
      try {
        const { minuteTokens, linkedDocToken } = await extractDocxLinks(
          client,
          doc.docs_token,
          userToken.access_token,
        );
        // Docx-primary: build info from docx metadata directly (no minute.get call).
        // minute.get consistently returns 403/2091005 on production apps.
        const mt = minuteTokens[0];
        const info = docxFallbackInfo(doc, mt);
        if (linkedDocToken) {info.text_record_doc_token = linkedDocToken;}
        if (mt) {info.url = `https://meetings.feishu.cn/minutes/${mt}`;}
        driveResults.push(info);
      } catch (err) {
        errors.push(`${doc.title}: ${err instanceof Error ? err.message : String(err)}`);
        driveResults.push(docxFallbackInfo(doc));
      }
    }
  } catch (err) {
    errors.push(`Drive search: ${err instanceof Error ? err.message : String(err)}`);
  }

  _log(`[minutes] Drive path found ${driveResults.length} minutes`);

  // ── Path B: Calendar + VC recording (finds ALL meetings the user attended) ──
  let calendarResults: MinuteInfo[] = [];
  try {
    calendarResults = await discoverViaCalendar(client, userToken, days, log);
  } catch (err) {
    const msg = `Calendar discovery: ${err instanceof Error ? err.message : String(err)}`;
    _log(`[minutes] ${msg}`);
    errors.push(msg);
  }

  _log(
    `[minutes] Calendar path found ${calendarResults.length} minutes — merging with ${driveResults.length} from Drive`,
  );

  // ── Merge & deduplicate (prefer Drive results which carry doc_token) ──
  const seen = new Set<string>();
  const merged: MinuteInfo[] = [];
  for (const r of driveResults) {
    if (!seen.has(r.minute_token)) {
      seen.add(r.minute_token);
      r.has_ai_summary = Boolean(r.doc_token);
      merged.push(r);
    }
  }
  for (const r of calendarResults) {
    if (!seen.has(r.minute_token)) {
      seen.add(r.minute_token);
      r.has_ai_summary = Boolean(r.doc_token);
      merged.push(r);
    }
  }
  _log(`[minutes] merged total: ${merged.length}`);

  return {
    minutes: merged,
    count: merged.length,
    days,
    discovery: {
      drive_search: driveResults.length,
      calendar_vc: calendarResults.length,
    },
    ...(errors.length > 0 ? { warnings: errors } : {}),
    tip: "Use get action with minute_token or doc_token to read AI summary. Use transcript action with minute_token or doc_token for full transcript.",
  };
}

async function getMinute(
  client: Lark.Client,
  userToken: FeishuUserToken,
  minuteToken?: string,
  docToken?: string,
): Promise<unknown> {
  // ── Docx-primary: resolve doc_token first ──
  let resolvedDocToken = docToken ?? null;

  // If no doc_token, try minutes API directly (no Drive search — title matching is unreliable)
  if (!resolvedDocToken && minuteToken && !minuteToken.startsWith("doc:")) {
    const info = await getMinuteInfo(client, minuteToken, userToken.access_token);
    if (info) {
      return {
        ...info,
        ai_summary: null,
        has_ai_summary: false,
        tip: "Pass doc_token (from list results) to get the AI summary.",
      };
    }
  }

  // ── Docx path: build metadata + read AI summary ──
  let title: string | undefined;
  let docTitle: string | undefined;
  if (resolvedDocToken) {
    try {
      // oxlint-disable-next-line typescript/no-explicit-any
      const docRes: any = await client.docx.document.get(
        { path: { document_id: resolvedDocToken } },
        Lark.withUserAccessToken(userToken.access_token),
      );
      if (docRes.code === 0 && docRes.data?.document?.title) {
        docTitle = docRes.data.document.title as string;
        title = parseMeetingNameFromTitle(docTitle);
      }
    } catch {
      // best-effort
    }
  }

  let aiSummary: string | null = null;
  if (resolvedDocToken) {
    aiSummary = await getAiSummary(client, resolvedDocToken, userToken.access_token);
  }

  if (!title && !aiSummary) {
    return { error: "minute_token or doc_token required. Could not retrieve any data." };
  }

  const date = docTitle ? parseDateFromTitle(docTitle) : null;
  return {
    minute_token: minuteToken ?? `doc:${resolvedDocToken}`,
    title,
    ...(resolvedDocToken ? { doc_token: resolvedDocToken } : {}),
    ...(docTitle ? { doc_title: docTitle } : {}),
    ...(date ? { create_time: String(date.getTime()) } : {}),
    ai_summary: aiSummary,
    ...(aiSummary ? {} : { has_ai_summary: false }),
  };
}

async function getMinuteTranscript(
  client: Lark.Client,
  userToken: FeishuUserToken,
  minuteToken?: string,
  docToken?: string,
): Promise<unknown> {
  // ── Docx-primary: read "文字记录" docx directly ──
  if (docToken) {
    let textRecordDocToken: string | null = null;
    try {
      textRecordDocToken = await extractLinkedSmartMinutesDocToken(
        client,
        docToken,
        userToken.access_token,
      );
    } catch {
      // best-effort
    }

    if (textRecordDocToken) {
      const docxTranscript = await getDocxRawContent(
        client,
        textRecordDocToken,
        userToken.access_token,
      );
      if (docxTranscript) {
        let title: string | undefined;
        try {
          // oxlint-disable-next-line typescript/no-explicit-any
          const docRes: any = await client.docx.document.get(
            { path: { document_id: docToken } },
            Lark.withUserAccessToken(userToken.access_token),
          );
          if (docRes.code === 0 && docRes.data?.document?.title) {
            title = parseMeetingNameFromTitle(docRes.data.document.title as string);
          }
        } catch {
          // best-effort
        }
        return {
          minute_token: minuteToken ?? `doc:${docToken}`,
          title,
          transcript: docxTranscript,
          text_record_doc_token: textRecordDocToken,
        };
      }
    }
  }

  // ── Fallback: minutes.v1 API (for calendar-only discoveries without doc_token) ──
  if (minuteToken && !minuteToken.startsWith("doc:")) {
    const info = await getMinuteInfo(client, minuteToken, userToken.access_token);
    if (info) {
      const transcript = await getTranscript(client, minuteToken, userToken.access_token);
      if (transcript) {
        return { minute_token: minuteToken, title: info.title, transcript };
      }
    }
  }

  return {
    error: `Could not retrieve transcript. ${docToken ? "No linked 文字记录 docx found." : "Provide doc_token of the 智能纪要 docx."}`,
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
      if (!docKind) {continue;}

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
      if (candidates.size >= SEARCH_MAX_CANDIDATES) {break;}
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

    if (candidates.size >= SEARCH_MAX_CANDIDATES) {break;}
    if (!page.hasMore || page.docs.length < SEARCH_PAGE_SIZE) {break;}
  }

  const orderedCandidates = [...candidates.values()]
    .toSorted((a, b) => a.rank - b.rank)
    .slice(0, SEARCH_MAX_RESULTS);

  const seenMinuteTokens = new Set<string>();
  const results: SearchResult[] = [];

  for (const candidate of orderedCandidates) {
    let minuteTokens: string[] = [];
    try {
      minuteTokens = await extractMinuteTokensFromDoc(
        client,
        candidate.smart_doc_token,
        userToken.access_token,
      );
    } catch {
      // documentBlock.list may throw 403/404 — continue with empty tokens (fallback below)
    }

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
        if (seenMinuteTokens.has(minuteToken)) {continue;}
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
  if (accounts.length === 0) {return;}
  const firstAccount: ResolvedFeishuAccount = accounts[0];
  const getClient = () => getFeishuClient(firstAccount);
  const redirectUri = resolveOAuthRedirectUri(api.config as Record<string, unknown>);

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
          const guard = await requireUserToken({
            account: firstAccount,
            redirectUri,
            tokenPromise: getValidUserToken(firstAccount),
            toolLabel: "飞书妙记",
            sendDirectToUser: getOAuthDirectSender(firstAccount),
          });
          if (!guard.ok) {return guard.authResponse;}
          const userToken = guard.token;

          const client = getClient();

          const toolLog = (msg: string) => api.logger.info?.(msg);

          switch (params.action) {
            case "list": {
              const days = Math.min(Math.max(params.days ?? 30, 1), 30);
              return json(await listMinutes(client, userToken, days, toolLog));
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
              if (!params.minute_token && !params.doc_token) {
                return json({
                  error: "minute_token or doc_token is required for transcript action.",
                });
              }
              return json(
                await getMinuteTranscript(client, userToken, params.minute_token, params.doc_token),
              );
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
          const authResp = await handleFeishuTokenError(err, firstAccount, redirectUri, getOAuthDirectSender(firstAccount));
          const message = err instanceof Error ? err.message : String(err);
          if (authResp) {return authResp;}

          return json({ error: message });
        }
      },
    },
    { name: "feishu_minutes" },
  );
  api.logger.info?.("feishu: registered feishu_minutes tool");
}
