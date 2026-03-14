import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedFeishuAccount } from "./accounts.js";

const messageCreateMock = vi.hoisted(() =>
  vi.fn(async () => ({
    code: 0,
    data: { message_id: "om_created_card" },
  })),
);
const messageReplyMock = vi.hoisted(() =>
  vi.fn(async () => ({
    code: 0,
    data: { message_id: "om_reply_card" },
  })),
);
const getTenantAccessTokenMock = vi.hoisted(() => vi.fn(async () => "tenant-token"));
const fetchMock = vi.hoisted(() =>
  vi.fn(async () => ({
    json: async () => ({ code: 0, msg: "ok" }),
  })),
);

vi.mock("@larksuiteoapi/node-sdk", () => ({
  AppType: { SelfBuild: "SelfBuild" },
  Domain: { Feishu: "Feishu" },
  Client: vi.fn(function MockClient() {
    return {
      im: {
        message: {
          create: messageCreateMock,
          reply: messageReplyMock,
        },
      },
      tokenManager: {
        getTenantAccessToken: getTenantAccessTokenMock,
      },
    };
  }),
}));

import { renderFeishuUserFacingCardText, sendFeishuReply, sendFeishuText } from "./outbound.js";

const account: ResolvedFeishuAccount = {
  accountId: "her",
  name: "her",
  knownBots: {},
  enabled: true,
  appId: "cli_her",
  appSecret: "sec_her",
  credentialSource: "config",
  config: { name: "her" },
};

describe("feishu user-facing card outbound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sanitizes structured tags before rendering card markdown", () => {
    expect(
      renderFeishuUserFacingCardText(
        '你好 <at user_id="ou_tester">tester</at>\n<file name="sheet.xlsx">内容</file>',
      ),
    ).toBe('你好 <at id=ou_tester></at>\n&lt;file name="sheet.xlsx"&gt;内容&lt;/file&gt;');
  });

  it("escapes unfinished inline code markers so streamed cards stay readable", () => {
    expect(renderFeishuUserFacingCardText("关键发现：原始 `")).toBe("关键发现：原始 \\`");
  });

  it("closes unfinished fenced code blocks for card markdown", () => {
    expect(renderFeishuUserFacingCardText("```ts\nconst value = 1;")).toBe(
      "```ts\nconst value = 1;\n```",
    );
  });

  it("routes plain text sends through interactive create plus patch", async () => {
    await sendFeishuText({
      account,
      chatId: "oc_group_1",
      text: "hello from her",
    });

    expect(messageCreateMock).toHaveBeenCalledOnce();
    expect(messageReplyMock).not.toHaveBeenCalled();
    const createArgs = messageCreateMock.mock.calls[0]?.[0];
    expect(createArgs?.data?.msg_type).toBe("interactive");

    expect(fetchMock).toHaveBeenCalledOnce();
    const fetchArgs = fetchMock.mock.calls[0];
    expect(String(fetchArgs?.[0])).toContain("/im/v1/messages/om_created_card");
    const init = fetchArgs?.[1] as { body?: string };
    const body = JSON.parse(String(init.body)) as { content: string };
    const content = JSON.parse(body.content) as {
      config: { update_multi: boolean; wide_screen_mode: boolean };
      elements: Array<{ tag: string; content: string }>;
    };
    expect(content.config.update_multi).toBe(true);
    expect(content.elements[0]?.tag).toBe("markdown");
    expect(content.elements[0]?.content).toContain("hello from her");
  });

  it("routes quote replies through interactive reply plus patch", async () => {
    await sendFeishuReply({
      account,
      messageId: "om_parent_1",
      text: 'reply from her <at user_id="ou_tester">tester</at>',
    });

    expect(messageReplyMock).toHaveBeenCalledOnce();
    const replyArgs = messageReplyMock.mock.calls[0]?.[0];
    expect(replyArgs?.path).toEqual({ message_id: "om_parent_1" });
    expect(replyArgs?.data?.msg_type).toBe("interactive");
    expect(fetchMock).toHaveBeenCalledOnce();
    const fetchArgs = fetchMock.mock.calls[0];
    const init = fetchArgs?.[1] as { body?: string };
    const body = JSON.parse(String(init.body)) as { content: string };
    const content = JSON.parse(body.content) as {
      config: { update_multi: boolean; wide_screen_mode: boolean };
      elements: Array<{ tag: string; content: string }>;
    };
    expect(content.config.update_multi).toBe(true);
    expect(content.elements[0]?.content).toContain("<at id=ou_tester></at>");
  });

  it("keeps literal at-tag examples in reports renderable without retry-stripping", async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as { body?: string }).body)) as { content: string };
      const content = JSON.parse(body.content) as {
        elements: Array<{ tag: string; content: string }>;
      };
      const markdown = content.elements[0]?.content ?? "";
      const hasRealCardMention = markdown.includes("<at id=ou_tester></at>");
      return {
        json: async () => ({
          code: hasRealCardMention ? 230099 : 0,
          msg: hasRealCardMention ? "invalid at/person" : "ok",
        }),
      };
    });

    await sendFeishuText({
      account,
      chatId: "oc_group_1",
      text: [
        "## 📊 R19 大版本升级验证报告",
        "",
        "**T2 @mention** ✅",
        '- 发送 `<at user_id="ou_tester">tester</at>` → History text 显示 `@tester` ✅',
        "- local archive 保留原始 `<at>` 标签结构 ✅",
      ].join("\n"),
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const fetchArgs = fetchMock.mock.calls[0];
    const init = fetchArgs?.[1] as { body?: string };
    const body = JSON.parse(String(init.body)) as { content: string };
    const content = JSON.parse(body.content) as {
      elements: Array<{ tag: string; content: string }>;
    };
    expect(content.elements[0]?.content).toContain(
      '`&lt;at user_id="ou_tester"&gt;tester&lt;/at&gt;`',
    );
    expect(content.elements[0]?.content).toContain("`&lt;at&gt;`");
    expect(content.elements[0]?.content).not.toContain("<at id=ou_tester></at>");
  });
});
