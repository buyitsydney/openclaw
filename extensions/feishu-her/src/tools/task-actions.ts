import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/feishu";
import type { TaskClient } from "./task-common.js";
import { runTaskApiCall } from "./task-common.js";
import { toUnixMsStr } from "./time-utils.js";

// oxlint-disable-next-line typescript/no-explicit-any
function normalizeDateParam(due: any): any {
  if (!due?.timestamp) return due;
  return { ...due, timestamp: toUnixMsStr(due.timestamp) };
}
import type {
  AddTaskMembersParams,
  AddTaskToTasklistParams,
  AddTasklistMembersParams,
  CreateSubtaskParams,
  CreateTaskParams,
  CreateTasklistParams,
  DeleteTasklistParams,
  CreateTaskCommentParams,
  ListTaskCommentsParams,
  GetTaskCommentParams,
  UpdateTaskCommentParams,
  DeleteTaskCommentParams,
  UploadTaskAttachmentParams,
  ListTaskAttachmentsParams,
  GetTaskAttachmentParams,
  DeleteTaskAttachmentParams,
  ListTasklistTasksParams,
  ListSectionTasksParams,
  DeleteTaskParams,
  GetTaskParams,
  GetTasklistParams,
  ListTasklistsParams,
  RemoveTaskFromTasklistParams,
  RemoveTaskMembersParams,
  RemoveTasklistMembersParams,
  UpdateTaskParams,
  UpdateTasklistParams,
} from "./task-schemas.js";
import { TASK_UPDATE_FIELD_VALUES, TASKLIST_UPDATE_FIELD_VALUES } from "./task-schemas.js";

const TASK_UPDATE_FIELD_SET = new Set<string>(TASK_UPDATE_FIELD_VALUES);
const TASKLIST_UPDATE_FIELD_SET = new Set<string>(TASKLIST_UPDATE_FIELD_VALUES);

function omitUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function inferUpdateFields(task: Record<string, unknown>, fieldSet: Set<string>): string[] {
  return Object.keys(task).filter((k) => fieldSet.has(k));
}

function ensureSupportedUpdateFields(
  updateFields: string[],
  fieldSet: Set<string>,
  resource: "task" | "tasklist",
) {
  const invalid = updateFields.filter((f) => !fieldSet.has(f));
  if (invalid.length > 0) {
    throw new Error(`unsupported ${resource} update_fields: ${invalid.join(", ")}`);
  }
}

function ensureTasklistMemberRoles(
  members: Array<{ role?: string }>,
  resource: "tasklist.add_members" | "tasklist.remove_members",
) {
  const invalid = members
    .map((m) => m.role)
    .filter((role): role is string => !!role && role !== "editor" && role !== "viewer");
  if (invalid.length > 0) {
    throw new Error(
      `unsupported ${resource} member roles: ${invalid.join(", ")} (only editor/viewer allowed)`,
    );
  }
}

function ensureTasklistOwnerType(owner: Record<string, unknown> | undefined) {
  if (!owner) return;
  const ownerType = owner.type;
  if (ownerType !== undefined && ownerType !== "user") {
    throw new Error("unsupported tasklist owner.type: only user is allowed");
  }
}

function formatTask(task: Record<string, unknown> | undefined) {
  if (!task) return undefined;
  return {
    guid: task.guid,
    task_id: task.task_id,
    summary: task.summary,
    description: task.description,
    status: task.status,
    url: task.url,
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at,
    due: task.due,
    start: task.start,
    is_milestone: task.is_milestone,
    members: task.members,
    tasklists: task.tasklists,
  };
}

function formatTasklist(tasklist: Record<string, unknown> | undefined) {
  if (!tasklist) return undefined;
  return {
    guid: tasklist.guid,
    name: tasklist.name,
    creator: tasklist.creator,
    owner: tasklist.owner,
    members: tasklist.members,
    url: tasklist.url,
    created_at: tasklist.created_at,
    updated_at: tasklist.updated_at,
    archive_msec: tasklist.archive_msec,
  };
}

function formatComment(comment: Record<string, unknown> | undefined) {
  if (!comment) return undefined;
  return {
    comment_id: comment.id,
    content: comment.content,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    creator: comment.creator,
    task_guid: comment.resource_id,
    reply_to_comment_id: comment.reply_to_comment_id,
  };
}

function formatAttachment(attachment: Record<string, unknown> | undefined) {
  if (!attachment) return undefined;
  return {
    guid: attachment.guid,
    file_token: attachment.file_token,
    name: attachment.name,
    size: attachment.size,
    uploader: attachment.uploader,
    is_cover: attachment.is_cover,
    uploaded_at: attachment.uploaded_at,
    url: attachment.url,
    resource: attachment.resource,
  };
}

function ensureAttachmentSource(params: UploadTaskAttachmentParams) {
  const hasPath = !!params.file_path;
  const hasUrl = !!params.file_url;
  if ((hasPath && hasUrl) || (!hasPath && !hasUrl)) {
    throw new Error("attachment upload requires exactly one of file_path or file_url");
  }
}

async function downloadToTempFile(fileUrl: string, filename?: string) {
  const res = await fetch(fileUrl);
  if (!res.ok) {
    throw new Error(`failed to download file_url: HTTP ${res.status}`);
  }
  const arr = await res.arrayBuffer();
  const buffer = Buffer.from(arr);
  const parsedName = (() => {
    try {
      return path.basename(new URL(fileUrl).pathname);
    } catch {
      return "";
    }
  })();
  const name = (filename?.trim() || parsedName || "attachment.bin").replace(/[^\w.\-]/g, "_");
  const tmpPath = path.join(
    resolvePreferredOpenClawTmpDir(),
    `feishu-task-attachment-${Date.now()}-${crypto.randomBytes(8).toString("hex")}-${name}`,
  );
  await fs.promises.writeFile(tmpPath, buffer);
  return {
    path: tmpPath,
    cleanup: async () => {
      await fs.promises.unlink(tmpPath).catch(() => undefined);
    },
  };
}

export async function createTask(client: TaskClient, params: CreateTaskParams) {
  const c = client as unknown as {
    task: { v2: { task: { create: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const res = await runTaskApiCall("task.v2.task.create", () =>
    c.task.v2.task.create({
      data: omitUndefined({
        summary: params.summary,
        description: params.description,
        due: normalizeDateParam(params.due),
        start: normalizeDateParam(params.start),
        extra: params.extra,
        completed_at: params.completed_at,
        members: params.members,
        repeat_rule: params.repeat_rule,
        tasklists: params.tasklists,
        mode: params.mode,
        is_milestone: params.is_milestone,
      }),
      params: omitUndefined({ user_id_type: params.user_id_type }),
    }),
  );
  return { task: formatTask((res.data as { task?: Record<string, unknown> } | undefined)?.task) };
}

export async function createSubtask(client: TaskClient, params: CreateSubtaskParams) {
  const c = client as unknown as {
    task: { v2: { taskSubtask: { create: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const res = await runTaskApiCall("task.v2.taskSubtask.create", () =>
    c.task.v2.taskSubtask.create({
      path: { task_guid: params.task_guid },
      data: omitUndefined({
        summary: params.summary,
        description: params.description,
        due: normalizeDateParam(params.due),
        start: normalizeDateParam(params.start),
        extra: params.extra,
        completed_at: params.completed_at,
        members: params.members,
        repeat_rule: params.repeat_rule,
        tasklists: params.tasklists,
        mode: params.mode,
        is_milestone: params.is_milestone,
      }),
      params: omitUndefined({ user_id_type: params.user_id_type }),
    }),
  );
  return {
    subtask: formatTask((res.data as { subtask?: Record<string, unknown> } | undefined)?.subtask),
  };
}

export async function getTask(client: TaskClient, params: GetTaskParams) {
  const c = client as unknown as {
    task: { v2: { task: { get: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const res = await runTaskApiCall("task.v2.task.get", () =>
    c.task.v2.task.get({
      path: { task_guid: params.task_guid },
      params: omitUndefined({ user_id_type: params.user_id_type }),
    }),
  );
  return { task: formatTask((res.data as { task?: Record<string, unknown> } | undefined)?.task) };
}

export async function deleteTask(client: TaskClient, params: DeleteTaskParams) {
  const c = client as unknown as {
    task: { v2: { task: { delete: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  await runTaskApiCall("task.v2.task.delete", () =>
    c.task.v2.task.delete({
      path: { task_guid: params.task_guid },
    }),
  );
  return { success: true, task_guid: params.task_guid };
}

export async function addTaskMembers(client: TaskClient, params: AddTaskMembersParams) {
  const c = client as unknown as {
    task: { v2: { task: { addMembers: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const res = await runTaskApiCall("task.v2.task.addMembers", () =>
    c.task.v2.task.addMembers({
      path: { task_guid: params.task_guid },
      data: { members: params.members },
      params: omitUndefined({ user_id_type: params.user_id_type }),
    }),
  );
  return { task: formatTask((res.data as { task?: Record<string, unknown> } | undefined)?.task) };
}

export async function removeTaskMembers(client: TaskClient, params: RemoveTaskMembersParams) {
  const c = client as unknown as {
    task: { v2: { task: { removeMembers: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const res = await runTaskApiCall("task.v2.task.removeMembers", () =>
    c.task.v2.task.removeMembers({
      path: { task_guid: params.task_guid },
      data: { members: params.members },
      params: omitUndefined({ user_id_type: params.user_id_type }),
    }),
  );
  return { task: formatTask((res.data as { task?: Record<string, unknown> } | undefined)?.task) };
}

export async function updateTask(client: TaskClient, params: UpdateTaskParams) {
  const c = client as unknown as {
    task: { v2: { task: { patch: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const rawTask = omitUndefined(params.task);
  // Normalize ISO 8601 date params before sending to Feishu API
  if (rawTask.due) rawTask.due = normalizeDateParam(rawTask.due);
  if (rawTask.start) rawTask.start = normalizeDateParam(rawTask.start);
  const taskBody = rawTask;
  const updateFields = params.update_fields?.length
    ? [...params.update_fields]
    : inferUpdateFields(taskBody, TASK_UPDATE_FIELD_SET);
  if (params.update_fields?.length) {
    ensureSupportedUpdateFields(updateFields, TASK_UPDATE_FIELD_SET, "task");
  }
  if (Object.keys(taskBody).length === 0) {
    throw new Error("task update payload is empty");
  }
  if (updateFields.length === 0) {
    throw new Error("no valid update_fields provided or inferred from task payload");
  }

  const res = await runTaskApiCall("task.v2.task.patch", () =>
    c.task.v2.task.patch({
      path: { task_guid: params.task_guid },
      data: { task: taskBody, update_fields: updateFields },
      params: omitUndefined({ user_id_type: params.user_id_type }),
    }),
  );
  return {
    task: formatTask((res.data as { task?: Record<string, unknown> } | undefined)?.task),
    update_fields: updateFields,
  };
}

export async function addTaskToTasklist(client: TaskClient, params: AddTaskToTasklistParams) {
  const c = client as unknown as {
    task: { v2: { task: { addTasklist: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const res = await runTaskApiCall("task.v2.task.add_tasklist", () =>
    c.task.v2.task.addTasklist({
      path: { task_guid: params.task_guid },
      data: omitUndefined({
        tasklist_guid: params.tasklist_guid,
        section_guid: params.section_guid,
      }),
      params: omitUndefined({ user_id_type: params.user_id_type }),
    }),
  );
  return { task: formatTask((res.data as { task?: Record<string, unknown> } | undefined)?.task) };
}

export async function removeTaskFromTasklist(
  client: TaskClient,
  params: RemoveTaskFromTasklistParams,
) {
  const c = client as unknown as {
    task: { v2: { task: { removeTasklist: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const res = await runTaskApiCall("task.v2.task.remove_tasklist", () =>
    c.task.v2.task.removeTasklist({
      path: { task_guid: params.task_guid },
      data: { tasklist_guid: params.tasklist_guid },
      params: omitUndefined({ user_id_type: params.user_id_type }),
    }),
  );
  return { task: formatTask((res.data as { task?: Record<string, unknown> } | undefined)?.task) };
}

export async function createTasklist(client: TaskClient, params: CreateTasklistParams) {
  const c = client as unknown as {
    task: { v2: { tasklist: { create: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const res = await runTaskApiCall("task.v2.tasklist.create", () =>
    c.task.v2.tasklist.create({
      data: omitUndefined({
        name: params.name,
        members: params.members,
        archive_tasklist: params.archive_tasklist,
      }),
      params: omitUndefined({ user_id_type: params.user_id_type }),
    }),
  );
  return {
    tasklist: formatTasklist(
      (res.data as { tasklist?: Record<string, unknown> } | undefined)?.tasklist,
    ),
  };
}

export async function getTasklist(client: TaskClient, params: GetTasklistParams) {
  const c = client as unknown as {
    task: { v2: { tasklist: { get: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const res = await runTaskApiCall("task.v2.tasklist.get", () =>
    c.task.v2.tasklist.get({
      path: { tasklist_guid: params.tasklist_guid },
      params: omitUndefined({ user_id_type: params.user_id_type }),
    }),
  );
  return {
    tasklist: formatTasklist(
      (res.data as { tasklist?: Record<string, unknown> } | undefined)?.tasklist,
    ),
  };
}

export async function listTasklists(client: TaskClient, params: ListTasklistsParams) {
  const c = client as unknown as {
    task: { v2: { tasklist: { list: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const res = await runTaskApiCall("task.v2.tasklist.list", () =>
    c.task.v2.tasklist.list({
      params: omitUndefined({
        page_size: params.page_size,
        page_token: params.page_token,
        user_id_type: params.user_id_type,
      }),
    }),
  );
  const items = ((res.data as { items?: Record<string, unknown>[] } | undefined)?.items ?? []).map(
    (item) => formatTasklist(item),
  );
  const data = res.data as { page_token?: string; has_more?: boolean } | undefined;
  return { items, page_token: data?.page_token, has_more: data?.has_more };
}

export async function updateTasklist(client: TaskClient, params: UpdateTasklistParams) {
  const c = client as unknown as {
    task: { v2: { tasklist: { patch: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const tasklistBody = omitUndefined(params.tasklist);
  ensureTasklistOwnerType(tasklistBody.owner as Record<string, unknown> | undefined);
  const updateFields = params.update_fields?.length
    ? [...params.update_fields]
    : inferUpdateFields(tasklistBody, TASKLIST_UPDATE_FIELD_SET);
  if (params.update_fields?.length) {
    ensureSupportedUpdateFields(updateFields, TASKLIST_UPDATE_FIELD_SET, "tasklist");
  }
  if (Object.keys(tasklistBody).length === 0) {
    throw new Error("tasklist update payload is empty");
  }
  if (updateFields.length === 0) {
    throw new Error("no valid update_fields provided or inferred from tasklist payload");
  }

  const res = await runTaskApiCall("task.v2.tasklist.patch", () =>
    c.task.v2.tasklist.patch({
      path: { tasklist_guid: params.tasklist_guid },
      data: omitUndefined({
        tasklist: tasklistBody,
        update_fields: updateFields,
        origin_owner_to_role: params.origin_owner_to_role,
      }),
      params: omitUndefined({ user_id_type: params.user_id_type }),
    }),
  );
  return {
    tasklist: formatTasklist(
      (res.data as { tasklist?: Record<string, unknown> } | undefined)?.tasklist,
    ),
    update_fields: updateFields,
  };
}

export async function addTasklistMembers(client: TaskClient, params: AddTasklistMembersParams) {
  const c = client as unknown as {
    task: { v2: { tasklist: { addMembers: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  ensureTasklistMemberRoles(params.members, "tasklist.add_members");
  const res = await runTaskApiCall("task.v2.tasklist.addMembers", () =>
    c.task.v2.tasklist.addMembers({
      path: { tasklist_guid: params.tasklist_guid },
      data: { members: params.members },
      params: omitUndefined({ user_id_type: params.user_id_type }),
    }),
  );
  return {
    tasklist: formatTasklist(
      (res.data as { tasklist?: Record<string, unknown> } | undefined)?.tasklist,
    ),
  };
}

export async function removeTasklistMembers(
  client: TaskClient,
  params: RemoveTasklistMembersParams,
) {
  const c = client as unknown as {
    task: {
      v2: { tasklist: { removeMembers: (args: unknown) => Promise<Record<string, unknown>> } };
    };
  };
  ensureTasklistMemberRoles(params.members, "tasklist.remove_members");
  const res = await runTaskApiCall("task.v2.tasklist.removeMembers", () =>
    c.task.v2.tasklist.removeMembers({
      path: { tasklist_guid: params.tasklist_guid },
      data: { members: params.members },
      params: omitUndefined({ user_id_type: params.user_id_type }),
    }),
  );
  return {
    tasklist: formatTasklist(
      (res.data as { tasklist?: Record<string, unknown> } | undefined)?.tasklist,
    ),
  };
}

export async function deleteTasklist(client: TaskClient, params: DeleteTasklistParams) {
  const c = client as unknown as {
    task: { v2: { tasklist: { delete: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  await runTaskApiCall("task.v2.tasklist.delete", () =>
    c.task.v2.tasklist.delete({
      path: { tasklist_guid: params.tasklist_guid },
    }),
  );
  return { success: true, tasklist_guid: params.tasklist_guid };
}

export async function createTaskComment(client: TaskClient, params: CreateTaskCommentParams) {
  const c = client as unknown as {
    task: { v2: { comment: { create: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const res = await runTaskApiCall("task.v2.comment.create", () =>
    c.task.v2.comment.create({
      data: omitUndefined({
        resource_type: "task",
        resource_id: params.task_guid,
        content: params.content,
        reply_to_comment_id: params.reply_to_comment_id,
      }),
      params: omitUndefined({ user_id_type: params.user_id_type }),
    }),
  );
  return {
    comment: formatComment(
      (res.data as { comment?: Record<string, unknown> } | undefined)?.comment,
    ),
  };
}

export async function listTaskComments(client: TaskClient, params: ListTaskCommentsParams) {
  const c = client as unknown as {
    task: { v2: { comment: { list: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const res = await runTaskApiCall("task.v2.comment.list", () =>
    c.task.v2.comment.list({
      params: omitUndefined({
        resource_type: "task",
        resource_id: params.task_guid,
        page_size: params.page_size,
        page_token: params.page_token,
        direction: params.direction,
        user_id_type: params.user_id_type,
      }),
    }),
  );
  const data = res.data as
    | {
        items?: Record<string, unknown>[];
        page_token?: string;
        has_more?: boolean;
      }
    | undefined;
  return {
    items: (data?.items ?? []).map((i) => formatComment(i)),
    page_token: data?.page_token,
    has_more: data?.has_more,
  };
}

export async function getTaskComment(client: TaskClient, params: GetTaskCommentParams) {
  const c = client as unknown as {
    task: { v2: { comment: { get: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const res = await runTaskApiCall("task.v2.comment.get", () =>
    c.task.v2.comment.get({
      path: { comment_id: params.comment_id },
      params: omitUndefined({ user_id_type: params.user_id_type }),
    }),
  );
  return {
    comment: formatComment(
      (res.data as { comment?: Record<string, unknown> } | undefined)?.comment,
    ),
  };
}

export async function updateTaskComment(client: TaskClient, params: UpdateTaskCommentParams) {
  const c = client as unknown as {
    task: { v2: { comment: { patch: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const commentBody = omitUndefined(params.comment as Record<string, unknown>);
  const updateFields =
    params.update_fields?.length && params.update_fields.length > 0
      ? params.update_fields
      : Object.keys(commentBody);
  if (Object.keys(commentBody).length === 0) {
    throw new Error("task comment update payload is empty");
  }
  if (updateFields.length === 0) {
    throw new Error("no valid update_fields provided or inferred from comment payload");
  }
  const res = await runTaskApiCall("task.v2.comment.patch", () =>
    c.task.v2.comment.patch({
      path: { comment_id: params.comment_id },
      data: { comment: commentBody, update_fields: updateFields },
      params: omitUndefined({ user_id_type: params.user_id_type }),
    }),
  );
  return {
    comment: formatComment(
      (res.data as { comment?: Record<string, unknown> } | undefined)?.comment,
    ),
    update_fields: updateFields,
  };
}

export async function deleteTaskComment(client: TaskClient, params: DeleteTaskCommentParams) {
  const c = client as unknown as {
    task: { v2: { comment: { delete: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  await runTaskApiCall("task.v2.comment.delete", () =>
    c.task.v2.comment.delete({
      path: { comment_id: params.comment_id },
    }),
  );
  return { success: true, comment_id: params.comment_id };
}

export async function uploadTaskAttachment(client: TaskClient, params: UploadTaskAttachmentParams) {
  ensureAttachmentSource(params);
  const c = client as unknown as {
    task: { v2: { attachment: { upload: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  let uploadPath = params.file_path;
  let cleanup: (() => Promise<void>) | undefined;
  if (params.file_url) {
    const tmp = await downloadToTempFile(params.file_url, params.filename);
    uploadPath = tmp.path;
    cleanup = tmp.cleanup;
  }

  try {
    const res = await runTaskApiCall("task.v2.attachment.upload", () =>
      c.task.v2.attachment.upload({
        data: {
          resource_type: "task",
          resource_id: params.task_guid,
          file: fs.createReadStream(uploadPath!),
        },
        params: omitUndefined({ user_id_type: params.user_id_type }),
      }),
    );
    const data = res as { items?: Record<string, unknown>[] } | undefined;
    return { items: (data?.items ?? []).map((i) => formatAttachment(i)) };
  } finally {
    if (cleanup) await cleanup();
  }
}

export async function listTaskAttachments(client: TaskClient, params: ListTaskAttachmentsParams) {
  const c = client as unknown as {
    task: { v2: { attachment: { list: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const res = await runTaskApiCall("task.v2.attachment.list", () =>
    c.task.v2.attachment.list({
      params: omitUndefined({
        resource_type: "task",
        resource_id: params.task_guid,
        page_size: params.page_size,
        page_token: params.page_token,
        updated_mesc: params.updated_mesc,
        user_id_type: params.user_id_type,
      }),
    }),
  );
  const data = res.data as
    | { items?: Record<string, unknown>[]; page_token?: string; has_more?: boolean }
    | undefined;
  return {
    items: (data?.items ?? []).map((i) => formatAttachment(i)),
    page_token: data?.page_token,
    has_more: data?.has_more,
  };
}

export async function getTaskAttachment(client: TaskClient, params: GetTaskAttachmentParams) {
  const c = client as unknown as {
    task: { v2: { attachment: { get: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const res = await runTaskApiCall("task.v2.attachment.get", () =>
    c.task.v2.attachment.get({
      path: { attachment_guid: params.attachment_guid },
      params: omitUndefined({ user_id_type: params.user_id_type }),
    }),
  );
  return {
    attachment: formatAttachment(
      (res.data as { attachment?: Record<string, unknown> } | undefined)?.attachment,
    ),
  };
}

export async function deleteTaskAttachment(client: TaskClient, params: DeleteTaskAttachmentParams) {
  const c = client as unknown as {
    task: { v2: { attachment: { delete: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  await runTaskApiCall("task.v2.attachment.delete", () =>
    c.task.v2.attachment.delete({
      path: { attachment_guid: params.attachment_guid },
    }),
  );
  return { success: true, attachment_guid: params.attachment_guid };
}

export async function listTasklistTasks(client: TaskClient, params: ListTasklistTasksParams) {
  const c = client as unknown as {
    task: { v2: { tasklist: { tasks: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const res = await runTaskApiCall("task.v2.tasklist.tasks", () =>
    c.task.v2.tasklist.tasks({
      path: { tasklist_guid: params.tasklist_guid },
      params: omitUndefined({
        page_size: params.page_size,
        page_token: params.page_token,
        user_id_type: params.user_id_type,
      }),
    }),
  );
  const data = res.data as
    | { items?: Record<string, unknown>[]; page_token?: string; has_more?: boolean }
    | undefined;
  return {
    items: (data?.items ?? []).map((i) => formatTask(i)),
    page_token: data?.page_token,
    has_more: data?.has_more,
  };
}

export async function listSectionTasks(client: TaskClient, params: ListSectionTasksParams) {
  const c = client as unknown as {
    task: { v2: { section: { tasks: (args: unknown) => Promise<Record<string, unknown>> } } };
  };
  const res = await runTaskApiCall("task.v2.section.tasks", () =>
    c.task.v2.section.tasks({
      path: { section_guid: params.section_guid },
      params: omitUndefined({
        page_size: params.page_size,
        page_token: params.page_token,
        user_id_type: params.user_id_type,
      }),
    }),
  );
  const data = res.data as
    | { items?: Record<string, unknown>[]; page_token?: string; has_more?: boolean }
    | undefined;
  return {
    items: (data?.items ?? []).map((i) => formatTask(i)),
    page_token: data?.page_token,
    has_more: data?.has_more,
  };
}
