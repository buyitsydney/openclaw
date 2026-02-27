import { Type } from "@sinclair/typebox";
import { stringEnum } from "openclaw/plugin-sdk";

const UPDATE_FIELDS = [
  "summary",
  "description",
  "due",
  "start",
  "extra",
  "completed_at",
  "repeat_rule",
  "mode",
  "is_milestone",
] as const;

const TASKLIST_UPDATE_FIELDS = ["name", "owner", "archive_tasklist"] as const;

const DATE_SCHEMA = Type.Object({
  timestamp: Type.Optional(
    Type.String({
      description: "Unix timestamp in milliseconds string, e.g. 1735689600000",
    }),
  ),
  is_all_day: Type.Optional(Type.Boolean({ description: "Whether this is an all-day date" })),
});

const MEMBER_SCHEMA = Type.Object({
  id: Type.String({ description: "Member ID (resolved by user_id_type)" }),
  type: Type.Optional(Type.String({ description: "Member type, usually user" })),
  role: Type.String({ description: "Role, e.g. assignee" }),
  name: Type.Optional(Type.String({ description: "Optional display name" })),
});

const TASKLIST_MEMBER_SCHEMA = Type.Object({
  id: Type.String({ description: "Member ID (resolved by user_id_type)" }),
  type: Type.Optional(Type.String({ description: "Member type: user/chat/app" })),
  role: Type.Optional(stringEnum(["owner", "editor", "viewer"] as const)),
  name: Type.Optional(Type.String({ description: "Optional display name" })),
});

const TASKLIST_COLLAB_MEMBER_SCHEMA = Type.Object({
  id: Type.String({ description: "Member ID (resolved by user_id_type)" }),
  type: Type.Optional(Type.String({ description: "Member type: user/chat/app" })),
  role: Type.Optional(stringEnum(["editor", "viewer"] as const)),
  name: Type.Optional(Type.String({ description: "Optional display name" })),
});

const TASKLIST_OWNER_SCHEMA = Type.Object({
  id: Type.String({ description: "Owner user ID (resolved by user_id_type)" }),
  type: Type.Optional(stringEnum(["user"] as const)),
  role: Type.Optional(stringEnum(["owner"] as const)),
  name: Type.Optional(Type.String({ description: "Optional display name" })),
});

const TASKLIST_REF_SCHEMA = Type.Object({
  tasklist_guid: Type.Optional(Type.String({ description: "Tasklist GUID" })),
  section_guid: Type.Optional(Type.String({ description: "Section GUID in tasklist" })),
});

export const CreateTaskSchema = Type.Object({
  summary: Type.String({ description: "Task title" }),
  description: Type.Optional(Type.String({ description: "Task description" })),
  due: Type.Optional(DATE_SCHEMA),
  start: Type.Optional(DATE_SCHEMA),
  extra: Type.Optional(Type.String({ description: "Custom metadata string" })),
  completed_at: Type.Optional(
    Type.String({ description: "Completion time in milliseconds string" }),
  ),
  members: Type.Optional(Type.Array(MEMBER_SCHEMA, { description: "Task members" })),
  repeat_rule: Type.Optional(Type.String({ description: "Task repeat rule" })),
  tasklists: Type.Optional(Type.Array(TASKLIST_REF_SCHEMA, { description: "Tasklist refs" })),
  mode: Type.Optional(Type.Number({ description: "Task mode value from Task API" })),
  is_milestone: Type.Optional(Type.Boolean({ description: "Milestone flag" })),
  user_id_type: Type.Optional(Type.String({ description: "open_id/user_id/union_id" })),
});

export const CreateSubtaskSchema = Type.Object({
  task_guid: Type.String({ description: "Parent task GUID" }),
  summary: Type.String({ description: "Subtask title" }),
  description: Type.Optional(Type.String({ description: "Subtask description" })),
  due: Type.Optional(DATE_SCHEMA),
  start: Type.Optional(DATE_SCHEMA),
  extra: Type.Optional(Type.String({ description: "Custom metadata string" })),
  completed_at: Type.Optional(
    Type.String({ description: "Completion time in milliseconds string" }),
  ),
  members: Type.Optional(Type.Array(MEMBER_SCHEMA, { description: "Subtask members" })),
  repeat_rule: Type.Optional(Type.String({ description: "Subtask repeat rule" })),
  tasklists: Type.Optional(Type.Array(TASKLIST_REF_SCHEMA, { description: "Tasklist refs" })),
  mode: Type.Optional(Type.Number({ description: "Task mode value from Task API" })),
  is_milestone: Type.Optional(Type.Boolean({ description: "Milestone flag" })),
  user_id_type: Type.Optional(Type.String({ description: "open_id/user_id/union_id" })),
});

export const UpdateTaskSchema = Type.Object({
  task_guid: Type.String({ description: "Task GUID to update" }),
  task: Type.Object(
    {
      summary: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      due: Type.Optional(DATE_SCHEMA),
      start: Type.Optional(DATE_SCHEMA),
      extra: Type.Optional(Type.String()),
      completed_at: Type.Optional(Type.String()),
      repeat_rule: Type.Optional(Type.String()),
      mode: Type.Optional(Type.Number()),
      is_milestone: Type.Optional(Type.Boolean()),
    },
    { minProperties: 1 },
  ),
  update_fields: Type.Optional(
    Type.Array(stringEnum(UPDATE_FIELDS), {
      minItems: 1,
      uniqueItems: true,
      description: "Fields to update; if omitted inferred from task object",
    }),
  ),
  user_id_type: Type.Optional(Type.String({ description: "open_id/user_id/union_id" })),
});

export const DeleteTaskSchema = Type.Object({
  task_guid: Type.String({ description: "Task GUID to delete" }),
});

export const GetTaskSchema = Type.Object({
  task_guid: Type.String({ description: "Task GUID to query" }),
  user_id_type: Type.Optional(Type.String({ description: "open_id/user_id/union_id" })),
});

export const CreateTasklistSchema = Type.Object({
  name: Type.String({ description: "Tasklist name" }),
  members: Type.Optional(Type.Array(TASKLIST_MEMBER_SCHEMA, { description: "Initial members" })),
  archive_tasklist: Type.Optional(Type.Boolean({ description: "Create as archived tasklist" })),
  user_id_type: Type.Optional(Type.String({ description: "open_id/user_id/union_id" })),
});

export const GetTasklistSchema = Type.Object({
  tasklist_guid: Type.String({ description: "Tasklist GUID to query" }),
  user_id_type: Type.Optional(Type.String({ description: "open_id/user_id/union_id" })),
});

export const ListTasklistsSchema = Type.Object({
  page_size: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  page_token: Type.Optional(Type.String()),
  user_id_type: Type.Optional(Type.String({ description: "open_id/user_id/union_id" })),
});

export const AddTaskToTasklistSchema = Type.Object({
  task_guid: Type.String({ description: "Task GUID to move" }),
  tasklist_guid: Type.String({ description: "Tasklist GUID to add the task into" }),
  section_guid: Type.Optional(Type.String({ description: "Tasklist section GUID" })),
  user_id_type: Type.Optional(Type.String({ description: "open_id/user_id/union_id" })),
});

export const RemoveTaskFromTasklistSchema = Type.Object({
  task_guid: Type.String({ description: "Task GUID to move" }),
  tasklist_guid: Type.String({ description: "Tasklist GUID to remove from" }),
  user_id_type: Type.Optional(Type.String({ description: "open_id/user_id/union_id" })),
});

export const UpdateTasklistSchema = Type.Object({
  tasklist_guid: Type.String({ description: "Tasklist GUID to update" }),
  tasklist: Type.Object(
    {
      name: Type.Optional(Type.String()),
      owner: Type.Optional(TASKLIST_OWNER_SCHEMA),
      archive_tasklist: Type.Optional(Type.Boolean()),
    },
    { minProperties: 1 },
  ),
  update_fields: Type.Optional(
    Type.Array(stringEnum(TASKLIST_UPDATE_FIELDS), {
      minItems: 1,
      uniqueItems: true,
      description: "Fields to update; if omitted inferred from tasklist object",
    }),
  ),
  origin_owner_to_role: Type.Optional(stringEnum(["editor", "viewer", "none"] as const)),
  user_id_type: Type.Optional(Type.String({ description: "open_id/user_id/union_id" })),
});

export const AddTasklistMembersSchema = Type.Object({
  tasklist_guid: Type.String({ description: "Tasklist GUID to add members to" }),
  members: Type.Array(TASKLIST_COLLAB_MEMBER_SCHEMA, {
    minItems: 1,
    description: "Members to add",
  }),
  user_id_type: Type.Optional(Type.String({ description: "open_id/user_id/union_id" })),
});

export const RemoveTasklistMembersSchema = Type.Object({
  tasklist_guid: Type.String({ description: "Tasklist GUID to remove members from" }),
  members: Type.Array(TASKLIST_COLLAB_MEMBER_SCHEMA, {
    minItems: 1,
    description: "Members to remove",
  }),
  user_id_type: Type.Optional(Type.String({ description: "open_id/user_id/union_id" })),
});

export const DeleteTasklistSchema = Type.Object({
  tasklist_guid: Type.String({ description: "Tasklist GUID to delete" }),
});

export type CreateTaskParams = {
  summary: string;
  description?: string;
  due?: { timestamp?: string; is_all_day?: boolean };
  start?: { timestamp?: string; is_all_day?: boolean };
  extra?: string;
  completed_at?: string;
  members?: Array<{ id: string; type?: string; role: string; name?: string }>;
  repeat_rule?: string;
  tasklists?: Array<{ tasklist_guid?: string; section_guid?: string }>;
  mode?: number;
  is_milestone?: boolean;
  user_id_type?: string;
};
export type CreateSubtaskParams = CreateTaskParams & { task_guid: string };

export type GetTaskParams = { task_guid: string; user_id_type?: string };
export type DeleteTaskParams = { task_guid: string };
export type UpdateTaskParams = {
  task_guid: string;
  task: Record<string, unknown>;
  update_fields?: (typeof UPDATE_FIELDS)[number][];
  user_id_type?: string;
};

export type CreateTasklistParams = {
  name: string;
  members?: Array<{
    id: string;
    type?: string;
    role?: "owner" | "editor" | "viewer";
    name?: string;
  }>;
  archive_tasklist?: boolean;
  user_id_type?: string;
};
export type GetTasklistParams = { tasklist_guid: string; user_id_type?: string };
export type ListTasklistsParams = {
  page_size?: number;
  page_token?: string;
  user_id_type?: string;
};
export type AddTaskToTasklistParams = {
  task_guid: string;
  tasklist_guid: string;
  section_guid?: string;
  user_id_type?: string;
};
export type RemoveTaskFromTasklistParams = {
  task_guid: string;
  tasklist_guid: string;
  user_id_type?: string;
};
export type UpdateTasklistParams = {
  tasklist_guid: string;
  tasklist: Record<string, unknown>;
  update_fields?: (typeof TASKLIST_UPDATE_FIELDS)[number][];
  origin_owner_to_role?: "editor" | "viewer" | "none";
  user_id_type?: string;
};
export type AddTasklistMembersParams = {
  tasklist_guid: string;
  members: Array<{ id: string; type?: string; role?: "editor" | "viewer"; name?: string }>;
  user_id_type?: string;
};
export type RemoveTasklistMembersParams = {
  tasklist_guid: string;
  members: Array<{ id: string; type?: string; role?: "editor" | "viewer"; name?: string }>;
  user_id_type?: string;
};
export type DeleteTasklistParams = {
  tasklist_guid: string;
};

export const TASK_UPDATE_FIELD_VALUES = UPDATE_FIELDS;
export const TASKLIST_UPDATE_FIELD_VALUES = TASKLIST_UPDATE_FIELDS;
