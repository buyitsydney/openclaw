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

export type FeishuAtTextMention = {
  key: string;
  id: string;
  name?: string;
  renderedText: string;
};

const FEISHU_USER_AT_TAG_RE = /<at\s+user_id="([^"]+)">([^<]*)<\/at>/gi;
const FEISHU_EMPTY_USER_AT_TAG_RE = /<at\s+user_id="([^"]+)"\s*\/>/gi;
const FEISHU_CARD_AT_TAG_RE = /<at\s+id="?([^"\s>]+)"?\s*><\/at>/gi;

function pushMention(
  mentions: FeishuAtTextMention[],
  seenKeys: Set<string>,
  params: { key: string; id: string; name?: string },
): void {
  const key = params.key.trim();
  const id = params.id.trim();
  const name = params.name?.trim() || undefined;
  if (!key || !id || seenKeys.has(key)) {
    return;
  }
  seenKeys.add(key);
  mentions.push({
    key,
    id,
    ...(name && { name }),
    renderedText: formatFeishuAtText({ userId: id, userName: name }),
  });
}

export function extractFeishuAtTextMentions(text: string): FeishuAtTextMention[] {
  const mentions: FeishuAtTextMention[] = [];
  const seenKeys = new Set<string>();

  for (const match of text.matchAll(FEISHU_USER_AT_TAG_RE)) {
    const [key = "", id = "", rawName = ""] = match;
    pushMention(mentions, seenKeys, { key, id, name: rawName });
  }

  for (const match of text.matchAll(FEISHU_EMPTY_USER_AT_TAG_RE)) {
    const [key = "", id = ""] = match;
    pushMention(mentions, seenKeys, { key, id });
  }

  for (const match of text.matchAll(FEISHU_CARD_AT_TAG_RE)) {
    const [key = "", id = ""] = match;
    pushMention(mentions, seenKeys, { key, id });
  }

  return mentions;
}
