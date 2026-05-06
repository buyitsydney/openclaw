/**
 * stop-hook-pipeline.ts — Same-turn enforcement for "prose-only" violations
 *
 * Implements the getFollowUpMessages pattern from pi-agent-core:
 * when the agent loop has no more tool calls and is about to exit,
 * this pipeline evaluates registered hooks. If any hook determines
 * the model stopped prematurely (e.g., outputting prose without action),
 * it returns a user message that forces the loop to continue.
 *
 * This replaces the external heartbeat-based wake mechanism for enforcement,
 * reducing MTTR from ~30min to <2sec.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StopHookContext {
  sessionKey: string;
  lastAssistantText: string;
  lastAssistantHadToolCall: boolean;
  lastToolNames: string[];
  turnIndex: number;
}

export interface StopHookResult {
  shouldContinue: boolean;
  message?: string;
  hookName?: string;
}

export type StopHookFn = (ctx: StopHookContext) => StopHookResult;

interface RegisteredHook {
  name: string;
  fn: StopHookFn;
  priority: number;
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

const PIPELINE_KEY = Symbol.for("stop-hook-pipeline.v1");
const DEFAULT_MAX_CONTINUATION_TURNS = 3;

export class StopHookPipeline {
  private hooks: RegisteredHook[] = [];
  private continuationCount: Map<string, number> = new Map();
  private maxContinuationTurns: number;

  constructor(maxContinuationTurns = DEFAULT_MAX_CONTINUATION_TURNS) {
    this.maxContinuationTurns = maxContinuationTurns;
  }

  static getInstance(): StopHookPipeline {
    const g = globalThis as any;
    if (!g[PIPELINE_KEY]) {
      g[PIPELINE_KEY] = new StopHookPipeline();
    }
    return g[PIPELINE_KEY];
  }

  static resetInstance(): void {
    const g = globalThis as any;
    delete g[PIPELINE_KEY];
  }

  register(name: string, fn: StopHookFn, priority = 0): void {
    const existing = this.hooks.findIndex((h) => h.name === name);
    if (existing >= 0) {
      this.hooks[existing] = { name, fn, priority };
    } else {
      this.hooks.push({ name, fn, priority });
    }
    this.hooks.sort((a, b) => b.priority - a.priority);
  }

  unregister(name: string): boolean {
    const idx = this.hooks.findIndex((h) => h.name === name);
    if (idx >= 0) {
      this.hooks.splice(idx, 1);
      return true;
    }
    return false;
  }

  resetContinuationCount(sessionKey: string): void {
    this.continuationCount.delete(sessionKey);
  }

  getContinuationCount(sessionKey: string): number {
    return this.continuationCount.get(sessionKey) ?? 0;
  }

  /**
   * Evaluate all registered hooks. Returns AgentMessage[] for getFollowUpMessages.
   * Empty array = allow exit. Non-empty = force continuation.
   */
  evaluate(ctx: StopHookContext): Array<{ role: "user"; content: string }> {
    if (this.hooks.length === 0) {
      return [];
    }

    const count = this.continuationCount.get(ctx.sessionKey) ?? 0;
    if (count >= this.maxContinuationTurns) {
      // Dead-loop protection: yield after N consecutive forced continuations
      this.continuationCount.delete(ctx.sessionKey);
      return [];
    }

    // If the last turn had a tool call, reset counter — model is working
    if (ctx.lastAssistantHadToolCall) {
      this.continuationCount.delete(ctx.sessionKey);
      return [];
    }

    for (const hook of this.hooks) {
      try {
        const result = hook.fn(ctx);
        if (result.shouldContinue && result.message) {
          this.continuationCount.set(ctx.sessionKey, count + 1);
          return [{ role: "user" as const, content: result.message }];
        }
      } catch (err) {
        // Hook threw — log and skip, never let one hook break the pipeline
        try {
          console.error(`[stop-hook-pipeline] hook "${hook.name}" threw:`, err);
        } catch {}
      }
    }

    // All hooks passed — allow exit, reset counter
    this.continuationCount.delete(ctx.sessionKey);
    return [];
  }

  getRegisteredHooks(): string[] {
    return this.hooks.map((h) => h.name);
  }

  get hookCount(): number {
    return this.hooks.length;
  }
}

// ─── Built-in hook: prose-only enforcement ───────────────────────────────────

/**
 * Default antitalker prose-only hook for the pipeline.
 * Checks if the model output prose without calling any tools and the text
 * contains commitment patterns ("我来", "让我", "I'll", "Let me") that indicate
 * intended but unexecuted action.
 */
export function createProseOnlyHook(opts?: {
  commitmentPatterns?: RegExp[];
  minTextLength?: number;
}): StopHookFn {
  const patterns = opts?.commitmentPatterns ?? [
    // Chinese commitment patterns
    /我(?:来|去|先|现在|马上|立刻)/,
    /让我/,
    /我(?:会|将|要|得)/,
    /接下来/,
    /下一步/,
    // English commitment patterns
    /\bI'?ll\b/i,
    /\bLet me\b/i,
    /\bI (?:will|shall|should|can|need to)\b/i,
    /\bNext,?\s*I\b/i,
    /\bNow (?:I|let)\b/i,
  ];
  const minLen = opts?.minTextLength ?? 20;

  return (ctx: StopHookContext): StopHookResult => {
    // If model called tools, it's working — pass
    if (ctx.lastAssistantHadToolCall) {
      return { shouldContinue: false };
    }

    const text = ctx.lastAssistantText;

    // Too short to be a real "prose-only" violation
    if (text.length < minLen) {
      return { shouldContinue: false };
    }

    // Check for commitment language
    const hasCommitment = patterns.some((p) => p.test(text));
    if (!hasCommitment) {
      return { shouldContinue: false };
    }

    const preview = text.slice(0, 100).replace(/\n/g, " ");
    return {
      shouldContinue: true,
      hookName: "antitalker:prose-only",
      message:
        `⚠️ 你上一轮说了想做事但没调任何 tool。禁止光说不练。\n` +
        `原文摘要: "${preview}..."\n\n` +
        `现在请立刻用 tool 执行实际动作（调 exec/read/write/send 等），不要再输出计划性文字。`,
    };
  };
}

// ─── Integration helper ──────────────────────────────────────────────────────

/**
 * Creates a getFollowUpMessages function suitable for pi-agent-core AgentConfig.
 * Bridges the OpenClaw plugin hook system to pi-agent-core's native loop interface.
 */
export function createGetFollowUpMessages(
  pipeline: StopHookPipeline,
  getContext: () => StopHookContext | null,
): () => Promise<Array<{ role: "user"; content: string }>> {
  return async () => {
    const ctx = getContext();
    if (!ctx) return [];
    return pipeline.evaluate(ctx);
  };
}
