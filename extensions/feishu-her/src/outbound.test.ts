import { describe, expect, it } from "vitest";
import {
  assertNoForbiddenOpenPlatformUrls,
  formatFeishuUserFacingText,
  markdownToPost,
} from "./outbound.js";

describe("feishu outbound url guard", () => {
  it("allows tenant share links", () => {
    expect(() => {
      assertNoForbiddenOpenPlatformUrls("文档：https://xcne5kzbipob.feishu.cn/docx/AbCdEf123");
    }).not.toThrow();
  });

  it("allows open.feishu.cn official docs links", () => {
    expect(() => {
      assertNoForbiddenOpenPlatformUrls(
        "参考官方文档：https://open.feishu.cn/document/server-docs/im-v1/message/create",
      );
    }).not.toThrow();
  });

  it("rejects open.feishu.cn open-api links", () => {
    expect(() => {
      assertNoForbiddenOpenPlatformUrls(
        "错误链接：https://open.feishu.cn/open-apis/docx/v1/documents/abc",
      );
    }).toThrow("禁止向用户发送 open.feishu.cn 非文档链接");
  });

  it("rejects open.feishu.cn wiki links", () => {
    expect(() => {
      assertNoForbiddenOpenPlatformUrls(
        "错误链接：https://open.feishu.cn/wiki/NtoNdMhxdo7Jv5xkgRecO8CMnWb",
      );
    }).toThrow("禁止向用户发送 open.feishu.cn 非文档链接");
  });
});

describe("feishu markdownToPost raw url handling", () => {
  it("keeps OAuth query underscores intact in mixed markdown messages", () => {
    const authUrl =
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize?" +
      "client_id=cli_x&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&" +
      "response_type=code&scope=im%3Amessage.group_msg%3Aget_as_user";
    const content = markdownToPost(
      "需要用户 OAuth 授权才能使用 `feishu_group_history`。\n点击授权 👇\n" + authUrl,
    ).zh_cn.content;

    expect(content.at(-1)).toEqual([{ tag: "a", text: authUrl, href: authUrl }]);
  });

  it("preserves trailing punctuation outside the hyperlink", () => {
    const content = markdownToPost("授权地址：https://example.com/path_with_value.").zh_cn.content;

    expect(content[0]).toEqual([
      { tag: "text", text: "授权地址：" },
      {
        tag: "a",
        text: "https://example.com/path_with_value",
        href: "https://example.com/path_with_value",
      },
      { tag: "text", text: "." },
    ]);
  });

  it("still parses underscore italics outside URLs", () => {
    const content = markdownToPost("这是 _强调_ 文本").zh_cn.content;

    expect(content[0]).toEqual([
      { tag: "text", text: "这是 " },
      { tag: "text", text: "强调", style: ["italic"] },
      { tag: "text", text: " 文本" },
    ]);
  });

  it("unwraps bold markdown links so they still render as clickable links", () => {
    const authUrl =
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize?" +
      "client_id=cli_x&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&" +
      "response_type=code&scope=im%3Amessage.group_msg%3Aget_as_user";
    const content = markdownToPost(`👉 **[点击这里完成飞书授权](${authUrl})**`).zh_cn.content;

    expect(content[0]).toEqual([
      { tag: "text", text: "👉 " },
      { tag: "a", text: "点击这里完成飞书授权", href: authUrl },
    ]);
  });

  it("keeps normal bold text behavior unchanged", () => {
    const content = markdownToPost("这是 **重点** 文本").zh_cn.content;

    expect(content[0]).toEqual([
      { tag: "text", text: "这是 " },
      { tag: "text", text: "重点", style: ["bold"] },
      { tag: "text", text: " 文本" },
    ]);
  });

  it("does not unwrap styled links inside inline code", () => {
    const authUrl =
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize?" +
      "client_id=cli_x&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&" +
      "response_type=code&scope=im%3Amessage.group_msg%3Aget_as_user";
    const content = markdownToPost(`代码：\`**[点击授权](${authUrl})**\``).zh_cn.content;

    expect(content[0]).toEqual([
      { tag: "text", text: "代码：" },
      { tag: "text", text: `\`**[点击授权](${authUrl})**\``, style: ["bold"] },
    ]);
  });
});

describe("feishu oauth link display formatting", () => {
  it("rewrites raw OAuth authorize urls to a fixed short markdown link", () => {
    const authUrl =
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize?" +
      "client_id=cli_x&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&" +
      "response_type=code&scope=im%3Amessage.group_msg%3Aget_as_user";

    expect(formatFeishuUserFacingText("群聊历史需要 OAuth 授权\n点击授权 👇\n" + authUrl)).toBe(
      `群聊历史需要 OAuth 授权\n点击授权 👇\n[点击授权飞书](${authUrl})`,
    );
  });

  it("keeps existing markdown oauth links unchanged", () => {
    const authUrl =
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize?" +
      "client_id=cli_x&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&" +
      "response_type=code&scope=im%3Amessage.group_msg%3Aget_as_user";
    const text = `请点击这里：[点击授权飞书](${authUrl})`;

    expect(formatFeishuUserFacingText(text)).toBe(text);
  });

  it("does not rewrite oauth urls inside code spans or fenced code blocks", () => {
    const authUrl =
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize?" +
      "client_id=cli_x&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&" +
      "response_type=code&scope=im%3Amessage.group_msg%3Aget_as_user";
    const text = [
      "内联代码：`" + authUrl + "`",
      "```text",
      authUrl,
      "```",
      "正文：" + authUrl,
    ].join("\n");

    expect(formatFeishuUserFacingText(text)).toBe(
      [
        "内联代码：`" + authUrl + "`",
        "```text",
        authUrl,
        "```",
        `正文：[点击授权飞书](${authUrl})`,
      ].join("\n"),
    );
  });
});
