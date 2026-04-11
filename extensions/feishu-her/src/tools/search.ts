/**
 * Feishu Search tool — unified Drive document + Wiki node search using user OAuth.
 *
 * MVP scope:
 * - Search Drive documents via legacy docs search (stable in real tenant tests)
 * - Search Wiki nodes via wiki node search
 * - Return deterministic, source-tagged results without guessing cross-source dedupe
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
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

const SEARCH_SCOPES = ["all", "drive", "wiki"] as const;

const FeishuSearchSchema = Type.Object({
  query: Type.String({
    description: "Search keyword. Required. Matches against Drive docs and/or Wiki content.",
  }),
  scope: Type.Optional(
    stringEnum(SEARCH_SCOPES, {
      description: "Search scope: all (default), drive only, or wiki only.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Max merged results to return. Default 10, min 1, max 20.",
    }),
  ),
  space_id: Type.Optional(
    Type.String({
      description: "Optional Wiki knowledge-space ID to restrict wiki search.",
    }),
  ),
  include_bitable: Type.Optional(
    Type.Boolean({
      description:
        "Include bitable (multi-dimensional tables) in Drive search results. " +
        "Default false — bitables produce heavy noise because field names and cell data are all indexed. " +
        "Set true only when explicitly searching for a specific bitable.",
    }),
  ),
});

type SearchScope = (typeof SEARCH_SCOPES)[number];

type DriveSearchEntity = {
  docs_token?: string;
  docs_type?: string;
  owner_id?: string;
  title?: string;
};

type WikiSearchEntity = {
  node_id?: string;
  obj_token?: string;
  obj_type?: number | string;
  parent_id?: string;
  space_id?: string;
  title?: string;
  url?: string;
};

type DriveSearchResponse = {
  docs_entities?: DriveSearchEntity[];
  has_more?: boolean;
  total?: number;
};

type WikiSearchResponse = {
  items?: WikiSearchEntity[];
  has_more?: boolean;
};

type SearchResult =
  | {
      source: "drive";
      title: string;
      object_type: string;
      drive_doc_token: string;
      read_tool: "feishu_doc";
      read_params: { action: "read"; doc_token: string; doc_type: string };
      owner_id?: string;
      url?: string;
      url_resolve_error?: string;
    }
  | {
      source: "drive";
      title: string;
      object_type: "folder";
      drive_doc_token: string;
      read_tool: "feishu_drive";
      read_params: { action: "list_folder"; folder_token: string };
      owner_id?: string;
      url?: string;
      discovered_via: "root_browse";
    }
  | {
      source: "wiki";
      title: string;
      object_type: "wiki_node";
      wiki_node_id: string;
      read_tool: "feishu_doc";
      read_params?: { action: "read"; doc_token: string };
      wiki_space_id?: string;
      wiki_obj_token?: string;
      wiki_obj_type_raw?: number | string;
      url?: string;
    };

function requireQuery(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("query is required");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("query is required");
  }
  return trimmed;
}

function parseScope(value: unknown): SearchScope {
  if (value === undefined) return "all";
  if (value === "all" || value === "drive" || value === "wiki") {
    return value;
  }
  throw new Error("scope must be one of: all, drive, wiki");
}

function parseLimit(value: unknown): number {
  if (value === undefined) return 10;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("limit must be an integer");
  }
  if (value < 1 || value > 20) {
    throw new Error("limit must be between 1 and 20");
  }
  return value;
}

const ALL_SCOPE_SOURCE_QUOTA = 5;

const DRIVE_DOC_TYPES_WITHOUT_BITABLE = ["doc", "docx", "sheet", "slides", "mindnote", "file"];

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

async function searchDrive(
  account: ResolvedFeishuAccount,
  userToken: string,
  query: string,
  limit: number,
  docsTypes: string[],
): Promise<SearchResult[]> {
  const res = await callFeishuApiWithUserToken<DriveSearchResponse>({
    method: "POST",
    endpoint: "/suite/docs-api/search/object",
    userToken,
    body: {
      search_key: query,
      count: limit,
      offset: 0,
      owner_ids: [],
      docs_types: docsTypes,
    },
  });
  if (res.code !== 0) {
    throw new Error(`Drive search failed: code=${res.code} msg=${res.msg}`);
  }
  const baseResults = (res.data?.docs_entities ?? [])
    .filter(
      (
        item,
      ): item is Required<Pick<DriveSearchEntity, "docs_token" | "docs_type" | "title">> &
        DriveSearchEntity =>
        typeof item.docs_token === "string" &&
        item.docs_token.trim().length > 0 &&
        typeof item.docs_type === "string" &&
        item.docs_type.trim().length > 0 &&
        typeof item.title === "string" &&
        item.title.trim().length > 0,
    )
    .map((item) => ({
      source: "drive" as const,
      title: item.title.trim(),
      object_type: item.docs_type.trim(),
      drive_doc_token: item.docs_token.trim(),
      read_tool: "feishu_doc" as const,
      read_params: {
        action: "read" as const,
        doc_token: item.docs_token.trim(),
        doc_type: item.docs_type.trim(),
      },
      ...(typeof item.owner_id === "string" && item.owner_id.trim().length > 0
        ? { owner_id: item.owner_id.trim() }
        : {}),
    }));

  const enriched = await Promise.all(
    baseResults.map(async (item) => {
      const docType = toDriveDocType(item.object_type);
      if (!docType) {
        return {
          ...item,
          url_resolve_error: `unsupported_doc_type:${item.object_type}`,
        };
      }
      const resolved = await resolveDriveShareUrl(account, item.drive_doc_token, docType, {
        userToken,
      });
      if (!resolved.ok) {
        return {
          ...item,
          url_resolve_error: resolved.error,
        };
      }
      return {
        ...item,
        url: resolved.share_url,
      };
    }),
  );

  const rootFolderResults = await searchRootDriveItemsByTitle(userToken, query, {
    limit,
    types: ["folder"],
  });
  const seenTokens = new Set(enriched.map((item) => item.drive_doc_token));
  const supplemented = rootFolderResults
    .filter((item) => !seenTokens.has(item.token))
    .map((item) => ({
      source: "drive" as const,
      title: item.name,
      object_type: "folder" as const,
      drive_doc_token: item.token,
      read_tool: "feishu_drive" as const,
      read_params: {
        action: "list_folder" as const,
        folder_token: item.token,
      },
      ...(item.owner_id ? { owner_id: item.owner_id } : {}),
      ...(item.url ? { url: item.url } : {}),
      discovered_via: "root_browse" as const,
    }));

  return [...enriched, ...supplemented];
}

async function searchWiki(
  account: ResolvedFeishuAccount,
  userToken: string,
  query: string,
  limit: number,
  spaceId?: string,
): Promise<SearchResult[]> {
  const res = await callFeishuApiWithUserToken<WikiSearchResponse>({
    method: "POST",
    endpoint: "/wiki/v2/nodes/search",
    userToken,
    body: {
      query,
      ...(spaceId ? { space_id: spaceId } : {}),
    },
    query: {
      page_size: String(limit),
    },
  });
  if (res.code !== 0) {
    throw new Error(`Wiki search failed: code=${res.code} msg=${res.msg}`);
  }
  return (res.data?.items ?? [])
    .filter(
      (item): item is Required<Pick<WikiSearchEntity, "node_id" | "title">> & WikiSearchEntity =>
        typeof item.node_id === "string" &&
        item.node_id.trim().length > 0 &&
        typeof item.title === "string" &&
        item.title.trim().length > 0,
    )
    .map((item) => ({
      source: "wiki" as const,
      title: item.title.trim(),
      object_type: "wiki_node" as const,
      wiki_node_id: item.node_id.trim(),
      read_tool: "feishu_doc" as const,
      ...(typeof item.obj_token === "string" && item.obj_token.trim().length > 0
        ? {
            read_params: {
              action: "read" as const,
              doc_token: item.obj_token.trim(),
            },
          }
        : {}),
      ...(typeof item.space_id === "string" && item.space_id.trim().length > 0
        ? { wiki_space_id: item.space_id.trim() }
        : {}),
      ...(typeof item.obj_token === "string" && item.obj_token.trim().length > 0
        ? { wiki_obj_token: item.obj_token.trim() }
        : {}),
      ...(item.obj_type !== undefined ? { wiki_obj_type_raw: item.obj_type } : {}),
      ...(typeof item.url === "string" && item.url.trim().length > 0
        ? { url: item.url.trim() }
        : {}),
    }));
}

export function registerFeishuSearchTool(api: OpenClawPluginApi): void {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const firstAccount: ResolvedFeishuAccount = accounts[0];
  const redirectUri = resolveOAuthRedirectUri(api.config as Record<string, unknown>);

  api.registerTool(
    {
      name: "feishu_search",
      label: "Feishu Search",
      description:
        "Search Feishu user-visible content using the user's own OAuth permissions. " +
        "MVP searches two stable sources in parallel: Drive documents/root folders and Wiki nodes. " +
        "Results are source-tagged and not cross-deduped. If authorization is needed, " +
        "the tool returns an auth_url — send it to the user as a clickable link.",
      parameters: FeishuSearchSchema,
      async execute(_toolCallId, params) {
        try {
          const query = requireQuery((params as Record<string, unknown>).query);
          const scope = parseScope((params as Record<string, unknown>).scope);
          const limit = parseLimit((params as Record<string, unknown>).limit);
          const rawSpaceId = (params as Record<string, unknown>).space_id;
          const spaceId =
            typeof rawSpaceId === "string" && rawSpaceId.trim().length > 0
              ? rawSpaceId.trim()
              : undefined;
          const driveLimit = scope === "all" ? Math.min(limit, ALL_SCOPE_SOURCE_QUOTA) : limit;
          const wikiLimit = scope === "all" ? Math.min(limit, ALL_SCOPE_SOURCE_QUOTA) : limit;
          const includeBitable = (params as Record<string, unknown>).include_bitable === true;
          const docsTypes = includeBitable ? [] : DRIVE_DOC_TYPES_WITHOUT_BITABLE;

          const guard = await requireUserToken({
            account: firstAccount,
            redirectUri,
            tokenPromise: getValidUserToken(firstAccount),
            toolLabel: "飞书搜索",
          });
          if (!guard.ok) return guard.authResponse;

          const userToken = guard.token.access_token;
          const [driveResults, wikiResults] = await Promise.all([
            scope === "wiki"
              ? Promise.resolve([])
              : searchDrive(firstAccount, userToken, query, driveLimit, docsTypes),
            scope === "drive"
              ? Promise.resolve([])
              : searchWiki(firstAccount, userToken, query, wikiLimit, spaceId),
          ]);

          const merged =
            scope === "all"
              ? [...driveResults.slice(0, driveLimit), ...wikiResults.slice(0, wikiLimit)]
              : [...driveResults, ...wikiResults].slice(0, limit);

          return json({
            query,
            scope,
            limit,
            results: merged,
            ...(scope === "all"
              ? {
                  source_limits: {
                    drive: driveLimit,
                    wiki: wikiLimit,
                  },
                }
              : {}),
            counts: {
              drive: driveResults.length,
              wiki: wikiResults.length,
              merged: merged.length,
            },
            note: "Drive and Wiki are searched independently. Root-level Drive folders are supplemented via user-root browse because Feishu's docs search may miss folders.",
          });
        } catch (err) {
          const authResp = await handleFeishuTokenError(err, firstAccount, redirectUri);
          if (authResp) return authResp;
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_search" },
  );
  api.logger.info?.("feishu: registered feishu_search tool");
}
