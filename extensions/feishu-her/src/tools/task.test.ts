import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledFeishuAccountsMock = vi.hoisted(() => vi.fn());
const getFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("../accounts.js", () => ({
  listEnabledFeishuAccounts: listEnabledFeishuAccountsMock,
}));

vi.mock("../outbound.js", () => ({
  getFeishuClient: getFeishuClientMock,
}));

import { registerFeishuTaskTools } from "./task.js";

type ToolDef = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ details: unknown }>;
};

describe("feishu-her task tools", () => {
  const taskCreateMock = vi.hoisted(() => vi.fn());
  const taskGetMock = vi.hoisted(() => vi.fn());
  const taskPatchMock = vi.hoisted(() => vi.fn());
  const taskSubtaskCreateMock = vi.hoisted(() => vi.fn());
  const taskAddTasklistMock = vi.hoisted(() => vi.fn());
  const taskRemoveTasklistMock = vi.hoisted(() => vi.fn());
  const taskDeleteMock = vi.hoisted(() => vi.fn());
  const tasklistCreateMock = vi.hoisted(() => vi.fn());
  const tasklistGetMock = vi.hoisted(() => vi.fn());
  const tasklistListMock = vi.hoisted(() => vi.fn());
  const tasklistPatchMock = vi.hoisted(() => vi.fn());
  const tasklistAddMembersMock = vi.hoisted(() => vi.fn());
  const tasklistRemoveMembersMock = vi.hoisted(() => vi.fn());
  const tasklistDeleteMock = vi.hoisted(() => vi.fn());
  const taskCommentCreateMock = vi.hoisted(() => vi.fn());
  const taskCommentListMock = vi.hoisted(() => vi.fn());
  const taskCommentGetMock = vi.hoisted(() => vi.fn());
  const taskCommentPatchMock = vi.hoisted(() => vi.fn());
  const taskCommentDeleteMock = vi.hoisted(() => vi.fn());
  const taskAttachmentUploadMock = vi.hoisted(() => vi.fn());
  const taskAttachmentListMock = vi.hoisted(() => vi.fn());
  const taskAttachmentGetMock = vi.hoisted(() => vi.fn());
  const taskAttachmentDeleteMock = vi.hoisted(() => vi.fn());
  const tasklistTasksMock = vi.hoisted(() => vi.fn());
  const sectionTasksMock = vi.hoisted(() => vi.fn());

  beforeEach(() => {
    vi.clearAllMocks();
    listEnabledFeishuAccountsMock.mockReturnValue([
      {
        accountId: "default",
        enabled: true,
        appId: "cli_x",
        appSecret: "secret_x",
      },
    ]);
    getFeishuClientMock.mockReturnValue({
      task: {
        v2: {
          task: {
            create: taskCreateMock,
            get: taskGetMock,
            patch: taskPatchMock,
            addTasklist: taskAddTasklistMock,
            removeTasklist: taskRemoveTasklistMock,
            delete: taskDeleteMock,
          },
          taskSubtask: {
            create: taskSubtaskCreateMock,
          },
          tasklist: {
            create: tasklistCreateMock,
            get: tasklistGetMock,
            list: tasklistListMock,
            patch: tasklistPatchMock,
            addMembers: tasklistAddMembersMock,
            removeMembers: tasklistRemoveMembersMock,
            delete: tasklistDeleteMock,
            tasks: tasklistTasksMock,
          },
          comment: {
            create: taskCommentCreateMock,
            list: taskCommentListMock,
            get: taskCommentGetMock,
            patch: taskCommentPatchMock,
            delete: taskCommentDeleteMock,
          },
          attachment: {
            upload: taskAttachmentUploadMock,
            list: taskAttachmentListMock,
            get: taskAttachmentGetMock,
            delete: taskAttachmentDeleteMock,
          },
          section: {
            tasks: sectionTasksMock,
          },
        },
      },
    });
    taskCreateMock.mockResolvedValue({ code: 0, data: { task: { guid: "t_1", summary: "todo" } } });
    taskGetMock.mockResolvedValue({ code: 0, data: { task: { guid: "t_1", summary: "todo" } } });
    taskPatchMock.mockResolvedValue({ code: 0, data: { task: { guid: "t_1", summary: "todo2" } } });
    taskDeleteMock.mockResolvedValue({ code: 0 });
    taskSubtaskCreateMock.mockResolvedValue({
      code: 0,
      data: { subtask: { guid: "st_1", summary: "sub" } },
    });
    taskAddTasklistMock.mockResolvedValue({ code: 0, data: { task: { guid: "t_1" } } });
    taskRemoveTasklistMock.mockResolvedValue({ code: 0, data: { task: { guid: "t_1" } } });
    tasklistCreateMock.mockResolvedValue({
      code: 0,
      data: { tasklist: { guid: "tl_1", name: "Work" } },
    });
    tasklistGetMock.mockResolvedValue({
      code: 0,
      data: { tasklist: { guid: "tl_1", name: "Work" } },
    });
    tasklistListMock.mockResolvedValue({
      code: 0,
      data: { items: [{ guid: "tl_1", name: "Work" }], has_more: false },
    });
    tasklistPatchMock.mockResolvedValue({
      code: 0,
      data: { tasklist: { guid: "tl_1", name: "Work2" } },
    });
    tasklistAddMembersMock.mockResolvedValue({
      code: 0,
      data: { tasklist: { guid: "tl_1", members: [{ id: "ou_1", role: "editor" }] } },
    });
    tasklistRemoveMembersMock.mockResolvedValue({
      code: 0,
      data: { tasklist: { guid: "tl_1", members: [] } },
    });
    tasklistDeleteMock.mockResolvedValue({ code: 0 });
    taskCommentCreateMock.mockResolvedValue({ code: 0, data: { comment: { id: "c_1" } } });
    taskCommentListMock.mockResolvedValue({
      code: 0,
      data: { items: [{ id: "c_1" }], has_more: false },
    });
    taskCommentGetMock.mockResolvedValue({ code: 0, data: { comment: { id: "c_1" } } });
    taskCommentPatchMock.mockResolvedValue({ code: 0, data: { comment: { id: "c_1" } } });
    taskCommentDeleteMock.mockResolvedValue({ code: 0 });
    taskAttachmentUploadMock.mockResolvedValue({ items: [{ guid: "a_1" }] });
    taskAttachmentListMock.mockResolvedValue({
      code: 0,
      data: { items: [{ guid: "a_1" }], has_more: false },
    });
    taskAttachmentGetMock.mockResolvedValue({ code: 0, data: { attachment: { guid: "a_1" } } });
    taskAttachmentDeleteMock.mockResolvedValue({ code: 0 });
    tasklistTasksMock.mockResolvedValue({
      code: 0,
      data: { items: [{ guid: "t_1" }], has_more: false },
    });
    sectionTasksMock.mockResolvedValue({
      code: 0,
      data: { items: [{ guid: "t_1" }], has_more: false },
    });
  });

  function registerAndGetTools() {
    const registerTool = vi.fn();
    registerFeishuTaskTools({
      config: { channels: { feishu: { enabled: true } } },
      logger: { info: vi.fn() },
      registerTool,
    } as never);
    const tools = registerTool.mock.calls.map((call) => call[0] as ToolDef);
    return { tools };
  }

  function getTool(tools: ToolDef[], name: string): ToolDef {
    const tool = tools.find((t) => t.name === name);
    expect(tool).toBeDefined();
    return tool!;
  }

  it("registers task tools including collaboration set", () => {
    const { tools } = registerAndGetTools();
    expect(tools.map((t) => t.name)).toEqual([
      "feishu_task_create",
      "feishu_task_subtask_create",
      "feishu_task_get",
      "feishu_task_update",
      "feishu_task_delete",
      "feishu_tasklist_create",
      "feishu_tasklist_get",
      "feishu_tasklist_list",
      "feishu_task_add_tasklist",
      "feishu_task_remove_tasklist",
      "feishu_tasklist_update",
      "feishu_tasklist_add_members",
      "feishu_tasklist_remove_members",
      "feishu_tasklist_delete",
      "feishu_task_comment_create",
      "feishu_task_comment_list",
      "feishu_task_comment_get",
      "feishu_task_comment_update",
      "feishu_task_comment_delete",
      "feishu_task_attachment_upload",
      "feishu_task_attachment_list",
      "feishu_task_attachment_get",
      "feishu_task_attachment_delete",
      "feishu_tasklist_tasks",
      "feishu_section_tasks",
    ]);
  });

  it("create/get/delete task work", async () => {
    const { tools } = registerAndGetTools();
    const createTool = getTool(tools, "feishu_task_create");
    const getToolDef = getTool(tools, "feishu_task_get");
    const deleteTool = getTool(tools, "feishu_task_delete");

    const createRes = await createTool.execute("tc1", { summary: "todo" });
    const getRes = await getToolDef.execute("tc2", { task_guid: "t_1" });
    const delRes = await deleteTool.execute("tc3", { task_guid: "t_1" });

    expect(taskCreateMock).toHaveBeenCalledTimes(1);
    expect(taskGetMock).toHaveBeenCalledTimes(1);
    expect(taskDeleteMock).toHaveBeenCalledTimes(1);
    expect((createRes.details as { task?: { guid?: string } }).task?.guid).toBe("t_1");
    expect((getRes.details as { task?: { guid?: string } }).task?.guid).toBe("t_1");
    expect((delRes.details as { success?: boolean }).success).toBe(true);
  });

  it("update infers update_fields from task payload", async () => {
    const { tools } = registerAndGetTools();
    const updateTool = getTool(tools, "feishu_task_update");
    await updateTool.execute("tc4", {
      task_guid: "t_1",
      task: { summary: "new summary" },
    });

    expect(taskPatchMock).toHaveBeenCalledTimes(1);
    const arg = taskPatchMock.mock.calls[0]?.[0] as {
      data: { update_fields: string[]; task: { summary: string } };
    };
    expect(arg.data.update_fields).toEqual(["summary"]);
    expect(arg.data.task.summary).toBe("new summary");
  });

  it("update rejects unsupported update_fields", async () => {
    const { tools } = registerAndGetTools();
    const updateTool = getTool(tools, "feishu_task_update");
    const res = await updateTool.execute("tc5", {
      task_guid: "t_1",
      task: { summary: "x" },
      update_fields: ["not_allowed"],
    });

    const details = res.details as { error?: string };
    expect(details.error).toContain("unsupported task update_fields");
    expect(taskPatchMock).not.toHaveBeenCalled();
  });

  it("tasklist create/get/list work", async () => {
    const { tools } = registerAndGetTools();
    const createTool = getTool(tools, "feishu_tasklist_create");
    const getToolDef = getTool(tools, "feishu_tasklist_get");
    const listTool = getTool(tools, "feishu_tasklist_list");

    const c = await createTool.execute("tc6", { name: "Work" });
    const g = await getToolDef.execute("tc7", { tasklist_guid: "tl_1" });
    const l = await listTool.execute("tc8", { page_size: 20 });

    expect(tasklistCreateMock).toHaveBeenCalledTimes(1);
    expect(tasklistGetMock).toHaveBeenCalledTimes(1);
    expect(tasklistListMock).toHaveBeenCalledTimes(1);
    expect((c.details as { tasklist?: { guid?: string } }).tasklist?.guid).toBe("tl_1");
    expect((g.details as { tasklist?: { guid?: string } }).tasklist?.guid).toBe("tl_1");
    expect((l.details as { items?: unknown[] }).items?.length).toBe(1);
  });

  it("collaboration tools work", async () => {
    const { tools } = registerAndGetTools();
    const subtaskTool = getTool(tools, "feishu_task_subtask_create");
    const addTasklistTool = getTool(tools, "feishu_task_add_tasklist");
    const removeTasklistTool = getTool(tools, "feishu_task_remove_tasklist");
    const updateTasklistTool = getTool(tools, "feishu_tasklist_update");
    const addMembersTool = getTool(tools, "feishu_tasklist_add_members");
    const removeMembersTool = getTool(tools, "feishu_tasklist_remove_members");
    const deleteTasklistTool = getTool(tools, "feishu_tasklist_delete");

    await subtaskTool.execute("tc9", { task_guid: "t_1", summary: "sub" });
    await addTasklistTool.execute("tc10", { task_guid: "t_1", tasklist_guid: "tl_1" });
    await removeTasklistTool.execute("tc11", { task_guid: "t_1", tasklist_guid: "tl_1" });
    await updateTasklistTool.execute("tc12", {
      tasklist_guid: "tl_1",
      tasklist: { name: "Work2" },
    });
    await addMembersTool.execute("tc13", {
      tasklist_guid: "tl_1",
      members: [{ id: "ou_1", role: "editor", type: "user" }],
    });
    await removeMembersTool.execute("tc14", {
      tasklist_guid: "tl_1",
      members: [{ id: "ou_1", role: "editor", type: "user" }],
    });
    const delRes = await deleteTasklistTool.execute("tc15", { tasklist_guid: "tl_1" });

    expect(taskSubtaskCreateMock).toHaveBeenCalledTimes(1);
    expect(taskAddTasklistMock).toHaveBeenCalledTimes(1);
    expect(taskRemoveTasklistMock).toHaveBeenCalledTimes(1);
    expect(tasklistPatchMock).toHaveBeenCalledTimes(1);
    expect(tasklistAddMembersMock).toHaveBeenCalledTimes(1);
    expect(tasklistRemoveMembersMock).toHaveBeenCalledTimes(1);
    expect(tasklistDeleteMock).toHaveBeenCalledTimes(1);
    expect((delRes.details as { success?: boolean }).success).toBe(true);
  });

  it("rejects owner role for tasklist members locally", async () => {
    const { tools } = registerAndGetTools();
    const addMembersTool = getTool(tools, "feishu_tasklist_add_members");
    const removeMembersTool = getTool(tools, "feishu_tasklist_remove_members");

    const addRes = await addMembersTool.execute("tc16", {
      tasklist_guid: "tl_1",
      members: [{ id: "ou_1", role: "owner", type: "user" }],
    });
    const removeRes = await removeMembersTool.execute("tc17", {
      tasklist_guid: "tl_1",
      members: [{ id: "ou_1", role: "owner", type: "user" }],
    });

    expect((addRes.details as { error?: string }).error).toContain("only editor/viewer allowed");
    expect((removeRes.details as { error?: string }).error).toContain("only editor/viewer allowed");
    expect(tasklistAddMembersMock).not.toHaveBeenCalled();
    expect(tasklistRemoveMembersMock).not.toHaveBeenCalled();
  });

  it("rejects non-user owner.type for tasklist update locally", async () => {
    const { tools } = registerAndGetTools();
    const updateTasklistTool = getTool(tools, "feishu_tasklist_update");

    const res = await updateTasklistTool.execute("tc18", {
      tasklist_guid: "tl_1",
      tasklist: {
        owner: { id: "cli_bot", type: "app", role: "owner" },
      },
      update_fields: ["owner"],
    });

    expect((res.details as { error?: string }).error).toContain("only user is allowed");
    expect(tasklistPatchMock).not.toHaveBeenCalled();
  });

  it("comment/attachment/section tools work", async () => {
    const { tools } = registerAndGetTools();
    const createCommentTool = getTool(tools, "feishu_task_comment_create");
    const listCommentTool = getTool(tools, "feishu_task_comment_list");
    const getCommentTool = getTool(tools, "feishu_task_comment_get");
    const updateCommentTool = getTool(tools, "feishu_task_comment_update");
    const deleteCommentTool = getTool(tools, "feishu_task_comment_delete");
    const uploadAttachmentTool = getTool(tools, "feishu_task_attachment_upload");
    const listAttachmentTool = getTool(tools, "feishu_task_attachment_list");
    const getAttachmentTool = getTool(tools, "feishu_task_attachment_get");
    const deleteAttachmentTool = getTool(tools, "feishu_task_attachment_delete");
    const listTasklistTasksTool = getTool(tools, "feishu_tasklist_tasks");
    const listSectionTasksTool = getTool(tools, "feishu_section_tasks");

    const tmpFile = path.join(os.tmpdir(), "feishu-task-upload-test.txt");
    fs.writeFileSync(tmpFile, "ok");
    await createCommentTool.execute("tc19", { task_guid: "t_1", content: "hello" });
    await listCommentTool.execute("tc20", { task_guid: "t_1" });
    await getCommentTool.execute("tc21", { comment_id: "c_1" });
    await updateCommentTool.execute("tc22", { comment_id: "c_1", comment: { content: "new" } });
    await deleteCommentTool.execute("tc23", { comment_id: "c_1" });
    await uploadAttachmentTool.execute("tc24", { task_guid: "t_1", file_path: tmpFile });
    await listAttachmentTool.execute("tc25", { task_guid: "t_1" });
    await getAttachmentTool.execute("tc26", { attachment_guid: "a_1" });
    await deleteAttachmentTool.execute("tc27", { attachment_guid: "a_1" });
    await listTasklistTasksTool.execute("tc28", { tasklist_guid: "tl_1" });
    await listSectionTasksTool.execute("tc29", { section_guid: "sec_1" });

    expect(taskCommentCreateMock).toHaveBeenCalledTimes(1);
    expect(taskCommentListMock).toHaveBeenCalledTimes(1);
    expect(taskCommentGetMock).toHaveBeenCalledTimes(1);
    expect(taskCommentPatchMock).toHaveBeenCalledTimes(1);
    expect(taskCommentDeleteMock).toHaveBeenCalledTimes(1);
    expect(taskAttachmentUploadMock).toHaveBeenCalledTimes(1);
    expect(taskAttachmentListMock).toHaveBeenCalledTimes(1);
    expect(taskAttachmentGetMock).toHaveBeenCalledTimes(1);
    expect(taskAttachmentDeleteMock).toHaveBeenCalledTimes(1);
    expect(tasklistTasksMock).toHaveBeenCalledTimes(1);
    expect(sectionTasksMock).toHaveBeenCalledTimes(1);

    const createCommentArg = taskCommentCreateMock.mock.calls[0]?.[0] as {
      data: { resource_type: string; resource_id: string; content: string };
    };
    expect(createCommentArg.data.resource_type).toBe("task");
    expect(createCommentArg.data.resource_id).toBe("t_1");
    expect(createCommentArg.data.content).toBe("hello");

    const listCommentArg = taskCommentListMock.mock.calls[0]?.[0] as {
      params: { resource_type: string; resource_id: string };
    };
    expect(listCommentArg.params.resource_type).toBe("task");
    expect(listCommentArg.params.resource_id).toBe("t_1");
  });
});
