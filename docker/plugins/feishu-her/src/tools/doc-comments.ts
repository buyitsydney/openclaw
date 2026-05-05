/**
 * Feishu Document Comments tool — list, create, and resolve/unresolve comments
 * on cloud documents (docx, sheet, bitable, slides, wiki).
 *
 * Uses user_access_token (OAuth) for all operations — comments are posted
 * under the authenticated user's identity.
 *
 * API references:
 *   - list:  GET  /drive/v1/files/:file_token/comments
 *   - create: POST /drive/v1/files/:file_token/comments
 *   - patch: PATCH /drive/v1/files/:file_token/comments/:comment_id
 *   - replies: GET /drive/v1/files/:file_token/comments/:comment_id/replies
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { listEnabledFeishuAccounts } from "../accounts.js";
import {
  callFeishuApiWithUserToken,
  getValidUserToken,
  handleFeishuTokenError,
  requireUserToken,
  resolveOAuthRedirectUri,
} from "../oauth.js";
import { getOAuthDirectSender } from "./oauth-direct.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ── Types ──

type CommentItem = {
  comment_id?: string;
  is_solved?: boolean;
  quote?: string;
  reply_list?: { replies?: ReplyItem[] };
  // oxlint-disable-next-line typescript/no-explicit-any
  [key: string]: any;
};

type ReplyItem = {
  reply_id?: string;
  content?: { elements?: ReplyElement[] };
  // oxlint-disable-next-line typescript/no-explicit-any
  [key: string]: any;
};

type ReplyElement = {
  type: "text_run" | "person" | "docs_link";
  text_run?: { text: string };
  person?: { user_id: string };
  docs_link?: { url: string };
};

type CommentListData = {
  items?: CommentItem[];
  has_more?: boolean;
  page_token?: string;
};

type CommentReplyListData = {
  items?: ReplyItem[];
  has_more?: boolean;
  page_token?: string;
};

type WikiNodeData = {
  node?: {
    obj_token?: string;
    obj_type?: string;
    title?: string;
  };
};

// ── Schema (flat, no Type.Union per repo guardrails) ──

const FILE_TYPES = ["doc", "docx", "sheet", "file", "slides", "wiki"] as const;

const DocCommentsSchema = Type.Object({
  action: stringEnum(["list", "create", "patch"]),
  file_token: Type.String({
    description:
      "Cloud document token or wiki node token (extractable from doc URL). Wiki tokens are automatically resolved to the underlying obj_token.",
  }),
  file_type: stringEnum([...FILE_TYPES], {
    description:
      "Document type. 'wiki' is auto-resolved to the actual doc type (docx/sheet/bitable).",
  }),
  // list params
  is_whole: Type.Optional(
    Type.Boolean({ description: "Only return whole-document comments (action=list)" }),
  ),
  is_solved: Type.Optional(
    Type.Boolean({ description: "Only return solved comments (action=list)" }),
  ),
  page_size: Type.Optional(Type.Integer({ description: "Page size (default 50)" })),
  page_token: Type.Optional(Type.String({ description: "Pagination token" })),
  // create params
  content: Type.Optional(
    Type.String({
      description:
        "Plain text content for the comment (action=create). For simple text comments, just provide this field.",
    }),
  ),
  mention_open_id: Type.Optional(
    Type.String({
      description: "Open ID of a user to @mention in the comment (action=create, optional)",
    }),
  ),
  // patch params
  comment_id: Type.Optional(
    Type.String({ description: "Comment ID to resolve/unresolve (action=patch)" }),
  ),
  is_solved_value: Type.Optional(
    Type.Boolean({ description: "true = resolve, false = unresolve (action=patch)" }),
  ),
});

// ── Wiki token resolution ──

async function resolveWikiToken(
  userToken: string,
  wikiToken: string,
): Promise<{ objToken: string; objType: string } | { error: string }> {
  const res = await callFeishuApiWithUserToken<WikiNodeData>({
    method: "GET",
    endpoint: "/wiki/v2/spaces/get_node",
    userToken,
    query: { token: wikiToken },
  });
  if (res.code !== 0) {
    return { error: `Failed to resolve wiki token: ${res.msg}` };
  }
  const node = res.data?.node;
  if (!node?.obj_token || !node?.obj_type) {
    return { error: `Wiki token "${wikiToken}" could not be resolved (may be a folder node)` };
  }
  return { objToken: node.obj_token, objType: node.obj_type };
}

// ── Comment reply assembly ──

async function fetchAllReplies(
  userToken: string,
  fileToken: string,
  fileType: string,
  commentId: string,
): Promise<ReplyItem[]> {
  const replies: ReplyItem[] = [];
  let pageToken: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const query: Record<string, string> = {
      file_type: fileType,
      page_size: "50",
    };
    if (pageToken) {query.page_token = pageToken;}

    const res = await callFeishuApiWithUserToken<CommentReplyListData>({
      method: "GET",
      endpoint: `/drive/v1/files/${fileToken}/comments/${commentId}/replies`,
      userToken,
      query,
    });
    if (res.code !== 0) {break;}

    if (res.data?.items) {replies.push(...res.data.items);}
    hasMore = res.data?.has_more ?? false;
    pageToken = res.data?.page_token;
  }
  return replies;
}

async function assembleCommentsWithReplies(
  userToken: string,
  fileToken: string,
  fileType: string,
  comments: CommentItem[],
): Promise<CommentItem[]> {
  const result: CommentItem[] = [];
  for (const comment of comments) {
    const assembled = { ...comment };
    if (comment.reply_list?.replies?.length || comment.comment_id) {
      try {
        const replies = await fetchAllReplies(userToken, fileToken, fileType, comment.comment_id!);
        assembled.reply_list = { replies };
      } catch {
        // Keep original reply data on failure
      }
    }
    result.push(assembled);
  }
  return result;
}

// ── Create-comment element builder ──

function buildCreateElements(
  content: string,
  mentionOpenId?: string,
): { type: string; text_run?: { text: string }; person?: { user_id: string } }[] {
  const elements: { type: string; text_run?: { text: string }; person?: { user_id: string } }[] = [
    { type: "text_run", text_run: { text: content } },
  ];
  if (mentionOpenId) {
    elements.push({ type: "person", person: { user_id: mentionOpenId } });
  }
  return elements;
}

// ── Registration ──

export function registerFeishuDocCommentsTools(api: OpenClawPluginApi): void {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.info?.("feishu: doc_comments skipped — no accounts");
    return;
  }

  const account = accounts[0];
  // oxlint-disable-next-line typescript/no-explicit-any
  const redirectUri = resolveOAuthRedirectUri(api.config as any);
  api.logger.info?.("feishu: registering feishu_doc_comments tool");

  api.registerTool({
    name: "feishu_doc_comments",
    description:
      "Manage comments on Feishu cloud documents (docx/sheet/slides/wiki). " +
      "Actions: list (get all comments with replies), create (add a comment, optionally @mention a user), " +
      "patch (resolve or unresolve a comment). Operates under user identity via OAuth.",
    parameters: DocCommentsSchema,
    async execute(_toolCallId, rawParams) {
      // oxlint-disable-next-line typescript/no-explicit-any
      const params = rawParams as any;
      const action: string = params.action;

      // Require user token (async — handles refresh + re-auth prompt)
      const tokenResult = await requireUserToken({
        account,
        redirectUri,
        tokenPromise: getValidUserToken(account),
        toolLabel: "文档评论",
        sendDirectToUser: getOAuthDirectSender(account),
      });
      if (!tokenResult.ok) {return tokenResult.authResponse;}
      const userToken = tokenResult.token.access_token;

      try {
        // Resolve wiki token if needed
        let fileToken: string = params.file_token;
        let fileType: string = params.file_type;

        if (fileType === "wiki") {
          const resolved = await resolveWikiToken(userToken, fileToken);
          if ("error" in resolved) {return json({ error: resolved.error });}
          fileToken = resolved.objToken;
          fileType = resolved.objType;
        }

        // ── LIST ──
        if (action === "list") {
          const query: Record<string, string> = {
            file_type: fileType,
            page_size: String(params.page_size ?? 50),
          };
          if (params.is_whole !== undefined) {query.is_whole = String(params.is_whole);}
          if (params.is_solved !== undefined) {query.is_solved = String(params.is_solved);}
          if (params.page_token) {query.page_token = params.page_token;}

          const res = await callFeishuApiWithUserToken<CommentListData>({
            method: "GET",
            endpoint: `/drive/v1/files/${fileToken}/comments`,
            userToken,
            query,
          });
          if (res.code !== 0) {return json({ error: res.msg });}

          const items = res.data?.items ?? [];
          const assembled = await assembleCommentsWithReplies(
            userToken,
            fileToken,
            fileType,
            items,
          );

          return json({
            items: assembled,
            has_more: res.data?.has_more ?? false,
            page_token: res.data?.page_token,
          });
        }

        // ── CREATE ──
        if (action === "create") {
          if (!params.content) {return json({ error: "content is required for create action" });}

          const elements = buildCreateElements(params.content, params.mention_open_id);

          const res = await callFeishuApiWithUserToken<{ comment_id?: string }>({
            method: "POST",
            endpoint: `/drive/v1/files/${fileToken}/comments`,
            userToken,
            query: { file_type: fileType },
            body: {
              reply_list: {
                replies: [{ content: { elements } }],
              },
            },
          });
          if (res.code !== 0) {return json({ error: res.msg });}

          return json({ success: true, comment_id: res.data?.comment_id });
        }

        // ── PATCH (resolve / unresolve) ──
        if (action === "patch") {
          if (!params.comment_id) {return json({ error: "comment_id is required for patch action" });}
          if (params.is_solved_value === undefined)
            {return json({ error: "is_solved_value is required for patch action" });}

          const res = await callFeishuApiWithUserToken({
            method: "PATCH",
            endpoint: `/drive/v1/files/${fileToken}/comments/${params.comment_id}`,
            userToken,
            query: { file_type: fileType },
            body: { is_solved: params.is_solved_value },
          });
          if (res.code !== 0) {return json({ error: res.msg });}

          return json({ success: true });
        }

        return json({ error: `Unknown action: ${action}` });
      } catch (err) {
        return handleFeishuTokenError(err, { account, redirectUri });
      }
    },
  });
}
