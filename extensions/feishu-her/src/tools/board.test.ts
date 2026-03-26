/**
 * board.test.ts — Tests for feishu_board tool (whiteboard node creation, diagram rendering, listing).
 */

import { describe, expect, it, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────

const getFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("../outbound.js", () => ({
  getFeishuClient: getFeishuClientMock,
}));

vi.mock("../accounts.js", () => ({
  listEnabledFeishuAccounts: vi.fn(() => [
    {
      accountId: "default",
      enabled: true,
      appId: "cli_test",
      appSecret: "sec_test",
      credentialSource: "config",
      config: { dm: {}, groups: {} },
    },
  ]),
}));

import { registerFeishuBoardTools } from "./board.js";

// ── Helpers ───────────────────────────────────────────────────────────────

type ToolDef = {
  name: string;
  description: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ details: unknown }>;
};

function createApi() {
  const registerTool = vi.fn();
  return {
    registerTool,
    api: {
      config: {},
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
      registerTool,
    } as never,
  };
}

function getTool(registerTool: ReturnType<typeof vi.fn>): ToolDef {
  const tool = registerTool.mock.calls[0]?.[0] as ToolDef | undefined;
  expect(tool).toBeDefined();
  expect(tool!.name).toBe("feishu_board");
  return tool!;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("feishu_board tool", () => {
  it("registers the tool", () => {
    const { api, registerTool } = createApi();
    registerFeishuBoardTools(api);
    expect(registerTool).toHaveBeenCalledOnce();
    const tool = getTool(registerTool);
    expect(tool.name).toBe("feishu_board");
    expect(tool.description).toContain("whiteboard");
  });

  it("create inserts board block into document and returns whiteboard_id", async () => {
    const createChildrenMock = vi.fn(async () => ({
      code: 0,
      data: {
        children: [
          {
            block_id: "doxcn_board_block",
            block_type: 43,
            board: { token: "wb_new_123", align: 1 },
            parent_id: "doc_abc",
          },
        ],
      },
    }));
    getFeishuClientMock.mockReturnValue({
      docx: { documentBlockChildren: { create: createChildrenMock } },
      board: {
        v1: {
          whiteboardNode: { create: vi.fn(), createPlantuml: vi.fn(), list: vi.fn() },
          whiteboard: { theme: vi.fn() },
        },
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuBoardTools(api);
    const tool = getTool(registerTool);

    const result = await tool.execute("call_create", {
      action: "create",
      doc_token: "doc_abc",
    });

    expect(createChildrenMock).toHaveBeenCalledOnce();
    const payload = createChildrenMock.mock.calls[0][0];
    expect(payload.path.document_id).toBe("doc_abc");
    expect(payload.data.children[0].block_type).toBe(43);

    // oxlint-disable-next-line typescript/no-explicit-any
    const details = result.details as any;
    expect(details.ok).toBe(true);
    expect(details.whiteboard_id).toBe("wb_new_123");
    expect(details.block_id).toBe("doxcn_board_block");
  });

  it("create rejects missing doc_token", async () => {
    getFeishuClientMock.mockReturnValue({
      docx: { documentBlockChildren: { create: vi.fn() } },
      board: {
        v1: {
          whiteboardNode: { create: vi.fn(), createPlantuml: vi.fn(), list: vi.fn() },
          whiteboard: { theme: vi.fn() },
        },
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuBoardTools(api);
    const tool = getTool(registerTool);

    const result = await tool.execute("call_create_no_doc", {
      action: "create",
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    expect((result.details as any).error).toContain("doc_token is required");
  });

  it("create_nodes auto-splits shapes and connectors into two calls", async () => {
    const createMock = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, data: { ids: ["o1:1"] } }) // shapes call
      .mockResolvedValueOnce({ code: 0, data: { ids: ["c1:1"] } }); // connectors call
    getFeishuClientMock.mockReturnValue({
      board: {
        v1: {
          whiteboardNode: { create: createMock, createPlantuml: vi.fn(), list: vi.fn() },
          whiteboard: { theme: vi.fn() },
        },
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuBoardTools(api);
    const tool = getTool(registerTool);

    const result = await tool.execute("call_1", {
      action: "create_nodes",
      whiteboard_id: "wb_abc",
      nodes: [
        {
          id: "my_shape",
          type: "composite_shape",
          shape_type: "round_rect",
          x: 100,
          y: 200,
          width: 200,
          height: 100,
          text: "Start",
          fill_color: "#4CAF50",
        },
        {
          type: "connector",
          start_node_id: "my_shape",
          end_node_id: "ext_node",
          end_arrow: "triangle_arrow",
        },
      ],
    });

    // Two API calls: shapes first, then connectors
    expect(createMock).toHaveBeenCalledTimes(2);

    // First call: only shapes
    const shapesPayload = createMock.mock.calls[0][0];
    expect(shapesPayload.data.nodes).toHaveLength(1);
    expect(shapesPayload.data.nodes[0].type).toBe("composite_shape");
    expect(shapesPayload.data.nodes[0].composite_shape).toEqual({ type: "round_rect" });
    expect(shapesPayload.data.nodes[0].text).toEqual({ text: "Start" });
    expect(shapesPayload.data.nodes[0].style).toEqual({ fill_color: "#4CAF50" });

    // Second call: connectors with client ID replaced by server ID
    const connPayload = createMock.mock.calls[1][0];
    expect(connPayload.data.nodes).toHaveLength(1);
    const conn = connPayload.data.nodes[0];
    expect(conn.type).toBe("connector");
    expect(conn.connector.start.attached_object.id).toBe("o1:1"); // replaced!
    expect(conn.connector.end.attached_object.id).toBe("ext_node"); // external, unchanged
    expect(conn.connector.end.arrow_style).toBe("triangle_arrow");

    // oxlint-disable-next-line typescript/no-explicit-any
    const details = result.details as any;
    expect(details.ok).toBe(true);
    expect(details.created_ids).toEqual(["o1:1", "c1:1"]);
  });

  it("create_nodes rejects empty array", async () => {
    getFeishuClientMock.mockReturnValue({
      board: {
        v1: {
          whiteboardNode: { create: vi.fn(), createPlantuml: vi.fn(), list: vi.fn() },
          whiteboard: { theme: vi.fn() },
        },
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuBoardTools(api);
    const tool = getTool(registerTool);

    const result = await tool.execute("call_2", {
      action: "create_nodes",
      whiteboard_id: "wb_abc",
      nodes: [],
    });
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((result.details as any).error).toContain("must not be empty");
  });

  it("create_diagram sends Mermaid code to SDK", async () => {
    const createPlantumlMock = vi.fn(async () => ({
      code: 0,
      data: { node_id: "diagram_1" },
    }));
    getFeishuClientMock.mockReturnValue({
      board: {
        v1: {
          whiteboardNode: { create: vi.fn(), createPlantuml: createPlantumlMock, list: vi.fn() },
          whiteboard: { theme: vi.fn() },
        },
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuBoardTools(api);
    const tool = getTool(registerTool);

    const result = await tool.execute("call_3", {
      action: "create_diagram",
      whiteboard_id: "wb_abc",
      diagram_code: "graph TD\n  A-->B",
      diagram_syntax: "mermaid",
    });

    expect(createPlantumlMock).toHaveBeenCalledOnce();
    const payload = createPlantumlMock.mock.calls[0][0];
    expect(payload.data.plant_uml_code).toBe("graph TD\n  A-->B");
    expect(payload.data.syntax_type).toBe(2); // 2 = Mermaid

    // oxlint-disable-next-line typescript/no-explicit-any
    expect((result.details as any).ok).toBe(true);
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((result.details as any).node_id).toBe("diagram_1");
  });

  it("create_diagram defaults to Mermaid when no syntax specified", async () => {
    const createPlantumlMock = vi.fn(async () => ({ code: 0, data: { node_id: "d2" } }));
    getFeishuClientMock.mockReturnValue({
      board: {
        v1: {
          whiteboardNode: { create: vi.fn(), createPlantuml: createPlantumlMock, list: vi.fn() },
          whiteboard: { theme: vi.fn() },
        },
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuBoardTools(api);
    const tool = getTool(registerTool);

    await tool.execute("call_4", {
      action: "create_diagram",
      whiteboard_id: "wb_abc",
      diagram_code: "graph LR\n  X-->Y",
    });

    expect(createPlantumlMock.mock.calls[0][0].data.syntax_type).toBe(2);
  });

  it("create_diagram sends PlantUML with syntax_type=1", async () => {
    const createPlantumlMock = vi.fn(async () => ({ code: 0, data: { node_id: "d3" } }));
    getFeishuClientMock.mockReturnValue({
      board: {
        v1: {
          whiteboardNode: { create: vi.fn(), createPlantuml: createPlantumlMock, list: vi.fn() },
          whiteboard: { theme: vi.fn() },
        },
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuBoardTools(api);
    const tool = getTool(registerTool);

    await tool.execute("call_5", {
      action: "create_diagram",
      whiteboard_id: "wb_abc",
      diagram_code: "@startuml\nAlice -> Bob\n@enduml",
      diagram_syntax: "plantuml",
    });

    expect(createPlantumlMock.mock.calls[0][0].data.syntax_type).toBe(1);
  });

  it("list_nodes returns summarized node list", async () => {
    const listMock = vi.fn(async () => ({
      code: 0,
      data: {
        nodes: {
          n1: {
            type: "composite_shape",
            text: { text: "Hello World" },
            x: 10,
            y: 20,
            width: 100,
            height: 50,
          },
          n2: { type: "connector", x: 0, y: 0 },
        },
      },
    }));
    getFeishuClientMock.mockReturnValue({
      board: {
        v1: {
          whiteboardNode: { create: vi.fn(), createPlantuml: vi.fn(), list: listMock },
          whiteboard: { theme: vi.fn() },
        },
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuBoardTools(api);
    const tool = getTool(registerTool);

    const result = await tool.execute("call_6", {
      action: "list_nodes",
      whiteboard_id: "wb_abc",
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    const details = result.details as any;
    expect(details.total).toBe(2);
    expect(details.nodes[0].id).toBe("n1");
    expect(details.nodes[0].type).toBe("composite_shape");
    expect(details.nodes[0].text).toBe("Hello World");
  });

  it("get_theme returns theme", async () => {
    const themeMock = vi.fn(async () => ({
      code: 0,
      data: { theme: "minimalist_gray" },
    }));
    getFeishuClientMock.mockReturnValue({
      board: {
        v1: {
          whiteboardNode: { create: vi.fn(), createPlantuml: vi.fn(), list: vi.fn() },
          whiteboard: { theme: themeMock },
        },
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuBoardTools(api);
    const tool = getTool(registerTool);

    const result = await tool.execute("call_7", {
      action: "get_theme",
      whiteboard_id: "wb_abc",
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    expect((result.details as any).theme).toBe("minimalist_gray");
  });

  it("returns error for missing whiteboard_id", async () => {
    getFeishuClientMock.mockReturnValue({
      board: {
        v1: {
          whiteboardNode: { create: vi.fn(), createPlantuml: vi.fn(), list: vi.fn() },
          whiteboard: { theme: vi.fn() },
        },
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuBoardTools(api);
    const tool = getTool(registerTool);

    const result = await tool.execute("call_8", {
      action: "list_nodes",
      whiteboard_id: "",
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    expect((result.details as any).error).toContain("whiteboard_id is required");
  });

  it("handles SDK errors gracefully", async () => {
    const createMock = vi.fn(async () => ({
      code: 99991668,
      msg: "permission denied",
    }));
    getFeishuClientMock.mockReturnValue({
      board: {
        v1: {
          whiteboardNode: { create: createMock, createPlantuml: vi.fn(), list: vi.fn() },
          whiteboard: { theme: vi.fn() },
        },
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuBoardTools(api);
    const tool = getTool(registerTool);

    const result = await tool.execute("call_9", {
      action: "create_nodes",
      whiteboard_id: "wb_abc",
      nodes: [{ type: "text_shape", text: "test", x: 0, y: 0 }],
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    expect((result.details as any).error).toContain("permission denied");
  });

  it("handles network exceptions gracefully", async () => {
    const createMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    getFeishuClientMock.mockReturnValue({
      board: {
        v1: {
          whiteboardNode: { create: createMock, createPlantuml: vi.fn(), list: vi.fn() },
          whiteboard: { theme: vi.fn() },
        },
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuBoardTools(api);
    const tool = getTool(registerTool);

    const result = await tool.execute("call_10", {
      action: "create_nodes",
      whiteboard_id: "wb_abc",
      nodes: [{ type: "text_shape", text: "test", x: 0, y: 0 }],
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    expect((result.details as any).error).toContain("ECONNREFUSED");
  });
});
