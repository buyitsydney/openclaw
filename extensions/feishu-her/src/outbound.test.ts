import { describe, expect, it } from "vitest";
import { assertNoForbiddenOpenPlatformUrls } from "./outbound.js";

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
