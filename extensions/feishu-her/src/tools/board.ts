/**
 * Feishu Board (画板) tool — create nodes, render Mermaid/PlantUML diagrams, list nodes.
 * Uses the Lark SDK's board.v1.whiteboardNode namespace.
 *
 * Limitations (Feishu platform):
 *  - No update/delete API — nodes are append-only via API.
 *  - Max 3000 nodes per create call.
 *  - Whiteboard creation: insert block_type=43 into a docx document via documentBlockChildren.create.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { stringEnum } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "../accounts.js";
import { getFeishuClient } from "../outbound.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ── Actions ────────────────────────────────────────────────────────────────

const BOARD_ACTIONS = [
  "create",
  "create_nodes",
  "create_diagram",
  "list_nodes",
  "get_theme",
] as const;

// ── Shape subtypes (most common; full list in SDK types) ───────────────────

const SHAPE_TYPES = [
  "round_rect",
  "rect",
  "ellipse",
  "diamond",
  "cylinder",
  "triangle",
  "star",
  "hexagon",
  "cloud",
  "parallelogram",
  "trapezoid",
  "pentagon",
  "bubble",
  "document_shape",
  "condition_shape",
  "flow_chart_round_rect",
  "flow_chart_diamond",
  "flow_chart_parallelogram",
  "flow_chart_cylinder",
  "actor",
] as const;

const NODE_TYPES = [
  "composite_shape",
  "text_shape",
  "connector",
  "image",
  "svg",
  "group",
  "table",
  "section",
  "mind_map",
  // sticky_note excluded: Feishu API rejects all sticky_note creation via bot (requires user_id)
] as const;

const CONNECTOR_SHAPES = ["straight", "polyline", "curve", "right_angled_polyline"] as const;

const ARROW_STYLES = [
  "none",
  "line_arrow",
  "triangle_arrow",
  "circle_arrow",
  "diamond_arrow",
] as const;

// ── Schema ─────────────────────────────────────────────────────────────────

const BoardSchema = Type.Object({
  action: stringEnum([...BOARD_ACTIONS], {
    description:
      "Operation: create (insert new whiteboard into a document), create_nodes (shapes/connectors/text), create_diagram (Mermaid/PlantUML code), list_nodes, get_theme",
  }),
  whiteboard_id: Type.Optional(
    Type.String({
      description: "Whiteboard token (required for all actions except create)",
    }),
  ),
  doc_token: Type.Optional(
    Type.String({
      description: "Document ID to insert a new whiteboard into (for create action)",
    }),
  ),

  // create_nodes: array of node definitions
  nodes: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.Optional(Type.String({ description: "Client-side node ID for cross-references" })),
        type: stringEnum([...NODE_TYPES], {
          description: "Node type: composite_shape, text_shape, connector, sticky_note, etc.",
        }),
        parent_id: Type.Optional(
          Type.String({ description: "Parent node ID (for groups/sections)" }),
        ),
        x: Type.Optional(Type.Number({ description: "X position (pixels)" })),
        y: Type.Optional(Type.Number({ description: "Y position (pixels)" })),
        width: Type.Optional(Type.Number({ description: "Width (pixels)" })),
        height: Type.Optional(Type.Number({ description: "Height (pixels)" })),
        z_index: Type.Optional(Type.Number({ description: "Layer order (0-10000)" })),
        text: Type.Optional(Type.String({ description: "Node text content" })),
        font_size: Type.Optional(Type.Number({ description: "Font size (default 14)" })),
        font_weight: Type.Optional(stringEnum(["regular", "bold"], { description: "Font weight" })),
        text_align: Type.Optional(
          stringEnum(["left", "center", "right"], { description: "Text horizontal alignment" }),
        ),
        fill_color: Type.Optional(Type.String({ description: "Fill color hex (e.g. #FF6600)" })),
        border_style: Type.Optional(
          stringEnum(["solid", "dash", "dot", "none"], { description: "Border style" }),
        ),
        border_color: Type.Optional(Type.String({ description: "Border color hex" })),
        // composite_shape specific
        shape_type: Type.Optional(
          stringEnum([...SHAPE_TYPES], {
            description: "Shape subtype for composite_shape (round_rect, diamond, ellipse, etc.)",
          }),
        ),
        // connector specific
        connector_shape: Type.Optional(
          stringEnum([...CONNECTOR_SHAPES], { description: "Connector line shape" }),
        ),
        start_node_id: Type.Optional(Type.String({ description: "Connector start node ID" })),
        start_arrow: Type.Optional(
          stringEnum([...ARROW_STYLES], { description: "Start arrow style" }),
        ),
        end_node_id: Type.Optional(Type.String({ description: "Connector end node ID" })),
        end_arrow: Type.Optional(
          stringEnum([...ARROW_STYLES], { description: "End arrow style (default: line_arrow)" }),
        ),
        // section
        section_title: Type.Optional(Type.String({ description: "Section title" })),
        // svg
        svg_code: Type.Optional(Type.String({ description: "Raw SVG code for svg node type" })),
      }),
      { description: "Array of nodes to create (max 3000)" },
    ),
  ),

  // create_diagram: Mermaid or PlantUML code
  diagram_code: Type.Optional(Type.String({ description: "Mermaid or PlantUML diagram code" })),
  diagram_syntax: Type.Optional(
    stringEnum(["plantuml", "mermaid"], { description: "Diagram syntax (default: mermaid)" }),
  ),

  // idempotency
  client_token: Type.Optional(Type.String({ description: "Idempotency token (10-64 chars)" })),
});

// ── Helpers ────────────────────────────────────────────────────────────────

// oxlint-disable-next-line typescript/no-explicit-any
type NodeInput = any;

/** Transform our simplified node schema into Lark SDK's nested structure. */
function transformNode(n: NodeInput) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const node: Record<string, any> = {
    type: n.type,
    ...(n.id && { id: n.id }),
    ...(n.parent_id && { parent_id: n.parent_id }),
    ...(n.x != null && { x: n.x }),
    ...(n.y != null && { y: n.y }),
    ...(n.width != null && { width: n.width }),
    ...(n.height != null && { height: n.height }),
    ...(n.z_index != null && { z_index: n.z_index }),
  };

  // Text properties → nested text object
  // For connectors, text goes into connector.captions instead of top-level text
  if (n.text && n.type !== "connector") {
    node.text = {
      text: n.text,
      ...(n.font_size && { font_size: n.font_size }),
      ...(n.font_weight && { font_weight: n.font_weight }),
      ...(n.text_align && { horizontal_align: n.text_align }),
    };
  }

  // Style properties → nested style object
  if (n.fill_color || n.border_style || n.border_color) {
    node.style = {
      ...(n.fill_color && { fill_color: n.fill_color }),
      ...(n.border_style && { border_style: n.border_style }),
      ...(n.border_color && { border_color: n.border_color }),
    };
  }

  // Shape subtype
  if (n.type === "composite_shape" && n.shape_type) {
    node.composite_shape = { type: n.shape_type };
  }

  // Connector — start/end_node_id must be server-returned IDs (e.g. "o1:3"),
  // NOT client-side IDs from the same batch. Create shapes first, get IDs, then connect.
  if (n.type === "connector") {
    node.connector = {
      ...(n.connector_shape && { shape: n.connector_shape }),
      start: {
        ...(n.start_node_id && { attached_object: { id: n.start_node_id, snap_to: "auto" } }),
        arrow_style: n.start_arrow ?? "none",
      },
      end: {
        ...(n.end_node_id && { attached_object: { id: n.end_node_id, snap_to: "auto" } }),
        arrow_style: n.end_arrow ?? "line_arrow",
      },
      // Connector text goes into captions, not top-level text
      ...(n.text && {
        captions: { data: [{ text: n.text }] },
      }),
    };
  }

  // Section
  if (n.type === "section" && n.section_title) {
    node.section = { title: n.section_title };
  }

  // SVG
  if (n.type === "svg" && n.svg_code) {
    node.svg = { svg_code: n.svg_code };
  }

  return node;
}

/** Extract a human-readable error message from Lark SDK exceptions.
 *  The SDK throws [AxiosError, {code, msg, error}] arrays on HTTP 4xx. */
function extractLarkErrorDetail(err: unknown): string | undefined {
  if (Array.isArray(err)) {
    // oxlint-disable-next-line typescript/no-explicit-any
    const detail = err.find((e: any) => e && typeof e === "object" && "code" in e && "msg" in e);
    if (detail) {
      const errObj = detail.error;
      const fieldErrors =
        errObj && typeof errObj === "object" ? JSON.stringify(errObj).slice(0, 300) : undefined;
      return `Feishu API error: code=${detail.code} msg=${detail.msg}${fieldErrors ? ` detail=${fieldErrors}` : ""}`;
    }
  }
  return undefined;
}

// ── Registration ──────────────────────────────────────────────────────────

export function registerFeishuBoardTools(api: OpenClawPluginApi): void {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const firstAccount = accounts[0];

  api.registerTool(
    {
      name: "feishu_board",
      label: "Feishu Board",
      description:
        "Create and draw on Feishu whiteboards (画板). " +
        "Use 'create' to insert a new whiteboard into a document, then draw on it. " +
        "PREFER create_diagram (Mermaid/PlantUML) for flowcharts, sequence diagrams, class diagrams, ER diagrams — " +
        "Feishu auto-layouts these perfectly. AI just writes Mermaid code, no coordinate math needed. " +
        "Use create_nodes ONLY for simple shapes (2-5 nodes), custom colors/styles, mind maps, or SVG — " +
        "AI must manually calculate x/y coordinates, so complex diagrams will have messy layouts. " +
        "Connectors in create_nodes are auto-split: shapes created first, then connectors linked by server IDs. " +
        "Nodes are append-only (no update/delete via API).",
      parameters: BoardSchema,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        const action: string = params.action;
        const whiteboardId: string = params.whiteboard_id?.trim() ?? "";
        const client = getFeishuClient(firstAccount);

        // create action doesn't need whiteboard_id; all others do
        if (action !== "create" && !whiteboardId) {
          return json({ error: "whiteboard_id is required for this action" });
        }

        try {
          switch (action) {
            // ── create (insert board block into document) ─────────────
            case "create": {
              const docToken = params.doc_token?.trim();
              if (!docToken) {
                return json({ error: "doc_token is required for create action" });
              }

              // Insert block_type=43 (board) into the document
              // oxlint-disable-next-line typescript/no-explicit-any
              const res = (await client.docx.documentBlockChildren.create({
                path: { document_id: docToken, block_id: docToken },
                data: {
                  children: [{ block_type: 43, board: {} } as never],
                },
                // oxlint-disable-next-line typescript/no-explicit-any
              })) as any;

              if (res.code !== 0) {
                return json({
                  error: `create board failed: code=${res.code} msg=${res.msg}`,
                });
              }

              // Extract whiteboard_id from the created block
              const boardBlock = res.data?.children?.find(
                // oxlint-disable-next-line typescript/no-explicit-any
                (b: any) => b.block_type === 43,
              );
              const wbId =
                boardBlock?.board?.token ?? boardBlock?.board?.board_token ?? boardBlock?.block_id;
              return json({
                ok: true,
                whiteboard_id: wbId,
                block_id: boardBlock?.block_id,
                doc_token: docToken,
              });
            }

            // ── create_nodes ──────────────────────────────────────────
            case "create_nodes": {
              const rawNodes = params.nodes;
              if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
                return json({ error: "nodes array is required and must not be empty" });
              }
              if (rawNodes.length > 3000) {
                return json({ error: "Maximum 3000 nodes per request" });
              }

              const transformed = rawNodes.map(transformNode);

              // Auto-split: connectors with attached_object references can't be in
              // the same batch as the shapes they reference (Feishu 4003101 "doc is
              // applying"). Send non-connectors first, wait, then send connectors
              // with client IDs replaced by server-returned IDs.
              const nonConnectors = transformed.filter((n: NodeInput) => n.type !== "connector");
              const connectors = transformed.filter((n: NodeInput) => n.type === "connector");
              const hasConnectorsWithRefs = connectors.some(
                (c: NodeInput) =>
                  c.connector?.start?.attached_object?.id || c.connector?.end?.attached_object?.id,
              );

              const allIds: string[] = [];

              if (nonConnectors.length > 0) {
                // oxlint-disable-next-line typescript/no-explicit-any
                const res = (await client.board.v1.whiteboardNode.create({
                  path: { whiteboard_id: whiteboardId },
                  data: { nodes: nonConnectors },
                  ...(params.client_token && {
                    params: { client_token: params.client_token },
                  }),
                  // oxlint-disable-next-line typescript/no-explicit-any
                })) as any;
                if (res.code !== 0) {
                  return json({
                    error: `create_nodes (shapes) failed: code=${res.code} msg=${res.msg}`,
                  });
                }
                allIds.push(...(res.data?.ids ?? []));
              }

              if (connectors.length > 0) {
                // If connectors reference shapes from this batch, replace client IDs
                // with server-returned IDs and wait for server to apply.
                if (hasConnectorsWithRefs && nonConnectors.length > 0) {
                  // Build client-ID → server-ID mapping from raw input order
                  const idMap = new Map<string, string>();
                  let serverIdx = 0;
                  for (const raw of rawNodes) {
                    if (raw.type === "connector") continue;
                    if (raw.id && allIds[serverIdx]) {
                      idMap.set(raw.id, allIds[serverIdx]);
                    }
                    serverIdx++;
                  }

                  // Replace client IDs in connector attached_objects
                  for (const c of connectors) {
                    const startId = c.connector?.start?.attached_object?.id;
                    const endId = c.connector?.end?.attached_object?.id;
                    if (startId && idMap.has(startId)) {
                      c.connector.start.attached_object.id = idMap.get(startId);
                    }
                    if (endId && idMap.has(endId)) {
                      c.connector.end.attached_object.id = idMap.get(endId);
                    }
                  }

                  // Wait for server to apply the shapes (~1s)
                  await new Promise((r) => setTimeout(r, 1000));
                }

                // oxlint-disable-next-line typescript/no-explicit-any
                const res = (await client.board.v1.whiteboardNode.create({
                  path: { whiteboard_id: whiteboardId },
                  // oxlint-disable-next-line typescript/no-explicit-any
                  data: { nodes: connectors as any },
                  // oxlint-disable-next-line typescript/no-explicit-any
                })) as any;
                if (res.code !== 0) {
                  return json({
                    error: `create_nodes (connectors) failed: code=${res.code} msg=${res.msg}`,
                    shapes_created: allIds,
                  });
                }
                allIds.push(...(res.data?.ids ?? []));
              }

              return json({
                ok: true,
                created_ids: allIds,
              });
            }

            // ── create_diagram (Mermaid / PlantUML) ───────────────────
            case "create_diagram": {
              const code = params.diagram_code?.trim();
              if (!code) {
                return json({ error: "diagram_code is required" });
              }

              // syntax_type: 1 = PlantUML, 2 = Mermaid
              const syntaxStr = params.diagram_syntax ?? "mermaid";
              const syntaxType = syntaxStr === "plantuml" ? 1 : 2;

              // oxlint-disable-next-line typescript/no-explicit-any
              const res = (await client.board.v1.whiteboardNode.createPlantuml({
                path: { whiteboard_id: whiteboardId },
                data: {
                  plant_uml_code: code,
                  syntax_type: syntaxType,
                },
                // oxlint-disable-next-line typescript/no-explicit-any
              })) as any;

              if (res.code !== 0) {
                return json({
                  error: `create_diagram failed: code=${res.code} msg=${res.msg}`,
                });
              }
              return json({
                ok: true,
                node_id: res.data?.node_id,
              });
            }

            // ── list_nodes ────────────────────────────────────────────
            case "list_nodes": {
              // oxlint-disable-next-line typescript/no-explicit-any
              const res = (await client.board.v1.whiteboardNode.list({
                path: { whiteboard_id: whiteboardId },
                // oxlint-disable-next-line typescript/no-explicit-any
              })) as any;

              if (res.code !== 0) {
                return json({
                  error: `list_nodes failed: code=${res.code} msg=${res.msg}`,
                });
              }
              const nodes = res.data?.nodes;
              // Summarize for context window efficiency
              if (nodes && typeof nodes === "object") {
                const entries = Object.entries(nodes);
                return json({
                  total: entries.length,
                  nodes: entries.slice(0, 100).map(([id, n]: [string, NodeInput]) => ({
                    id,
                    type: n?.type,
                    text: n?.text?.text?.slice(0, 80),
                    x: n?.x,
                    y: n?.y,
                    width: n?.width,
                    height: n?.height,
                  })),
                  ...(entries.length > 100 && { truncated: true }),
                });
              }
              return json({ total: 0, nodes: [] });
            }

            // ── get_theme ─────────────────────────────────────────────
            case "get_theme": {
              // oxlint-disable-next-line typescript/no-explicit-any
              const res = (await client.board.v1.whiteboard.theme({
                path: { whiteboard_id: whiteboardId },
                // oxlint-disable-next-line typescript/no-explicit-any
              })) as any;

              if (res.code !== 0) {
                return json({
                  error: `get_theme failed: code=${res.code} msg=${res.msg}`,
                });
              }
              return json({ theme: res.data?.theme });
            }

            default:
              return json({ error: `Unknown action: ${action}` });
          }
        } catch (err) {
          // Lark SDK throws [AxiosError, {code, msg, error}] on HTTP 4xx
          const larkDetail = extractLarkErrorDetail(err);
          return json({
            error: larkDetail ?? (err instanceof Error ? err.message : String(err)),
          });
        }
      },
    },
    { name: "feishu_board" },
  );
  api.logger.info?.("feishu: registered feishu_board tool");
}
