/**
 * Feishu Directory tool — list users, departments, search contacts.
 * Uses contact v3 APIs (requires contact:contact.base:readonly scope, already granted).
 *
 * Note: Feishu personal edition returns limited user fields (no name).
 * Enterprise edition returns full user info including name, department, etc.
 */

import type * as Lark from "@larksuiteoapi/node-sdk";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import {
  callFeishuApiWithUserToken,
  getValidUserToken,
  requireUserToken,
  resolveOAuthRedirectUri,
} from "../oauth.js";
import { getFeishuClient } from "../outbound.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ── Actions ──

/** List users in a department (or root department "0" for all users). */
async function listUsers(
  client: Lark.Client,
  departmentId?: string,
  pageSize?: number,
  pageToken?: string,
) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.contact.user.findByDepartment({
    params: {
      department_id: departmentId ?? "0",
      department_id_type: "department_id",
      page_size: pageSize ?? 50,
      ...(pageToken && { page_token: pageToken }),
    },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    users: (res.data?.items ?? []).map((u: any) => ({
      open_id: u.open_id,
      union_id: u.union_id,
      user_id: u.user_id,
      name: u.name,
      en_name: u.en_name,
      nickname: u.nickname,
      email: u.email,
      mobile: u.mobile,
      avatar: u.avatar?.avatar_72,
      department_ids: u.department_ids,
      status: u.status?.is_activated ? "active" : "inactive",
    })),
    has_more: res.data?.has_more ?? false,
    page_token: res.data?.page_token,
  };
}

/** Get info for a single user by open_id, union_id, or user_id. */
async function getUser(client: Lark.Client, userId: string, userIdType?: string) {
  // Auto-detect ID type from prefix
  const idType =
    userIdType ??
    (userId.startsWith("ou_") ? "open_id" : userId.startsWith("on_") ? "union_id" : "user_id");
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.contact.user.get({
    path: { user_id: userId },
    params: { user_id_type: idType as "open_id" | "union_id" | "user_id" },
  });
  if (res.code !== 0) throw new Error(res.msg);
  const u = res.data?.user;
  return {
    open_id: u?.open_id,
    union_id: u?.union_id,
    user_id: u?.user_id,
    name: u?.name,
    en_name: u?.en_name,
    nickname: u?.nickname,
    email: u?.email,
    mobile: u?.mobile,
    avatar: u?.avatar?.avatar_72,
    department_ids: u?.department_ids,
    status: u?.status?.is_activated ? "active" : "inactive",
  };
}

/** List departments. */
async function listDepartments(
  client: Lark.Client,
  parentDepartmentId?: string,
  pageSize?: number,
  pageToken?: string,
) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.contact.department.list({
    params: {
      parent_department_id: parentDepartmentId ?? "0",
      department_id_type: "department_id",
      page_size: pageSize ?? 50,
      fetch_child: true,
      ...(pageToken && { page_token: pageToken }),
    },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    departments: (res.data?.items ?? []).map((d: any) => ({
      department_id: d.department_id,
      open_department_id: d.open_department_id,
      name: d.name,
      parent_department_id: d.parent_department_id,
      member_count: d.member_count,
      leader_user_id: d.leader_user_id,
      status: d.status?.is_deleted ? "deleted" : "active",
    })),
    has_more: res.data?.has_more ?? false,
    page_token: res.data?.page_token,
  };
}

/** Search users by name keyword. Requires user_access_token (OAuth). */
async function searchUsers(
  userToken: string,
  query: string,
  pageSize?: number,
  pageToken?: string,
) {
  const params: Record<string, string> = {
    query,
    page_size: String(Math.min(pageSize ?? 20, 200)),
  };
  if (pageToken) params.page_token = pageToken;

  const res = await callFeishuApiWithUserToken<{
    users?: {
      avatar?: { avatar_72?: string };
      name?: string;
      open_id?: string;
      user_id?: string;
      department_ids?: string[];
    }[];
    has_more?: boolean;
    page_token?: string;
  }>({
    method: "GET",
    endpoint: "/search/v1/user",
    userToken,
    query: params,
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    users: (res.data?.users ?? []).map((u: any) => ({
      open_id: u.open_id,
      user_id: u.user_id,
      name: u.name,
      avatar: u.avatar?.avatar_72,
      department_ids: u.department_ids,
    })),
    has_more: res.data?.has_more ?? false,
    page_token: res.data?.page_token,
  };
}

// ── Schema ──

const DIRECTORY_ACTIONS = ["search_users", "list_users", "get_user", "list_departments"] as const;

const FeishuDirectorySchema = Type.Object({
  action: stringEnum(DIRECTORY_ACTIONS, {
    description:
      "Directory operation: search_users (search by name keyword, PREFERRED for finding people), " +
      "list_users (by department), get_user (single user info by ID), list_departments",
  }),
  query: Type.Optional(
    Type.String({
      description:
        "Search keyword for search_users. Matches against user names. Required for search_users.",
    }),
  ),
  user_id: Type.Optional(Type.String({ description: "User ID (ou_/on_/user_id) for get_user" })),
  user_id_type: Type.Optional(
    Type.String({
      description: "ID type: open_id, union_id, or user_id. Auto-detected from prefix if omitted",
    }),
  ),
  department_id: Type.Optional(
    Type.String({
      description: "Department ID for list_users/list_departments. Use '0' for root (default)",
    }),
  ),
  page_size: Type.Optional(
    Type.Number({ description: "Results per page (default 20 for search, 50 for list)" }),
  ),
  page_token: Type.Optional(Type.String({ description: "Pagination token for next page" })),
});

// ── Registration ──

export function registerFeishuDirectoryTools(api: OpenClawPluginApi) {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const firstAccount: ResolvedFeishuAccount = accounts[0];
  const getClient = () => getFeishuClient(firstAccount);
  const redirectUri = resolveOAuthRedirectUri(api.config);

  api.registerTool(
    {
      name: "feishu_directory",
      label: "Feishu Directory",
      description:
        "Feishu contacts/directory lookup. Actions: search_users (search by name keyword — PREFERRED way to find people), " +
        "list_users (list users in a department), get_user (single user by open_id/union_id), list_departments. " +
        "Use search_users first when looking for someone by name. Requires OAuth for search_users.",
      parameters: FeishuDirectorySchema,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        try {
          switch (params.action) {
            case "search_users": {
              if (!params.query)
                return json({ error: "query is required for search_users action" });
              const tokenResult = await requireUserToken({
                account: firstAccount,
                redirectUri,
                tokenPromise: getValidUserToken(firstAccount),
                toolLabel: "通讯录搜索",
              });
              if (!tokenResult.ok) return tokenResult.authResponse;
              return json(
                await searchUsers(
                  tokenResult.token.access_token,
                  params.query,
                  params.page_size,
                  params.page_token,
                ),
              );
            }
            case "list_users": {
              const client = getClient();
              return json(
                await listUsers(client, params.department_id, params.page_size, params.page_token),
              );
            }
            case "get_user": {
              if (!params.user_id)
                return json({ error: "user_id is required for get_user action" });
              const client = getClient();
              return json(await getUser(client, params.user_id, params.user_id_type));
            }
            case "list_departments": {
              const client = getClient();
              return json(
                await listDepartments(
                  client,
                  params.department_id,
                  params.page_size,
                  params.page_token,
                ),
              );
            }
            default:
              return json({ error: `Unknown action: ${params.action}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_directory" },
  );
  api.logger.info?.("feishu: registered feishu_directory tool (with search_users)");
}
