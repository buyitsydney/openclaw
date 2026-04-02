import { callFeishuApiWithUserToken } from "../oauth.js";

type DriveListApiEntry = {
  token?: string;
  name?: string;
  type?: string;
  url?: string;
  created_time?: string;
  modified_time?: string;
  owner_id?: string;
  parent_token?: string;
};

type DriveListResponse = {
  files?: DriveListApiEntry[];
  next_page_token?: string;
};

export type DriveBrowseItem = {
  token?: string;
  name?: string;
  type?: string;
  url?: string;
  created_time?: string;
  modified_time?: string;
  owner_id?: string;
  parent_token?: string;
};

function normalizeDriveItem(item: DriveListApiEntry): DriveBrowseItem {
  return {
    token: item.token,
    name: item.name,
    type: item.type,
    url: item.url,
    created_time: item.created_time,
    modified_time: item.modified_time,
    owner_id: item.owner_id,
    parent_token: item.parent_token,
  };
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function scoreTitleMatch(title: string, query: string): number {
  const normalizedTitle = normalizeSearchText(title);
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedTitle || !normalizedQuery) return Number.POSITIVE_INFINITY;
  if (normalizedTitle === normalizedQuery) return 0;
  if (normalizedTitle.startsWith(normalizedQuery)) return 1;
  if (normalizedTitle.includes(normalizedQuery)) return 2;
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => normalizedTitle.includes(token))) {
    return 3;
  }
  return Number.POSITIVE_INFINITY;
}

export async function listDriveItemsByUser(
  userToken: string,
  folderToken?: string,
): Promise<{ files: DriveBrowseItem[]; next_page_token?: string }> {
  const res = await callFeishuApiWithUserToken<DriveListResponse>({
    method: "GET",
    endpoint: "/drive/v1/files",
    userToken,
    ...(folderToken ? { query: { folder_token: folderToken } } : {}),
  });
  if (res.code !== 0) {
    throw new Error(`Drive list failed: code=${res.code} msg=${res.msg}`);
  }
  return {
    files: (res.data?.files ?? []).map(normalizeDriveItem),
    next_page_token: res.data?.next_page_token,
  };
}

export async function searchRootDriveItemsByTitle(
  userToken: string,
  query: string,
  options?: { limit?: number; types?: string[] },
): Promise<Array<Required<Pick<DriveBrowseItem, "token" | "name" | "type">> & DriveBrowseItem>> {
  const root = await listDriveItemsByUser(userToken);
  const matched = root.files.filter(
    (item): item is Required<Pick<DriveBrowseItem, "token" | "name" | "type">> & DriveBrowseItem =>
      typeof item.token === "string" &&
      item.token.trim().length > 0 &&
      typeof item.name === "string" &&
      item.name.trim().length > 0 &&
      typeof item.type === "string" &&
      item.type.trim().length > 0 &&
      (options?.types === undefined || options.types.includes(item.type.trim())) &&
      Number.isFinite(scoreTitleMatch(item.name, query)),
  );

  matched.sort(
    (a, b) =>
      scoreTitleMatch(a.name, query) - scoreTitleMatch(b.name, query) ||
      a.name.localeCompare(b.name, "zh-Hans-CN") ||
      a.token.localeCompare(b.token),
  );

  return matched.slice(0, Math.max(1, options?.limit ?? 5));
}
