/**
 * Feishu Board (画板) tool — create nodes, render Mermaid/PlantUML diagrams, list nodes.
 * Uses the Lark SDK's board.v1.whiteboardNode namespace.
 *
 * Limitations (Feishu platform):
 *  - No update/delete API — nodes are append-only via API.
 *  - No whiteboard creation API — boards are created as doc blocks (block_type=43).
 *  - Max 3000 nodes per create call.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts } from "../accounts.js";
import { getFeishuClient } from "../outbound.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ── Actions ────────────────────────────────────────────────────────────────

const BOARD_ACTIONS = ["create_nodes", "create_diagram", "list_nodes", "get_theme"] as const;

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
  "sticky_note",
  "image",
  "svg",
  "group",
  "table",
  "section",
  "mind_map",
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
      "Operation: create_nodes (shapes/connectors/text), create_diagram (Mermaid/PlantUML code), list_nodes, get_theme",
  }),
  whiteboard_id: Type.String({
    description: "Whiteboard token (from doc block_type=43 board.token, or whiteboard URL)",
  }),

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
  if (n.text) {
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

  // Connector
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
        "Create shapes, connectors, text, and diagrams on a Feishu whiteboard (画板). " +
        "Supports flowcharts, mind maps, architecture diagrams via node creation or Mermaid/PlantUML code. " +
        "Note: API is append-only (no update/delete). Boards must already exist in a document.",
      parameters: BoardSchema,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        const action: string = params.action;
        const whiteboardId: string = params.whiteboard_id?.trim();
        if (!whiteboardId) {
          return json({ error: "whiteboard_id is required" });
        }

        const client = getFeishuClient(firstAccount);

        try {
          switch (action) {
            // ── create_nodes ──────────────────────────────────────────
            case "create_nodes": {
              const rawNodes = params.nodes;
              if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
                return json({ error: "nodes array is required and must not be empty" });
              }
              if (rawNodes.length > 3000) {
                return json({ error: "Maximum 3000 nodes per request" });
              }

              const nodes = rawNodes.map(transformNode);
              // oxlint-disable-next-line typescript/no-explicit-any
              const res = (await client.board.v1.whiteboardNode.create({
                path: { whiteboard_id: whiteboardId },
                data: { nodes },
                ...(params.client_token && {
                  params: { client_token: params.client_token },
                }),
                // oxlint-disable-next-line typescript/no-explicit-any
              })) as any;

              if (res.code !== 0) {
                return json({
                  error: `create_nodes failed: code=${res.code} msg=${res.msg}`,
                });
              }
              return json({
                ok: true,
                created_ids: res.data?.ids ?? [],
                client_token: res.data?.client_token,
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
          return json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    },
    { name: "feishu_board" },
  );
  api.logger.info?.("feishu: registered feishu_board tool");
}
