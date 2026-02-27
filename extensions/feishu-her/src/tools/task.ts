/**
 * Feishu Task v2 tools (phase 1 minimal set).
 *
 * Scope:
 * - feishu_task_create/get/update/delete
 * - feishu_tasklist_create/get/list
 */

import type { TSchema } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import { getFeishuClient } from "../outbound.js";
import {
  addTaskToTasklist,
  addTasklistMembers,
  createSubtask,
  createTask,
  createTasklist,
  deleteTasklist,
  deleteTask,
  getTask,
  getTasklist,
  listTasklists,
  removeTaskFromTasklist,
  removeTasklistMembers,
  updateTask,
  updateTasklist,
} from "./task-actions.js";
import { errorResult, json, type TaskClient } from "./task-common.js";
import {
  AddTaskToTasklistSchema,
  type AddTaskToTasklistParams,
  AddTasklistMembersSchema,
  type AddTasklistMembersParams,
  CreateSubtaskSchema,
  type CreateSubtaskParams,
  CreateTaskSchema,
  type CreateTaskParams,
  CreateTasklistSchema,
  type CreateTasklistParams,
  DeleteTasklistSchema,
  type DeleteTasklistParams,
  DeleteTaskSchema,
  type DeleteTaskParams,
  GetTaskSchema,
  type GetTaskParams,
  GetTasklistSchema,
  type GetTasklistParams,
  ListTasklistsSchema,
  type ListTasklistsParams,
  RemoveTaskFromTasklistSchema,
  type RemoveTaskFromTasklistParams,
  RemoveTasklistMembersSchema,
  type RemoveTasklistMembersParams,
  UpdateTaskSchema,
  type UpdateTaskParams,
  UpdateTasklistSchema,
  type UpdateTasklistParams,
} from "./task-schemas.js";

type TaskToolSpec<P> = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  run: (
    args: { client: TaskClient; account: ResolvedFeishuAccount },
    params: P,
  ) => Promise<unknown>;
};

function registerTaskTool<P>(api: OpenClawPluginApi, spec: TaskToolSpec<P>) {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const firstAccount: ResolvedFeishuAccount = accounts[0];
  const getClient = () => getFeishuClient(firstAccount);

  api.registerTool(
    {
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        try {
          const client = getClient();
          return json(
            await spec.run({ client: client as TaskClient, account: firstAccount }, params as P),
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    { name: spec.name },
  );
}

export function registerFeishuTaskTools(api: OpenClawPluginApi) {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;

  registerTaskTool<CreateTaskParams>(api, {
    name: "feishu_task_create",
    label: "Feishu Task Create",
    description: "Create a Feishu task (Task v2)",
    parameters: CreateTaskSchema,
    run: async ({ client }, params) => createTask(client, params),
  });

  registerTaskTool<CreateSubtaskParams>(api, {
    name: "feishu_task_subtask_create",
    label: "Feishu Task Subtask Create",
    description: "Create a Feishu subtask under a parent task (Task v2)",
    parameters: CreateSubtaskSchema,
    run: async ({ client }, params) => createSubtask(client, params),
  });

  registerTaskTool<GetTaskParams>(api, {
    name: "feishu_task_get",
    label: "Feishu Task Get",
    description: "Get a Feishu task by task_guid (Task v2)",
    parameters: GetTaskSchema,
    run: async ({ client }, params) => getTask(client, params),
  });

  registerTaskTool<UpdateTaskParams>(api, {
    name: "feishu_task_update",
    label: "Feishu Task Update",
    description: "Update a Feishu task by task_guid (Task v2 patch)",
    parameters: UpdateTaskSchema,
    run: async ({ client }, params) => updateTask(client, params),
  });

  registerTaskTool<DeleteTaskParams>(api, {
    name: "feishu_task_delete",
    label: "Feishu Task Delete",
    description: "Delete a Feishu task by task_guid (Task v2)",
    parameters: DeleteTaskSchema,
    run: async ({ client }, params) => deleteTask(client, params),
  });

  registerTaskTool<CreateTasklistParams>(api, {
    name: "feishu_tasklist_create",
    label: "Feishu Tasklist Create",
    description: "Create a Feishu tasklist (Task v2)",
    parameters: CreateTasklistSchema,
    run: async ({ client }, params) => createTasklist(client, params),
  });

  registerTaskTool<GetTasklistParams>(api, {
    name: "feishu_tasklist_get",
    label: "Feishu Tasklist Get",
    description: "Get a Feishu tasklist by tasklist_guid (Task v2)",
    parameters: GetTasklistSchema,
    run: async ({ client }, params) => getTasklist(client, params),
  });

  registerTaskTool<ListTasklistsParams>(api, {
    name: "feishu_tasklist_list",
    label: "Feishu Tasklist List",
    description: "List Feishu tasklists (Task v2)",
    parameters: ListTasklistsSchema,
    run: async ({ client }, params) => listTasklists(client, params),
  });

  registerTaskTool<AddTaskToTasklistParams>(api, {
    name: "feishu_task_add_tasklist",
    label: "Feishu Task Add Tasklist",
    description: "Add a task into a tasklist (Task v2)",
    parameters: AddTaskToTasklistSchema,
    run: async ({ client }, params) => addTaskToTasklist(client, params),
  });

  registerTaskTool<RemoveTaskFromTasklistParams>(api, {
    name: "feishu_task_remove_tasklist",
    label: "Feishu Task Remove Tasklist",
    description: "Remove a task from a tasklist (Task v2)",
    parameters: RemoveTaskFromTasklistSchema,
    run: async ({ client }, params) => removeTaskFromTasklist(client, params),
  });

  registerTaskTool<UpdateTasklistParams>(api, {
    name: "feishu_tasklist_update",
    label: "Feishu Tasklist Update",
    description: "Update a Feishu tasklist by tasklist_guid (Task v2 patch)",
    parameters: UpdateTasklistSchema,
    run: async ({ client }, params) => updateTasklist(client, params),
  });

  registerTaskTool<AddTasklistMembersParams>(api, {
    name: "feishu_tasklist_add_members",
    label: "Feishu Tasklist Add Members",
    description: "Add members to a Feishu tasklist (Task v2)",
    parameters: AddTasklistMembersSchema,
    run: async ({ client }, params) => addTasklistMembers(client, params),
  });

  registerTaskTool<RemoveTasklistMembersParams>(api, {
    name: "feishu_tasklist_remove_members",
    label: "Feishu Tasklist Remove Members",
    description: "Remove members from a Feishu tasklist (Task v2)",
    parameters: RemoveTasklistMembersSchema,
    run: async ({ client }, params) => removeTasklistMembers(client, params),
  });

  registerTaskTool<DeleteTasklistParams>(api, {
    name: "feishu_tasklist_delete",
    label: "Feishu Tasklist Delete",
    description: "Delete a Feishu tasklist by tasklist_guid (Task v2)",
    parameters: DeleteTasklistSchema,
    run: async ({ client }, params) => deleteTasklist(client, params),
  });

  api.logger.info?.("feishu: registered feishu_task tools (phase1+collaboration)");
}
