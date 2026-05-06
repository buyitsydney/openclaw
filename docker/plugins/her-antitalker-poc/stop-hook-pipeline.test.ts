import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  StopHookPipeline,
  createProseOnlyHook,
  createGetFollowUpMessages,
  type StopHookContext,
  type StopHookFn,
} from "./stop-hook-pipeline.js";

function makeCtx(overrides: Partial<StopHookContext> = {}): StopHookContext {
  return {
    sessionKey: "test-session-1",
    lastAssistantText: "我来帮你检查一下这个问题，让我先分析代码结构。",
    lastAssistantHadToolCall: false,
    lastToolNames: [],
    turnIndex: 1,
    ...overrides,
  };
}

describe("StopHookPipeline", () => {
  let pipeline: StopHookPipeline;

  beforeEach(() => {
    StopHookPipeline.resetInstance();
    pipeline = new StopHookPipeline();
  });

  describe("registration", () => {
    it("registers a hook", () => {
      const fn: StopHookFn = () => ({ shouldContinue: false });
      pipeline.register("test", fn);
      expect(pipeline.hookCount).toBe(1);
      expect(pipeline.getRegisteredHooks()).toEqual(["test"]);
    });

    it("replaces existing hook with same name", () => {
      const fn1: StopHookFn = () => ({ shouldContinue: false });
      const fn2: StopHookFn = () => ({ shouldContinue: true, message: "go" });
      pipeline.register("test", fn1);
      pipeline.register("test", fn2);
      expect(pipeline.hookCount).toBe(1);
      const result = pipeline.evaluate(makeCtx());
      expect(result.length).toBe(1);
    });

    it("sorts hooks by priority (higher first)", () => {
      const order: string[] = [];
      pipeline.register("low", () => { order.push("low"); return { shouldContinue: false }; }, 1);
      pipeline.register("high", () => { order.push("high"); return { shouldContinue: false }; }, 10);
      pipeline.register("mid", () => { order.push("mid"); return { shouldContinue: false }; }, 5);
      pipeline.evaluate(makeCtx());
      expect(order).toEqual(["high", "mid", "low"]);
    });

    it("unregisters a hook", () => {
      pipeline.register("test", () => ({ shouldContinue: false }));
      expect(pipeline.unregister("test")).toBe(true);
      expect(pipeline.hookCount).toBe(0);
    });

    it("unregister returns false for non-existent hook", () => {
      expect(pipeline.unregister("ghost")).toBe(false);
    });
  });

  describe("evaluate()", () => {
    it("returns empty array when no hooks registered", () => {
      const result = pipeline.evaluate(makeCtx());
      expect(result).toEqual([]);
    });

    it("returns empty when all hooks pass", () => {
      pipeline.register("pass", () => ({ shouldContinue: false }));
      const result = pipeline.evaluate(makeCtx());
      expect(result).toEqual([]);
    });

    it("returns message when a hook blocks", () => {
      pipeline.register("block", () => ({
        shouldContinue: true,
        message: "继续工作！",
      }));
      const result = pipeline.evaluate(makeCtx());
      expect(result.length).toBe(1);
      expect(result[0].role).toBe("user");
      expect(result[0].content).toBe("继续工作！");
    });

    it("first blocking hook wins (short-circuit)", () => {
      pipeline.register("first", () => ({
        shouldContinue: true,
        message: "first wins",
      }), 10);
      pipeline.register("second", () => ({
        shouldContinue: true,
        message: "second wins",
      }), 1);
      const result = pipeline.evaluate(makeCtx());
      expect(result[0].content).toBe("first wins");
    });

    it("skips evaluation when model made tool calls", () => {
      pipeline.register("block", () => ({
        shouldContinue: true,
        message: "should not fire",
      }));
      const result = pipeline.evaluate(makeCtx({ lastAssistantHadToolCall: true }));
      expect(result).toEqual([]);
    });

    it("resets continuation count when tool call detected", () => {
      pipeline.register("block", () => ({
        shouldContinue: true,
        message: "go",
      }));
      // Trigger 2 continuations
      pipeline.evaluate(makeCtx());
      pipeline.evaluate(makeCtx());
      expect(pipeline.getContinuationCount("test-session-1")).toBe(2);

      // Tool call resets
      pipeline.evaluate(makeCtx({ lastAssistantHadToolCall: true }));
      expect(pipeline.getContinuationCount("test-session-1")).toBe(0);
    });
  });

  describe("dead-loop protection", () => {
    it("yields after maxContinuationTurns (default 3)", () => {
      pipeline.register("always-block", () => ({
        shouldContinue: true,
        message: "go",
      }));

      // First 3 should force continuation
      expect(pipeline.evaluate(makeCtx()).length).toBe(1);
      expect(pipeline.evaluate(makeCtx()).length).toBe(1);
      expect(pipeline.evaluate(makeCtx()).length).toBe(1);

      // 4th should yield (dead-loop protection)
      expect(pipeline.evaluate(makeCtx()).length).toBe(0);
    });

    it("respects custom maxContinuationTurns", () => {
      const p = new StopHookPipeline(1);
      p.register("always-block", () => ({
        shouldContinue: true,
        message: "go",
      }));

      expect(p.evaluate(makeCtx()).length).toBe(1);
      // Second should yield
      expect(p.evaluate(makeCtx()).length).toBe(0);
    });

    it("resets after dead-loop yield", () => {
      pipeline.register("always-block", () => ({
        shouldContinue: true,
        message: "go",
      }));

      // Exhaust 3 continuations
      pipeline.evaluate(makeCtx());
      pipeline.evaluate(makeCtx());
      pipeline.evaluate(makeCtx());
      // Dead-loop yield
      pipeline.evaluate(makeCtx());

      // Should be able to fire again (counter reset by yield)
      expect(pipeline.evaluate(makeCtx()).length).toBe(1);
    });

    it("tracks separate sessions independently", () => {
      pipeline.register("block", () => ({
        shouldContinue: true,
        message: "go",
      }));

      pipeline.evaluate(makeCtx({ sessionKey: "s1" }));
      pipeline.evaluate(makeCtx({ sessionKey: "s1" }));
      pipeline.evaluate(makeCtx({ sessionKey: "s2" }));

      expect(pipeline.getContinuationCount("s1")).toBe(2);
      expect(pipeline.getContinuationCount("s2")).toBe(1);
    });
  });

  describe("error handling", () => {
    it("catches hook errors and continues to next hook", () => {
      pipeline.register("crasher", () => { throw new Error("boom"); }, 10);
      pipeline.register("safe", () => ({
        shouldContinue: true,
        message: "safe hook fired",
      }), 1);

      const result = pipeline.evaluate(makeCtx());
      expect(result.length).toBe(1);
      expect(result[0].content).toBe("safe hook fired");
    });

    it("returns empty when all hooks throw", () => {
      pipeline.register("crash1", () => { throw new Error("a"); });
      pipeline.register("crash2", () => { throw new Error("b"); });
      const result = pipeline.evaluate(makeCtx());
      expect(result).toEqual([]);
    });

    it("handles hook returning shouldContinue:true without message", () => {
      pipeline.register("no-msg", () => ({ shouldContinue: true }));
      const result = pipeline.evaluate(makeCtx());
      // No message means we can't inject anything — treat as pass
      expect(result).toEqual([]);
    });
  });

  describe("resetContinuationCount", () => {
    it("resets for specific session", () => {
      pipeline.register("block", () => ({
        shouldContinue: true,
        message: "go",
      }));
      pipeline.evaluate(makeCtx({ sessionKey: "s1" }));
      pipeline.evaluate(makeCtx({ sessionKey: "s2" }));

      pipeline.resetContinuationCount("s1");
      expect(pipeline.getContinuationCount("s1")).toBe(0);
      expect(pipeline.getContinuationCount("s2")).toBe(1);
    });
  });

  describe("singleton", () => {
    it("returns same instance", () => {
      const a = StopHookPipeline.getInstance();
      const b = StopHookPipeline.getInstance();
      expect(a).toBe(b);
    });

    it("resetInstance creates fresh instance", () => {
      const a = StopHookPipeline.getInstance();
      a.register("test", () => ({ shouldContinue: false }));
      StopHookPipeline.resetInstance();
      const b = StopHookPipeline.getInstance();
      expect(b.hookCount).toBe(0);
    });
  });
});

describe("createProseOnlyHook", () => {
  let hook: StopHookFn;

  beforeEach(() => {
    hook = createProseOnlyHook();
  });

  it("passes when model made tool calls", () => {
    const result = hook(makeCtx({ lastAssistantHadToolCall: true }));
    expect(result.shouldContinue).toBe(false);
  });

  it("passes when text is too short", () => {
    const result = hook(makeCtx({ lastAssistantText: "ok" }));
    expect(result.shouldContinue).toBe(false);
  });

  it("passes when no commitment language detected", () => {
    const result = hook(makeCtx({
      lastAssistantText: "这是一个关于数据库设计的总结。索引优化可以提高查询性能。连接池大小需要根据负载调整。",
    }));
    expect(result.shouldContinue).toBe(false);
  });

  it("blocks Chinese commitment: 我来", () => {
    const result = hook(makeCtx({
      lastAssistantText: "我来检查一下这个问题，先看看配置文件的内容是否正确。",
    }));
    expect(result.shouldContinue).toBe(true);
    expect(result.message).toContain("禁止光说不练");
  });

  it("blocks Chinese commitment: 让我", () => {
    const result = hook(makeCtx({
      lastAssistantText: "让我分析一下这段代码的执行路径和可能的边界条件问题。",
    }));
    expect(result.shouldContinue).toBe(true);
  });

  it("blocks Chinese commitment: 接下来", () => {
    const result = hook(makeCtx({
      lastAssistantText: "接下来我需要检查这个文件的权限设置和所有者信息。",
    }));
    expect(result.shouldContinue).toBe(true);
  });

  it("blocks English commitment: I'll", () => {
    const result = hook(makeCtx({
      lastAssistantText: "I'll check the configuration file to see what's causing the issue with the deployment.",
    }));
    expect(result.shouldContinue).toBe(true);
  });

  it("blocks English commitment: Let me", () => {
    const result = hook(makeCtx({
      lastAssistantText: "Let me investigate the root cause of this error by examining the logs and stack trace.",
    }));
    expect(result.shouldContinue).toBe(true);
  });

  it("blocks English commitment: I will", () => {
    const result = hook(makeCtx({
      lastAssistantText: "I will need to check the database schema before making any changes to the migration.",
    }));
    expect(result.shouldContinue).toBe(true);
  });

  it("blocks English commitment: Now I", () => {
    const result = hook(makeCtx({
      lastAssistantText: "Now I need to verify that the test suite passes with the new implementation changes.",
    }));
    expect(result.shouldContinue).toBe(true);
  });

  it("includes text preview in blocking message", () => {
    const longText = "我来检查配置" + "x".repeat(200);
    const result = hook(makeCtx({ lastAssistantText: longText }));
    expect(result.shouldContinue).toBe(true);
    expect(result.message).toContain("我来检查配置");
    // Preview should be truncated
    expect(result.message!.length).toBeLessThan(longText.length + 200);
  });

  it("uses custom patterns when provided", () => {
    const customHook = createProseOnlyHook({
      commitmentPatterns: [/CUSTOM_PATTERN/],
    });
    const result = customHook(makeCtx({
      lastAssistantText: "Here is a CUSTOM_PATTERN that should be detected in this long text.",
    }));
    expect(result.shouldContinue).toBe(true);
  });

  it("uses custom minTextLength", () => {
    const strictHook = createProseOnlyHook({ minTextLength: 5 });
    const result = strictHook(makeCtx({
      lastAssistantText: "我来做这件事",
    }));
    expect(result.shouldContinue).toBe(true);
  });
});

describe("createGetFollowUpMessages", () => {
  let pipeline: StopHookPipeline;

  beforeEach(() => {
    pipeline = new StopHookPipeline();
  });

  it("returns async function compatible with pi-agent-core", async () => {
    pipeline.register("test", () => ({
      shouldContinue: true,
      message: "continue!",
    }));

    const fn = createGetFollowUpMessages(pipeline, () => makeCtx());
    const result = await fn();
    expect(result.length).toBe(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("continue!");
  });

  it("returns empty array when context is null", async () => {
    pipeline.register("test", () => ({
      shouldContinue: true,
      message: "go",
    }));

    const fn = createGetFollowUpMessages(pipeline, () => null);
    const result = await fn();
    expect(result).toEqual([]);
  });

  it("integrates with dynamic context", async () => {
    let callCount = 0;
    pipeline.register("counter", (ctx) => {
      callCount++;
      if (ctx.turnIndex > 2) return { shouldContinue: false };
      return { shouldContinue: true, message: `turn ${ctx.turnIndex}` };
    });

    let turnIndex = 1;
    const fn = createGetFollowUpMessages(pipeline, () => makeCtx({ turnIndex }));

    const r1 = await fn();
    expect(r1[0].content).toBe("turn 1");

    turnIndex = 3;
    const r2 = await fn();
    expect(r2).toEqual([]);
    expect(callCount).toBe(2);
  });
});

describe("integration: pipeline + proseOnlyHook", () => {
  let pipeline: StopHookPipeline;

  beforeEach(() => {
    pipeline = new StopHookPipeline();
    pipeline.register("antitalker", createProseOnlyHook());
  });

  it("full flow: prose violation detected and enforced", () => {
    const ctx = makeCtx({
      lastAssistantText: "让我先看看这个文件的内容，然后我来修复这个 bug。",
      lastAssistantHadToolCall: false,
    });
    const result = pipeline.evaluate(ctx);
    expect(result.length).toBe(1);
    expect(result[0].content).toContain("禁止光说不练");
  });

  it("full flow: tool call means pass", () => {
    const ctx = makeCtx({
      lastAssistantText: "让我先看看这个文件的内容。",
      lastAssistantHadToolCall: true,
    });
    const result = pipeline.evaluate(ctx);
    expect(result).toEqual([]);
  });

  it("full flow: dead-loop protection kicks in after 3 violations", () => {
    const ctx = makeCtx({
      lastAssistantText: "我来检查一下这个问题的根本原因，需要分析一下代码逻辑。",
      lastAssistantHadToolCall: false,
    });

    expect(pipeline.evaluate(ctx).length).toBe(1); // 1st
    expect(pipeline.evaluate(ctx).length).toBe(1); // 2nd
    expect(pipeline.evaluate(ctx).length).toBe(1); // 3rd
    expect(pipeline.evaluate(ctx).length).toBe(0); // yield
  });

  it("full flow: counter resets after tool execution", () => {
    const proseCtx = makeCtx({ lastAssistantHadToolCall: false });
    const toolCtx = makeCtx({ lastAssistantHadToolCall: true });

    pipeline.evaluate(proseCtx); // count=1
    pipeline.evaluate(proseCtx); // count=2
    pipeline.evaluate(toolCtx); // reset

    // Should be able to fire 3 more times
    expect(pipeline.evaluate(proseCtx).length).toBe(1);
    expect(pipeline.evaluate(proseCtx).length).toBe(1);
    expect(pipeline.evaluate(proseCtx).length).toBe(1);
    expect(pipeline.evaluate(proseCtx).length).toBe(0); // yield again
  });
});
