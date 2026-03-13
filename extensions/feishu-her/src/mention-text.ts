export function formatFeishuAtText(params: { userId?: unknown; userName?: unknown }): string {
  const userId = typeof params.userId === "string" ? params.userId.trim() : "";
  const userName = typeof params.userName === "string" ? params.userName.trim() : "";

  if (userId === "all" || userId === "@all" || userId === "@_all") {
    return "@所有人";
  }

  if (userName) {
    return `@${userName}`;
  }

  if (!userId) {
    return "";
  }

  return userId.startsWith("@") ? userId : `@${userId}`;
}
