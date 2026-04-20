import { describe, expect, it } from "vitest";
import { extractFeishuAtTextMentions } from "./mention-text.js";

describe("feishu mention text parsing", () => {
  it("does not duplicate standard at tags with inner text", () => {
    expect(extractFeishuAtTextMentions('请看 <at user_id="ou_tester">tester</at> 的回复')).toEqual([
      {
        key: '<at user_id="ou_tester">tester</at>',
        id: "ou_tester",
        name: "tester",
        renderedText: "@tester",
      },
    ]);
  });

  it("still parses self-closing at tags", () => {
    expect(extractFeishuAtTextMentions('请通知 <at user_id="ou_tester" />')).toEqual([
      {
        key: '<at user_id="ou_tester" />',
        id: "ou_tester",
        renderedText: "@ou_tester",
      },
    ]);
  });
});
