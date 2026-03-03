/**
 * Feishu Wiki (knowledge base) tool — list spaces, navigate nodes, create/move/rename.
 * Adapted from @m1heng-clawd/feishu with schema guardrails (no Type.Union).
 */

import type * as Lark from "@larksuiteoapi/node-sdk";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import { getFeishuClient } from "../outbound.js";
import { resolveDriveShareUrl } from "./share-url.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

const WIKI_ACCESS_HINT =
  "To grant wiki access: Open wiki space -> Settings -> Members -> Add the bot. " +
  "See: https://open.feishu.cn/document/server-docs/docs/wiki-v2/wiki-qa#a40ad4ca";

const WIKI_OBJ_TYPES = new Set(["docx", "sheet", "bitable"]);

function requireStringParam(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  return trimmed;
}

function requireWikiObjType(value: unknown): string {
  const objType = requireStringParam(value, "obj_type");
  if (!WIKI_OBJ_TYPES.has(objType)) {
    throw new Error(`obj_type must be one of: docx, sheet, bitable`);
  }
  return objType;
}

function optionalStringParam(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireStringParam(value, field);
}

// ── Actions ──

async function listSpaces(client: Lark.Client) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.wiki.space.list({});
  if (res.code !== 0) throw new Error(res.msg);
  const spaces = (res.data?.items ?? []).map(
    (s: { space_id?: string; name?: string; description?: string; visibility?: string }) => ({
      space_id: s.space_id,
      name: s.name,
      description: s.description,
      visibility: s.visibility,
    }),
  );
  return { spaces, ...(spaces.length === 0 && { hint: WIKI_ACCESS_HINT }) };
}

async function listNodes(client: Lark.Client, spaceId: string, parentNodeToken?: string) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.wiki.spaceNode.list({
    path: { space_id: spaceId },
    params: { parent_node_token: parentNodeToken },
  });
  if (res.code !== 0) throw new Error(res.msg);
  const nodes = (res.data?.items ?? []).map(
    (n: {
      node_token?: string;
      obj_token?: string;
      obj_type?: string;
      title?: string;
      has_child?: boolean;
    }) => ({
      node_token: n.node_token,
      obj_token: n.obj_token,
      obj_type: n.obj_type,
      title: n.title,
      has_child: n.has_child,
    }),
  );
  return {
    nodes,
    // Guide AI to use feishu_doc for reading document content (including embedded whiteboards).
    hint:
      nodes.length > 0
        ? "To read a document's full content (including embedded whiteboards/boards), use feishu_doc with action: 'read' and the obj_token as doc_token. Board/whiteboard images are automatically exported as vision-compatible PNG."
        : undefined,
  };
}

async function getNode(client: Lark.Client, token: string) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.wiki.space.getNode({ params: { token } });
  if (res.code !== 0) throw new Error(res.msg);
  const node = res.data?.node;
  return {
    node_token: node?.node_token,
    space_id: node?.space_id,
    obj_token: node?.obj_token,
    obj_type: node?.obj_type,
    title: node?.title,
    parent_node_token: node?.parent_node_token,
    has_child: node?.has_child,
    creator: node?.creator,
    create_time: node?.node_create_time,
  };
}

async function createNode(
  client: Lark.Client,
  spaceId: string,
  title: string,
  objType: string,
  parentNodeToken: string,
) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.wiki.spaceNode.create({
    path: { space_id: spaceId },
    // oxlint-disable-next-line typescript/no-explicit-any
    data: {
      obj_type: objType as any,
      node_type: "origin" as const,
      title,
      parent_node_token: parentNodeToken,
    },
  });
  if (res.code !== 0) throw new Error(res.msg);
  const node = res.data?.node;
  return {
    node_token: node?.node_token,
    obj_token: node?.obj_token,
    obj_type: node?.obj_type,
    title: node?.title,
  };
}

async function moveNode(
  client: Lark.Client,
  spaceId: string,
  nodeToken: string,
  targetSpaceId: string,
  targetParentToken: string,
) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.wiki.spaceNode.move({
    path: { space_id: spaceId, node_token: nodeToken },
    data: { target_space_id: targetSpaceId, target_parent_token: targetParentToken },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { success: true, node_token: res.data?.node?.node_token };
}

async function renameNode(client: Lark.Client, spaceId: string, nodeToken: string, title: string) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.wiki.spaceNode.updateTitle({
    path: { space_id: spaceId, node_token: nodeToken },
    data: { title },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { success: true, node_token: nodeToken, title };
}

// ── Schema ──

const WIKI_ACTIONS = ["spaces", "nodes", "get", "create", "move", "rename", "resolve_url"] as const;

const FeishuWikiSchema = Type.Object({
  action: stringEnum(WIKI_ACTIONS, { description: "Wiki operation to perform" }),
  space_id: Type.Optional(
    Type.String({ description: "Knowledge space ID (required for nodes/create/move/rename)" }),
  ),
  token: Type.Optional(
    Type.String({
      description: "Wiki node token from URL /wiki/XXX (required for get/resolve_url)",
    }),
  ),
  parent_node_token: Type.Optional(
    Type.String({ description: "Parent node token (for nodes/create). Required for create." }),
  ),
  node_token: Type.Optional(Type.String({ description: "Node token (required for move/rename)" })),
  title: Type.Optional(Type.String({ description: "Node title (required for create/rename)" })),
  obj_type: Type.Optional(
    Type.String({ description: "Object type: docx, sheet, bitable (for create, required)" }),
  ),
  target_space_id: Type.Optional(
    Type.String({ description: "Target space ID (for move, required)" }),
  ),
  target_parent_token: Type.Optional(
    Type.String({ description: "Target parent node token (for move, required)" }),
  ),
});

// ── Registration ──

export function registerFeishuWikiTools(api: OpenClawPluginApi) {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const firstAccount: ResolvedFeishuAccount = accounts[0];
  const getClient = () => getFeishuClient(firstAccount);

  api.registerTool(
    {
      name: "feishu_wiki",
      label: "Feishu Wiki",
      description:
        "Feishu knowledge base operations. Actions: spaces, nodes, get, create, move, rename, resolve_url. To read a document's full content including embedded whiteboards, use feishu_doc with action 'read' and the node's obj_token as doc_token.",
      parameters: FeishuWikiSchema,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        try {
          const client = getClient();
          switch (params.action) {
            case "spaces":
              return json(await listSpaces(client));
            case "nodes":
              return json(
                await listNodes(
                  client,
                  requireStringParam(params.space_id, "space_id"),
                  optionalStringParam(params.parent_node_token, "parent_node_token"),
                ),
              );
            case "get":
              return json(await getNode(client, requireStringParam(params.token, "token")));
            case "create":
              // Require explicit parent and object type to avoid implicit root/default creation.
              return json(
                await createNode(
                  client,
                  requireStringParam(params.space_id, "space_id"),
                  requireStringParam(params.title, "title"),
                  requireWikiObjType(params.obj_type),
                  requireStringParam(params.parent_node_token, "parent_node_token"),
                ),
              );
            case "move":
              return json(
                await moveNode(
                  client,
                  requireStringParam(params.space_id, "space_id"),
                  requireStringParam(params.node_token, "node_token"),
                  requireStringParam(params.target_space_id, "target_space_id"),
                  requireStringParam(params.target_parent_token, "target_parent_token"),
                ),
              );
            case "rename":
              return json(
                await renameNode(
                  client,
                  requireStringParam(params.space_id, "space_id"),
                  requireStringParam(params.node_token, "node_token"),
                  requireStringParam(params.title, "title"),
                ),
              );
            case "resolve_url": {
              if (!params.token) {
                return json({ error: "token is required for resolve_url" });
              }
              const share = await resolveDriveShareUrl(firstAccount, params.token, "wiki");
              if (!share.ok) {
                return json({
                  error: share.error,
                  code: share.code,
                  msg: share.msg,
                  http_status: share.http_status,
                });
              }
              return json({
                token: params.token,
                share_url: share.share_url,
              });
            }
            default:
              return json({ error: `Unknown action: ${params.action}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_wiki" },
  );
  api.logger.info?.("feishu: registered feishu_wiki tool");
}
