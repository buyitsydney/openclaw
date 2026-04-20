import { beforeEach, describe, expect, it, vi } from "vitest";

const endDiscussionMock = vi.hoisted(() => vi.fn());
const getDiscussionParticipantsMock = vi.hoisted(() => vi.fn());
const resetDiscussionRoomMock = vi.hoisted(() => vi.fn());

vi.mock("../discussion-state.js", () => ({
  endDiscussion: endDiscussionMock,
  getDiscussionParticipants: getDiscussionParticipantsMock,
  resetDiscussionRoom: resetDiscussionRoomMock,
}));

import { registerDiscussionLifecycleTools } from "./discussion-lifecycle.js";

function createToolApi() {
  const tools = new Map<string, any>();
  return {
    api: {
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
    },
    tools,
  };
}

describe("discussion lifecycle tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    endDiscussionMock.mockResolvedValue(true);
    getDiscussionParticipantsMock.mockResolvedValue(["cli_leader", "cli_peer"]);
    resetDiscussionRoomMock.mockResolvedValue({
      chairAppId: "cli_leader",
      ownerAppId: "cli_leader",
      turnId: "turn-20-1",
    });
  });

  it("registers both lifecycle tools", () => {
    const { api, tools } = createToolApi();
    registerDiscussionLifecycleTools(api as any);

    expect([...tools.keys()].sort()).toEqual(["end_discussion", "reset_discussion"]);
  });

  it("ends discussion explicitly", async () => {
    const { api, tools } = createToolApi();
    registerDiscussionLifecycleTools(api as any);

    const result = await tools.get("end_discussion")!.execute("call-1", {
      chat_id: "oc_group",
      turn_id: "turn-20-1",
    });

    expect(endDiscussionMock).toHaveBeenCalledWith("oc_group", "turn-20-1");
    expect(result.details).toMatchObject({
      success: true,
      chat_id: "oc_group",
    });
  });

  it("rejects invalid reset targets before touching state", async () => {
    const { api, tools } = createToolApi();
    registerDiscussionLifecycleTools(api as any);

    const result = await tools.get("reset_discussion")!.execute("call-2", {
      chat_id: "oc_group",
      turn_id: "turn-20-1",
      owner_app_id: "ou_human",
    });

    expect(resetDiscussionRoomMock).not.toHaveBeenCalled();
    expect(result.details).toEqual({
      error: "Invalid owner_app_id, must start with cli_",
    });
  });

  it("resets discussion with explicit owner and leader", async () => {
    const { api, tools } = createToolApi();
    registerDiscussionLifecycleTools(api as any);

    const result = await tools.get("reset_discussion")!.execute("call-3", {
      chat_id: "oc_group",
      turn_id: "turn-20-1",
      owner_app_id: "cli_leader",
      chair_app_id: "cli_leader",
      participant_app_ids: ["cli_leader", "cli_peer"],
    });

    expect(resetDiscussionRoomMock).toHaveBeenCalledWith({
      chatId: "oc_group",
      ownerAppId: "cli_leader",
      chairAppId: "cli_leader",
      participantAppIds: ["cli_leader", "cli_peer"],
      expectedTurnId: "turn-20-1",
    });
    expect(getDiscussionParticipantsMock).toHaveBeenCalledWith("oc_group");
    expect(result.details).toMatchObject({
      success: true,
      leader: "cli_leader",
      owner: "cli_leader",
      turn_id: "turn-20-1",
      participants: ["cli_leader", "cli_peer"],
    });
  });
});
