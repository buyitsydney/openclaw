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
  knownBots: {
    cli_her: "her",
    cli_tester: "tester",
  },
  knownBotOpenIds: {
    ou_her_open: "cli_her",
    ou_tester_open: "cli_tester",
  },
  botOpenId: "ou_her_open",
  enabled: true,
  appId: "cli_her",
  appSecret: "sec_her",
  credentialSource: "config",
  config: { name: "her" },
};

function parseCardPayload(init: { body?: string } | undefined) {
  const body = JSON.parse(String(init?.body)) as { content: string };
  const content = JSON.parse(body.content) as {
    config: { update_multi: boolean; wide_screen_mode: boolean };
    elements: Array<{
      tag: string;
      content?: string;
      text?: { tag?: string; content?: string };
    }>;
  };
  const first = content.elements[0];
  return {
    content,
    firstTag: first?.tag,
    textTag: first?.text?.tag,
    markdown: first?.content ?? first?.text?.content ?? "",
  };
}

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
        account,
      ),
    ).toBe('你好 <at id=ou_tester></at>\n&lt;file name="sheet.xlsx"&gt;内容&lt;/file&gt;');
  });

  it("maps self bot app_id to own open_id for self-mentions", () => {
    expect(renderFeishuUserFacingCardText('你好 <at user_id="cli_her">her</at>', account)).toBe(
      "你好 <at id=ou_her_open></at>",
    );
  });

  it("renders peer bot app_id mentions as plain text to avoid cross-app 230099", () => {
    expect(
      renderFeishuUserFacingCardText('你好 <at user_id="cli_tester">tester</at>', account),
    ).toBe("你好 @tester");
  });

  it("renders unmapped bot app_id mentions as visible plain text", () => {
    expect(
      renderFeishuUserFacingCardText('你好 <at user_id="cli_unknown">peer bot</at>', account),
    ).toBe("你好 @peer bot");
  });

  it("escapes unfinished inline code markers so streamed cards stay readable", () => {
    expect(renderFeishuUserFacingCardText("关键发现：原始 `", account)).toBe("关键发现：原始 \\`");
  });

  it("closes unfinished fenced code blocks for card markdown", () => {
    expect(renderFeishuUserFacingCardText("```ts\nconst value = 1;", account)).toBe(
      "```ts\nconst value = 1;\n```",
    );
  });

  it("converts headings to bold with H1 divider (feishu card markdown doesn't support # syntax)", () => {
    const rendered = renderFeishuUserFacingCardText(
      "# 大标题\n## 飞书 Mention 格式\n### XML 标签语法",
      account,
    );

    // H1 gets bold + divider for visual prominence
    expect(rendered).toContain("**大标题**\n---");
    // H2+ get bold only
    expect(rendered).toContain("**飞书 Mention 格式**");
    expect(rendered).toContain("**XML 标签语法**");
    expect(rendered).not.toContain("# ");
    expect(rendered).not.toContain("## ");
    expect(rendered).not.toContain("### ");
  });

  it("preserves basic markdown styles instead of flattening them to plain text", () => {
    const rendered = renderFeishuUserFacingCardText(
      "**粗体文本**\n*斜体文本*\n~~删除线~~",
      account,
    );

    expect(rendered).toContain("**粗体文本**");
    expect(rendered).toContain("*斜体文本*");
    expect(rendered).toContain("~~删除线~~");
  });

  it("keeps inline code markers while preserving readable example content", () => {
    const rendered = renderFeishuUserFacingCardText(
      '字段：`user_id`\n示例：`<at user_id="ou_xxx">天哥</at>`',
      account,
    );

    expect(rendered).toContain("字段：`user_id`");
    expect(rendered).toContain('示例：`＜at user_id="ou_xxx"＞天哥＜/at＞`');
  });

  it("keeps literal at-tag examples readable inside fenced code blocks", () => {
    const rendered = renderFeishuUserFacingCardText(
      ["```xml", '<at user_id="ou_tester">tester</at>', "<at>", "```"].join("\n"),
      account,
    );

    expect(rendered).toContain('＜at user_id="ou_tester"＞tester＜/at＞');
    expect(rendered).toContain("＜at＞");
    expect(rendered).not.toContain("&lt;at");
    expect(rendered).not.toContain('<at user_id="ou_tester">tester</at>');
    expect(rendered).toContain("```");
  });

  it("converts blockquotes to fullwidth-bar prefix (feishu card markdown doesn't support > syntax)", () => {
    const rendered = renderFeishuUserFacingCardText(
      "> 这是一段引用\n> 第二行引用\n正常文本",
      account,
    );

    expect(rendered).toContain("｜这是一段引用");
    expect(rendered).toContain("｜第二行引用");
    expect(rendered).toContain("正常文本");
    expect(rendered).not.toMatch(/^>/m);
  });

  it("converts markdown tables to bold-header + bullet-list (feishu can't render pipe tables or <table> tags)", () => {
    const rendered = renderFeishuUserFacingCardText(
      [
        "### 字段说明",
        "",
        "| 字段 | 说明 | 示例 |",
        "| --- | --- | --- |",
        "| name | 用户名 | 张三 |",
        "| age | 年龄 | 25 |",
      ].join("\n"),
      account,
    );

    expect(rendered).toContain("**字段说明**");
    expect(rendered).not.toContain("| 字段 | 说明 | 示例 |");
    expect(rendered).not.toContain("| --- | --- | --- |");
    expect(rendered).not.toContain("<table ");
    expect(rendered).toContain("**字段**");
    expect(rendered).toContain("**说明**");
    expect(rendered).toContain("**示例**");
    expect(rendered).toMatch(/- .*name.*用户名.*张三/);
    expect(rendered).toMatch(/- .*age.*年龄.*25/);
  });

  it("strips backticks from table cells to prevent rendering collapse", () => {
    const rendered = renderFeishuUserFacingCardText(
      [
        "| # | 项目 | 输入 | 状态 |",
        "| --- | --- | --- | --- |",
        "| 1 | 纯文本 | hello | ✅ |",
        "| 2 | `行内代码` | `test` | ✅ |",
        "| 3 | **粗体** | **bold** | ✅ |",
      ].join("\n"),
      account,
    );

    // Backticks must be stripped from table cells (unsupported → breaks renderer)
    expect(rendered).not.toContain("`行内代码`");
    expect(rendered).not.toContain("`test`");
    // Cell content must survive without backticks
    expect(rendered).toMatch(/- .*2.*行内代码.*test.*✅/);
    // Non-backtick markdown in cells is preserved
    expect(rendered).toMatch(/- .*3.*\*\*粗体\*\*.*\*\*bold\*\*.*✅/);
    // All rows must be present (no empty bullets from rendering collapse)
    expect(rendered).toContain("- 1 | 纯文本");
    expect(rendered).toContain("- 3 |");
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
    const parsed = parseCardPayload(fetchArgs?.[1] as { body?: string });
    expect(parsed.content.config.update_multi).toBe(true);
    expect(parsed.firstTag).toBe("markdown");
    expect(parsed.markdown).toContain("hello from her");
  });

  it("routes quote replies through interactive reply plus patch", async () => {
    await sendFeishuReply({
      account,
      messageId: "om_parent_1",
      text: 'reply from her <at user_id="cli_tester">tester</at>',
    });

    expect(messageReplyMock).toHaveBeenCalledOnce();
    const replyArgs = messageReplyMock.mock.calls[0]?.[0];
    expect(replyArgs?.path).toEqual({ message_id: "om_parent_1" });
    expect(replyArgs?.data?.msg_type).toBe("interactive");
    expect(fetchMock).toHaveBeenCalledOnce();
    const fetchArgs = fetchMock.mock.calls[0];
    const parsed = parseCardPayload(fetchArgs?.[1] as { body?: string });
    expect(parsed.content.config.update_multi).toBe(true);
    expect(parsed.firstTag).toBe("markdown");
    expect(parsed.markdown).toContain("@tester");
    expect(parsed.markdown).not.toContain("<at id=cli_tester></at>");
    expect(parsed.markdown).not.toContain("<at id=ou_tester_open></at>");
  });

  it("keeps literal at-tag examples in reports renderable without retry-stripping", async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const parsed = parseCardPayload(init as { body?: string });
      const markdown = parsed.markdown;
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
    const parsed = parseCardPayload(fetchArgs?.[1] as { body?: string });
    expect(parsed.firstTag).toBe("markdown");
    expect(parsed.markdown).toContain("**📊 R19 大版本升级验证报告**");
    expect(parsed.markdown).toContain('发送 `＜at user_id="ou_tester"＞tester＜/at＞`');
    expect(parsed.markdown).toContain("History text 显示 `@tester`");
    expect(parsed.markdown).not.toContain("<at id=ou_tester></at>");
  });

  it("strips HTML-like tags from backtick-wrapped table cells to prevent 230099 and ugly display", () => {
    const rendered = renderFeishuUserFacingCardText(
      [
        "| 项目 | 示例 |",
        "| --- | --- |",
        '| @mention | `<at user_id="ou_xxx">name</at>` |',
        "| 标签 | `<file>test</file>` |",
      ].join("\n"),
      account,
    );

    // Backtick-wrapped <at> must NOT become a real mention (causes 230099)
    expect(rendered).not.toContain("<at id=ou_xxx>");
    expect(rendered).not.toContain('<at user_id="ou_xxx">');
    // Tags stripped, only text content remains
    expect(rendered).not.toContain("＜at");
    expect(rendered).not.toContain("＜file");
    // Plain text content from inside the tags must survive
    expect(rendered).toMatch(/- .*@mention.*name/);
    expect(rendered).toMatch(/- .*标签.*test/);
  });
});
