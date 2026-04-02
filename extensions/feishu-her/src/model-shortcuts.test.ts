import { describe, expect, it } from "vitest";
import { rewriteModelShortcutCommand } from "./model-shortcuts.js";

describe("rewriteModelShortcutCommand", () => {
  it("leaves non-shortcut text unchanged", () => {
    expect(rewriteModelShortcutCommand("你好")).toBe("你好");
  });

  it("rewrites bare /gpt to the canonical model command", () => {
    expect(rewriteModelShortcutCommand("/gpt")).toBe("/model gpt");
  });

  it("rewrites /gpt with inline text", () => {
    expect(rewriteModelShortcutCommand("/gpt 写一个摘要")).toBe("/model gpt 写一个摘要");
  });

  it("rewrites colon form for chat UX consistency", () => {
    expect(rewriteModelShortcutCommand("/gpt: 写一个摘要")).toBe("/model gpt 写一个摘要");
  });

  it("matches the shortcut case-insensitively", () => {
    expect(rewriteModelShortcutCommand("/GPT")).toBe("/model gpt");
  });

  it("does not rewrite longer slash commands", () => {
    expect(rewriteModelShortcutCommand("/gptmini")).toBe("/gptmini");
  });
});
