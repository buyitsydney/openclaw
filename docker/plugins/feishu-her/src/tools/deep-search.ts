/**
 * feishu_deep_search — multi-source aggregated search across Drive, Wiki,
 * minutes, and local group archives. Accepts multiple keyword groups for
 * query-decomposition style recall, merges results, and returns a unified
 * ranked list with source tags.
 *
 * Designed to close the gap with Feishu's built-in "Knowledge Q&A" by
 * searching ALL available data sources in parallel.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import {
  getArchiveEntryDisplaySender,
  getArchiveEntryDisplayText,
  normalizeArchiveEntry,
  type GroupArchiveEntry,
} from "../group-archive.js";
import { syncGroupArchivesToMemory } from "../memory-bridge.js";
import {
  callFeishuApiWithUserToken,
  getValidUserToken,
  handleFeishuTokenError,
  requireUserToken,
  resolveOAuthRedirectUri,
} from "../oauth.js";
import { searchRootDriveItemsByTitle } from "./drive-browse.js";
import { resolveDriveShareUrl, type DriveDocType } from "./share-url.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ── Schema ──

const DeepSearchSchema = Type.Object({
  keywords: Type.Array(
    Type.String({ description: "A short keyword or keyword phrase (2-4 chars each)." }),
    {
      description:
        "Array of 2-4 keyword groups extracted from the user's question. " +
        "Each keyword should target a different angle (synonyms, Chinese/English, sub-topics). " +
        "Do NOT pass the user's full natural-language question — Feishu search is keyword-based.",
      minItems: 1,
      maxItems: 5,
    },
  ),
  include_minutes: Type.Optional(
    Type.Boolean({
      description:
        "Also search meeting minutes (妙记). Default true. " +
        "Set false to skip minutes when irrelevant.",
    }),
  ),
  include_group_archive: Type.Optional(
    Type.Boolean({
      description:
        "Also search local group chat archives. Default true. " +
        "Set false to skip group archives when irrelevant.",
    }),
  ),
  sync_archives_to_memory: Type.Optional(
    Type.Boolean({
      description:
        "Before searching, sync group chat archives to the memory directory " +
        "so memory_search can find them via semantic search. Default false. " +
        "Set true on the first deep search of a session, or when user asks " +
        "to search across all historical conversations.",
    }),
  ),
});

// ── Types ──

type DeepSearchResult = {
  source: "drive" | "wiki" | "minutes" | "group_archive";
  title: string;
  snippet?: string;
  url?: string;
  token?: string;
  extra?: Record<string, unknown>;
};

type DriveSearchEntity = {
  docs_token?: string;
  docs_type?: string;
  owner_id?: string;
  title?: string;
};

type DriveSearchResponse = {
  docs_entities?: DriveSearchEntity[];
  has_more?: boolean;
  total?: number;
};

type WikiSearchEntity = {
  node_id?: string;
  obj_token?: string;
  obj_type?: number | string;
  space_id?: string;
  title?: string;
  url?: string;
};

type WikiSearchResponse = {
  items?: WikiSearchEntity[];
  has_more?: boolean;
};

// ── Constants ──

const PER_KEYWORD_LIMIT = 5;
const DRIVE_DOC_TYPES_WITHOUT_BITABLE = ["doc", "docx", "sheet", "slides", "mindnote", "file"];
const ARCHIVE_MAX_MATCHES_PER_GROUP = 10;
const ARCHIVE_SNIPPET_RADIUS = 80;

// ── Feishu API helpers (reused patterns from search.ts) ──

function toDriveDocType(value: string): DriveDocType | null {
  switch (value) {
    case "wiki":
    case "doc":
    case "docx":
    case "sheet":
    case "bitable":
    case "mindnote":
    case "file":
    case "slides":
      return value;
    default:
      return null;
  }
}

async function searchDriveKeyword(
  account: ResolvedFeishuAccount,
  userToken: string,
  keyword: string,
): Promise<DeepSearchResult[]> {
  const res = await callFeishuApiWithUserToken<DriveSearchResponse>({
    method: "POST",
    endpoint: "/suite/docs-api/search/object",
    userToken,
    body: {
      search_key: keyword,
      count: PER_KEYWORD_LIMIT,
      offset: 0,
      owner_ids: [],
      docs_types: DRIVE_DOC_TYPES_WITHOUT_BITABLE,
    },
  });
  if (res.code !== 0) return [];

  const results: DeepSearchResult[] = [];
  for (const item of res.data?.docs_entities ?? []) {
    if (!item.docs_token || !item.title) continue;
    const docType = toDriveDocType(item.docs_type ?? "");
    let url: string | undefined;
    if (docType) {
      const resolved = await resolveDriveShareUrl(account, item.docs_token, docType, {
        userToken,
      });
      if (resolved.ok) url = resolved.share_url;
    }
    results.push({
      source: "drive",
      title: item.title.trim(),
      token: item.docs_token,
      url,
      extra: {
        object_type: item.docs_type,
        drive_doc_token: item.docs_token,
        keyword,
      },
    });
  }
  const rootFolders = await searchRootDriveItemsByTitle(userToken, keyword, {
    limit: PER_KEYWORD_LIMIT,
    types: ["folder"],
  });
  const seenTokens = new Set(
    results.map((item) => item.token).filter((item): item is string => !!item),
  );
  for (const folder of rootFolders) {
    if (seenTokens.has(folder.token)) continue;
    results.push({
      source: "drive",
      title: folder.name,
      token: folder.token,
      url: folder.url,
      extra: {
        object_type: "folder",
        drive_doc_token: folder.token,
        keyword,
        discovered_via: "root_browse",
      },
    });
  }
  return results;
}

async function searchWikiKeyword(
  _account: ResolvedFeishuAccount,
  userToken: string,
  keyword: string,
): Promise<DeepSearchResult[]> {
  const res = await callFeishuApiWithUserToken<WikiSearchResponse>({
    method: "POST",
    endpoint: "/wiki/v2/nodes/search",
    userToken,
    body: { query: keyword },
    query: { page_size: String(PER_KEYWORD_LIMIT) },
  });
  if (res.code !== 0) return [];

  return (res.data?.items ?? [])
    .filter((item) => item.node_id && item.title)
    .map((item) => ({
      source: "wiki" as const,
      title: item.title!.trim(),
      token: item.obj_token ?? item.node_id,
      url: item.url,
      extra: {
        wiki_node_id: item.node_id,
        wiki_space_id: item.space_id,
        wiki_obj_token: item.obj_token,
        keyword,
      },
    }));
}

async function searchMinutesKeyword(
  userToken: string,
  keyword: string,
): Promise<DeepSearchResult[]> {
  const res = await callFeishuApiWithUserToken<DriveSearchResponse>({
    method: "POST",
    endpoint: "/suite/docs-api/search/object",
    userToken,
    body: {
      search_key: keyword,
      count: PER_KEYWORD_LIMIT,
      offset: 0,
      owner_ids: [],
      docs_types: [22],
    },
  });
  if (res.code !== 0) return [];

  return (res.data?.docs_entities ?? [])
    .filter((item) => item.docs_token && item.title)
    .map((item) => ({
      source: "minutes" as const,
      title: item.title!.trim(),
      token: item.docs_token,
      extra: { docs_token: item.docs_token, keyword },
    }));
}

// ── Local group archive search ──

function resolveGroupArchiveDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  const base = override || join(homedir(), ".openclaw");
  return join(base, "feishu-groups");
}

function searchGroupArchives(keyword: string): DeepSearchResult[] {
  const archiveDir = resolveGroupArchiveDir();
  if (!existsSync(archiveDir)) return [];

  const indexPath = join(archiveDir, "index.json");
  let index: Record<string, { name: string }> = {};
  try {
    if (existsSync(indexPath)) {
      index = JSON.parse(readFileSync(indexPath, "utf-8"));
    }
  } catch {}

  const results: DeepSearchResult[] = [];
  const lowerKeyword = keyword.toLowerCase();

  let chatDirs: string[];
  try {
    chatDirs = readdirSync(archiveDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  for (const chatId of chatDirs) {
    const messagesPath = join(archiveDir, chatId, "messages.jsonl");
    if (!existsSync(messagesPath)) continue;

    let content: string;
    try {
      content = readFileSync(messagesPath, "utf-8");
    } catch {
      continue;
    }

    const chatName = index[chatId]?.name ?? chatId;
    let matchCount = 0;

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      if (matchCount >= ARCHIVE_MAX_MATCHES_PER_GROUP) break;
      try {
        const entry = normalizeArchiveEntry(JSON.parse(line) as GroupArchiveEntry);
        const text = getArchiveEntryDisplayText(entry);
        if (!text?.toLowerCase().includes(lowerKeyword)) continue;

        matchCount++;
        const idx = text.toLowerCase().indexOf(lowerKeyword);
        const start = Math.max(0, idx - ARCHIVE_SNIPPET_RADIUS);
        const end = Math.min(text.length, idx + keyword.length + ARCHIVE_SNIPPET_RADIUS);
        const snippet =
          (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");

        results.push({
          source: "group_archive",
          title: `[${chatName}] ${getArchiveEntryDisplaySender(entry)}`,
          snippet,
          extra: {
            chat_id: chatId,
            chat_name: chatName,
            sender: getArchiveEntryDisplaySender(entry),
            sender_id: entry.senderId,
            ts: entry.ts,
            msg_id: entry.msgId,
            keyword,
          },
        });
      } catch {}
    }
  }

  return results;
}

// ── Dedup + merge ──

function dedup(results: DeepSearchResult[]): DeepSearchResult[] {
  const seen = new Set<string>();
  const out: DeepSearchResult[] = [];
  for (const r of results) {
    const key = r.token ?? `${r.source}:${r.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// ── Registration ──

export function registerFeishuDeepSearchTool(api: OpenClawPluginApi): void {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const firstAccount = accounts[0];
  const redirectUri = resolveOAuthRedirectUri(api.config as Record<string, unknown>);

  api.registerTool(
    {
      name: "feishu_deep_search",
      label: "Feishu Deep Search",
      description:
        "Multi-source aggregated search across Feishu Drive docs, Wiki nodes, meeting " +
        "minutes, and local group chat archives. Pass 2-4 decomposed keyword groups " +
        "(NOT full natural-language questions). Results are merged, deduplicated, and " +
        "source-tagged. Use this for Research Mode when the user needs comprehensive " +
        "cross-source information retrieval. After getting results, use feishu_doc to " +
        "read the full content of the most relevant documents, and memory_search for " +
        "semantic recall from local memory.",
      parameters: DeepSearchSchema,
      async execute(_toolCallId, params) {
        try {
          const raw = params as Record<string, unknown>;
          const keywords = raw.keywords as string[];
          if (!keywords || keywords.length === 0) {
            return json({ error: "keywords array is required and must not be empty." });
          }
          const includeMinutes = raw.include_minutes !== false;
          const includeArchive = raw.include_group_archive !== false;
          const syncArchives = raw.sync_archives_to_memory === true;

          if (syncArchives) {
            try {
              const syncResult = syncGroupArchivesToMemory();
              api.logger.info?.(
                `feishu_deep_search: synced ${syncResult.synced} group archives to memory`,
              );
            } catch (e) {
              api.logger.info?.(`feishu_deep_search: archive sync failed: ${String(e)}`);
            }
          }

          const guard = await requireUserToken({
            account: firstAccount,
            redirectUri,
            tokenPromise: getValidUserToken(firstAccount),
            toolLabel: "飞书深度搜索",
          });
          if (!guard.ok) return guard.authResponse;
          const userToken = guard.token.access_token;

          const allResults: DeepSearchResult[] = [];
          const searchErrors: string[] = [];
          const stats = { drive: 0, wiki: 0, minutes: 0, group_archive: 0 };

          // Parallel search across all keywords and sources
          const tasks: Array<Promise<void>> = [];

          for (const keyword of keywords) {
            const kw = keyword.trim();
            if (!kw) continue;

            tasks.push(
              searchDriveKeyword(firstAccount, userToken, kw)
                .then((r) => {
                  stats.drive += r.length;
                  allResults.push(...r);
                })
                .catch((e) => void searchErrors.push(`drive[${kw}]: ${String(e)}`)),
            );

            tasks.push(
              searchWikiKeyword(firstAccount, userToken, kw)
                .then((r) => {
                  stats.wiki += r.length;
                  allResults.push(...r);
                })
                .catch((e) => void searchErrors.push(`wiki[${kw}]: ${String(e)}`)),
            );

            if (includeMinutes) {
              tasks.push(
                searchMinutesKeyword(userToken, kw)
                  .then((r) => {
                    stats.minutes += r.length;
                    allResults.push(...r);
                  })
                  .catch((e) => void searchErrors.push(`minutes[${kw}]: ${String(e)}`)),
              );
            }

            if (includeArchive) {
              try {
                const archiveResults = searchGroupArchives(kw);
                stats.group_archive += archiveResults.length;
                allResults.push(...archiveResults);
              } catch (e) {
                searchErrors.push(`archive[${kw}]: ${String(e)}`);
              }
            }
          }

          await Promise.all(tasks);

          const merged = dedup(allResults);

          return json({
            keywords,
            total_raw: allResults.length,
            total_merged: merged.length,
            stats,
            results: merged,
            ...(searchErrors.length > 0 ? { warnings: searchErrors } : {}),
            hint:
              "Results are keyword-matched. Drive results also supplement root-level folders " +
              "via user-root browse when Feishu search misses them. Use feishu_doc to read full " +
              "content of relevant documents (drive_doc_token or wiki_obj_token). Use memory_search " +
              "for semantic recall from local memory.",
          });
        } catch (err) {
          const authResp = await handleFeishuTokenError(err, firstAccount, redirectUri);
          if (authResp) return authResp;
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_deep_search" },
  );
  api.logger.info?.("feishu: registered feishu_deep_search tool");
}
