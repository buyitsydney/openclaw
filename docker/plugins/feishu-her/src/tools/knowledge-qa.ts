/**
 * Feishu Knowledge QA tool — AI-powered semantic search across all Feishu knowledge sources.
 *
 * Covers: cloud docs, wiki, messages (private + group), minutes, comments, lingo, helpdesk FAQ.
 * Uses the /search/v2/knowledge_qa/ API family (requires user_access_token + search:knowledge_qa:read scope).
 *
 * IMPORTANT: Both endpoints return FLAT JSON (no {code,msg,data} wrapper despite what docs say).
 * /answer needs 20-60s for DeepSeek inference. Must use native fetch with long timeout.
 *
 * Two actions:
 *   search: semantic vector search returning passages with scores (fast, ~3s)
 *   ask:    AI-generated answer with references (slow, 20-60s)
 *
 * Her can control which sources to search via the `sources` parameter,
 * and filter messages by chat_ids / time_range.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import {
  getValidUserToken,
  handleFeishuTokenError,
  requireUserToken,
  resolveOAuthRedirectUri,
} from "../oauth.js";
import { getOAuthDirectSender } from "./oauth-direct.js";
import { toUnixSeconds } from "./time-utils.js";

// ── Schema ──

const ACTIONS = ["search", "ask"] as const;
const KNOWLEDGE_SCOPES = ["enterprise", "internet", "llm", "hybrid"] as const;
const MODEL_TYPES = ["deepseek", "doubao", "doubao_thinking", "doubao_auto_thinking"] as const;
const SOURCE_NAMES = [
  "space",
  "wiki",
  "message",
  "minutes",
  "comment",
  "lingo",
  "helpdesk_faq",
] as const;

const FeishuKnowledgeQASchema = Type.Object({
  action: Type.Optional(
    stringEnum(ACTIONS, {
      description:
        "search (default, ~3s): semantic vector search returning passages with scores. " +
        "ask (20-60s, use sparingly): AI-generated answer — only when search+reading is insufficient.",
    }),
  ),
  query: Type.String({
    description:
      "Natural language question (1-1000 chars). Be specific — include names, group names, topics.",
  }),
  sources: Type.Optional(
    Type.Array(stringEnum(SOURCE_NAMES), {
      description:
        "Which sources to search. Default: all. Options: space (cloud docs), wiki, message (private+group chats), " +
        "minutes (meeting transcripts), comment (doc comments), lingo (dictionary), helpdesk_faq. " +
        "Narrow sources to reduce noise — e.g. ['wiki','space'] for docs only, ['message'] for chats only.",
    }),
  ),
  chat_ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Filter messages to specific chat IDs (max 100). Only applies when message source is enabled.",
    }),
  ),
  time_start: Type.Optional(
    Type.String({
      description:
        "Message time range start (ISO 8601, e.g. 2026-03-17T00:00:00+08:00). Only applies to message source.",
    }),
  ),
  time_end: Type.Optional(
    Type.String({
      description:
        "Message time range end (ISO 8601, e.g. 2026-03-19T23:59:59+08:00). Only applies to message source.",
    }),
  ),
  knowledge_scope: Type.Optional(
    stringEnum(KNOWLEDGE_SCOPES, {
      description: "Only for ask action. enterprise (default), internet, llm, hybrid.",
    }),
  ),
  model_type: Type.Optional(
    stringEnum(MODEL_TYPES, {
      description:
        "Only for ask action. deepseek (default), doubao, doubao_thinking, doubao_auto_thinking.",
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

const SOURCE_TYPE_LABELS: Record<number, string> = {
  1: "helpdesk_faq",
  2: "wiki",
  3: "cloud_doc",
  5: "lingo",
  6: "message",
  7: "comment",
  8: "minutes",
  9: "mail",
};

// oxlint-disable-next-line typescript/no-explicit-any
type Params = Record<string, any>;

/**
 * Build enterprise_knowledge_source from params.
 * If sources not specified, enable all. Otherwise only enable requested sources.
 * Supports message filter: chat_ids, time_range.
 */
function buildSourcesParam(params: Params): Record<string, unknown> {
  const sources: string[] | undefined = params.sources;
  const all = !sources || sources.length === 0;

  const result: Record<string, unknown> = {};

  // space (cloud docs)
  if (all || sources?.includes("space")) {
    result.space = { searchable: true };
  }

  // wiki
  if (all || sources?.includes("wiki")) {
    result.wiki = { searchable: true };
  }

  // message — with optional filter
  if (all || sources?.includes("message")) {
    // oxlint-disable-next-line typescript/no-explicit-any
    const msg: Record<string, any> = { searchable: true };
    const filter: Record<string, unknown> = {};

    if (params.chat_ids?.length) {
      filter.chat_ids = params.chat_ids;
    }
    if (params.time_start || params.time_end) {
      const timeRange: Record<string, number> = {};
      if (params.time_start) {timeRange.start = toUnixSeconds(params.time_start);}
      if (params.time_end) {timeRange.end = toUnixSeconds(params.time_end);}
      filter.time_range = timeRange;
    }
    if (Object.keys(filter).length > 0) {
      msg.filter = filter;
    }
    result.message = msg;
  }

  // minutes
  if (all || sources?.includes("minutes")) {
    result.minutes = { searchable: true };
  }

  // comment
  if (all || sources?.includes("comment")) {
    result.comment = { wiki_searchable: true, space_searchable: true };
  }

  // lingo
  if (all || sources?.includes("lingo")) {
    result.lingo = { searchable: true };
  }

  // helpdesk_faq
  if (all || sources?.includes("helpdesk_faq")) {
    result.helpdesk_faq = { searchable: true };
  }

  return result;
}

type QualityLevel = "direct_answer" | "partial" | "no_answer" | "quota_exceeded" | "error";

function judgeQuality(code: number, answer?: string): QualityLevel {
  if (code === 1270002) {return "quota_exceeded";}
  if (code !== 0) {return "error";}
  if (!answer) {return "no_answer";}
  if (answer.startsWith("抱歉，在可访问的企业知识中未找到答案")) {return "partial";}
  if (answer === "找不到相关信息") {return "no_answer";}
  return "direct_answer";
}

// oxlint-disable-next-line typescript/no-explicit-any
function enrichRef(ref: any): Record<string, unknown> {
  return {
    ...ref,
    source_label: SOURCE_TYPE_LABELS[ref.source_type] ?? `unknown(${ref.source_type})`,
  };
}

// ── API calls (native fetch — API returns flat JSON) ──

const KQA_BASE = "https://open.feishu.cn/open-apis";
const KQA_TIMEOUT_MS = 90_000;

type KQAFlatResponse = {
  // /answer fields
  answer?: string;
  reasoning_content?: string;
  status_code?: number;
  status_message?: string;
  references?: {
    enterprise_refs?: Array<Record<string, unknown>>;
    internet_refs?: Array<Record<string, unknown>>;
  };
  // /search fields
  passages?: Array<Record<string, unknown>>;
  // common
  extra?: Record<string, unknown>;
  // only on auth errors
  code?: number;
  msg?: string;
  error?: Record<string, unknown>;
};

async function fetchKQA(
  userToken: string,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<KQAFlatResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KQA_TIMEOUT_MS);

  try {
    const res = await fetch(`${KQA_BASE}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();

    if (res.status === 403) {
      return {
        code: 99991679,
        msg: "OAuth token missing search:knowledge_qa:read scope. User needs to re-authorize.",
      };
    }
    if (res.status >= 400) {
      return { code: res.status, msg: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    try {
      return JSON.parse(text) as KQAFlatResponse;
    } catch {
      return { code: -1, msg: `Unexpected response format (status=${res.status}).` };
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        code: -1,
        msg: `Request timeout (${KQA_TIMEOUT_MS / 1000}s). Try a more specific question.`,
      };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Actions ──

/**
 * Ask via SSE streaming (/stream_answer). Collects all chunks until event=finished,
 * then returns the final accumulated result. SSE keeps the connection alive so no 504.
 *
 * Each SSE chunk is a JSON object:
 * { code, msg, id, event: "pending"|"finished"|"failed", data: { answer, reasoning_content, references, status_code } }
 */
async function askKnowledgeQA(userToken: string, params: Params): Promise<unknown> {
  const knowledgeScope = params.knowledge_scope ?? "enterprise";
  const modelType = params.model_type ?? "deepseek";
  const body: Record<string, unknown> = {
    query: params.query,
    knowledge_scope: knowledgeScope,
    model_type: modelType,
    extra: { locale: "zh-CN", timezone: "Asia/Shanghai" },
  };
  if (knowledgeScope === "enterprise" || knowledgeScope === "hybrid") {
    body.enterprise_knowledge_source = buildSourcesParam(params);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KQA_TIMEOUT_MS);

  try {
    const res = await fetch(`${KQA_BASE}/search/v2/knowledge_qa/stream_answer`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.status === 403) {
      return {
        quality: "error" as QualityLevel,
        error: "OAuth token missing search:knowledge_qa:read scope. User needs to re-authorize.",
        suggestion: "OAuth permission error. User needs to re-authorize.",
        answer: null,
        references: { enterprise: [], internet: [], total: 0 },
      };
    }
    if (res.status >= 400) {
      const text = await res.text();
      return {
        quality: "error" as QualityLevel,
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        suggestion: "Try search action or feishu_deep_search.",
        answer: null,
        references: { enterprise: [], internet: [], total: 0 },
      };
    }

    // Collect SSE chunks. Each line is BASE64-ENCODED JSON (not raw JSON!).
    // Decoded structure: { id, event, data: "<nested JSON string>" }
    // The inner `data` field is a JSON string that must be parsed again.
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.trim());

    let finalAnswer = "";
    let finalReasoning = "";
    // oxlint-disable-next-line typescript/no-explicit-any
    let finalRefs: any = {};
    let lastEvent = "";
    let errorCode = 0;
    let errorMsg = "";

    for (const line of lines) {
      try {
        // Step 1: base64 decode
        const decoded = Buffer.from(line, "base64").toString("utf-8");
        // Step 2: parse outer JSON
        const chunk = JSON.parse(decoded);
        // Auth error in stream
        if (chunk.code && chunk.code !== 0) {
          errorCode = chunk.code;
          errorMsg = chunk.msg ?? "";
          continue;
        }
        if (chunk.event) {lastEvent = chunk.event;}
        // Step 3: parse inner data (may be a JSON string or already an object)
        let d = chunk.data;
        if (typeof d === "string") {
          try {
            d = JSON.parse(d);
          } catch {
            d = null;
          }
        }
        if (d) {
          if (d.answer) {finalAnswer = d.answer;}
          if (d.reasoning_content) {finalReasoning = d.reasoning_content;}
          if (d.references) {finalRefs = d.references;}
        }
      } catch {
        // Try raw JSON parse as fallback (in case format changes)
        try {
          const chunk = JSON.parse(line);
          if (chunk.event) {lastEvent = chunk.event;}
          const d = chunk.data;
          if (d?.answer) {finalAnswer = d.answer;}
          if (d?.reasoning_content) {finalReasoning = d.reasoning_content;}
          if (d?.references) {finalRefs = d.references;}
        } catch {
          // skip unparseable lines
        }
      }
    }

    if (errorCode !== 0) {
      const quality = judgeQuality(errorCode, undefined);
      return {
        quality,
        error: errorMsg || `API error code=${errorCode}`,
        suggestion:
          quality === "quota_exceeded"
            ? "Daily quota exceeded. Use feishu_deep_search as fallback."
            : String(errorCode).includes("9999")
              ? "OAuth permission error. User needs to re-authorize."
              : "Try search action or feishu_deep_search.",
        answer: null,
        references: { enterprise: [], internet: [], total: 0 },
      };
    }

    if (lastEvent === "failed") {
      return {
        quality: "error" as QualityLevel,
        error: "Stream ended with failed event.",
        suggestion: "Try search action or feishu_deep_search.",
        answer: null,
        references: { enterprise: [], internet: [], total: 0 },
      };
    }

    const quality = judgeQuality(0, finalAnswer);
    const enterpriseRefs = (finalRefs.enterprise_refs ?? []).map(enrichRef);
    const internetRefs = finalRefs.internet_refs ?? [];

    return {
      quality,
      answer: finalAnswer || null,
      reasoning_content: finalReasoning || null,
      references: {
        enterprise: enterpriseRefs,
        internet: internetRefs,
        total: enterpriseRefs.length + internetRefs.length,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        quality: "error" as QualityLevel,
        error: `Request timeout (${KQA_TIMEOUT_MS / 1000}s). Try a more specific question.`,
        suggestion: "Try search action or feishu_deep_search.",
        answer: null,
        references: { enterprise: [], internet: [], total: 0 },
      };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function searchKnowledgeQA(userToken: string, params: Params): Promise<unknown> {
  // search endpoint only needs query + enterprise_knowledge_source (no knowledge_scope/model_type)
  const body: Record<string, unknown> = {
    query: params.query,
    enterprise_knowledge_source: buildSourcesParam(params),
  };

  const res = await fetchKQA(userToken, "/search/v2/knowledge_qa/search", body);

  if (res.code && res.code !== 0) {
    const quality = res.code === 1270002 ? "quota_exceeded" : "error";
    return {
      quality,
      error: res.msg || `API error code=${res.code}`,
      suggestion:
        quality === "quota_exceeded"
          ? "Daily quota exceeded. Use feishu_deep_search as fallback."
          : "Use feishu_deep_search as fallback.",
      passages: [],
    };
  }

  const passages = (res.passages ?? []).map(enrichRef);
  return {
    quality: passages.length > 0 ? "has_results" : "no_results",
    passages,
    count: passages.length,
  };
}

// ── Registration ──

export const KNOWLEDGE_QA_REQUIRED_SCOPE = "search:knowledge_qa:read";

export function registerFeishuKnowledgeQATool(api: OpenClawPluginApi): void {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {return;}
  const firstAccount: ResolvedFeishuAccount = accounts[0];
  const redirectUri = resolveOAuthRedirectUri(api.config as Record<string, unknown>);

  api.registerTool(
    {
      name: "feishu_knowledge_qa",
      label: "Feishu Knowledge QA",
      description:
        "Semantic search across Feishu knowledge: cloud docs, wiki, messages (private+group), " +
        "meeting minutes/transcripts, document comments, lingo dictionary, helpdesk FAQ. " +
        "Use 'sources' param to narrow scope and reduce noise. " +
        "search action (~3s) returns passages with scores; ask action (20-60s) returns AI answer. " +
        "Requires user OAuth (search:knowledge_qa:read scope).",
      parameters: FeishuKnowledgeQASchema,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        try {
          const guard = await requireUserToken({
            account: firstAccount,
            redirectUri,
            tokenPromise: getValidUserToken(firstAccount),
            toolLabel: "飞书知识问答",
            sendDirectToUser: getOAuthDirectSender(firstAccount),
          });
          if (!guard.ok) {return guard.authResponse;}
          const userToken = guard.token;

          const action = params.action ?? "search";

          let result: unknown;
          switch (action) {
            case "ask":
              result = await askKnowledgeQA(userToken.access_token, params);
              break;
            case "search":
              result = await searchKnowledgeQA(userToken.access_token, params);
              break;
            default:
              return json({ error: `Unknown action: ${action}` });
          }

          // If API returned a token error, delete token and return auth_url
          // so Her can prompt the user to re-authorize in this same response.
          // oxlint-disable-next-line typescript/no-explicit-any
          const r = result as any;
          if (
            r?.quality === "error" &&
            r?.error &&
            /9999|Unauthorized|expired/i.test(String(r.error))
          ) {
            handleFeishuTokenError(firstAccount);
            const reauth = await requireUserToken({
              account: firstAccount,
              redirectUri,
              tokenPromise: getValidUserToken(firstAccount),
              toolLabel: "飞书知识问答",
              sendDirectToUser: getOAuthDirectSender(firstAccount),
            });
            if (!reauth.ok) {return reauth.authResponse;}
          }

          return json(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (
            message.includes("99991677") ||
            message.includes("99991668") ||
            message.includes("99991679")
          ) {
            handleFeishuTokenError(firstAccount);
            // Return auth_url instead of raw error
            const reauth = await requireUserToken({
              account: firstAccount,
              redirectUri,
              tokenPromise: getValidUserToken(firstAccount),
              toolLabel: "飞书知识问答",
              sendDirectToUser: getOAuthDirectSender(firstAccount),
            });
            if (!reauth.ok) {return reauth.authResponse;}
          }
          return json({ error: message });
        }
      },
    },
    { name: "feishu_knowledge_qa" },
  );
  api.logger.info?.("feishu: registered feishu_knowledge_qa tool");
}
