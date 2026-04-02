/**
 * Unit test reproducing the compaction boundaryStart bug in pi-coding-agent SDK.
 *
 * Bug: In iterative compaction, `prepareCompaction` sets
 *   boundaryStart = prevCompactionIndex + 1
 * which skips over "keptMessages" from the previous compaction round.
 * These messages are physically located BEFORE the compaction entry
 * in the append-only JSONL, so they silently disappear from all
 * future summarization inputs.
 *
 * This test extracts the pure logic from the SDK (no AI/LLM calls needed)
 * and demonstrates the bug + fix with deterministic assertions.
 *
 * Run: bunx vitest run scripts/compact-boundary-bug.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";

// ============================================================================
// Extracted SDK types and pure functions (from compaction.js + session-manager.js)
// ============================================================================

interface MessageEntry {
  type: "message";
  id: string;
  message: { role: string; content: unknown[]; timestamp: number; [k: string]: unknown };
}

interface CompactionEntry {
  type: "compaction";
  id: string;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  timestamp: number;
}

type SessionEntry = MessageEntry | CompactionEntry;

interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

interface CutPointResult {
  firstKeptEntryIndex: number;
  turnStartIndex: number;
  isSplitTurn: boolean;
}

/** Estimate token count for a message using chars/4 heuristic (matches SDK). */
function estimateTokens(message: Record<string, unknown>): number {
  let chars = 0;
  if (message.role === "user" || message.role === "assistant") {
    const content = message.content;
    if (typeof content === "string") {
      chars = content.length;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) {
          chars += block.text.length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

/** Extract message from entry (matches SDK's getMessageFromEntry). */
function getMessageFromEntry(entry: SessionEntry): Record<string, unknown> | undefined {
  if (entry.type === "message") {
    return entry.message;
  }
  return undefined;
}

/** Find valid cut points: user or assistant message indices. */
function findValidCutPoints(
  entries: SessionEntry[],
  startIndex: number,
  endIndex: number,
): number[] {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const entry = entries[i];
    if (entry.type === "message") {
      const role = entry.message.role;
      if (role === "user" || role === "assistant") {
        cutPoints.push(i);
      }
    }
  }
  return cutPoints;
}

/** Find cut point (extracted from SDK findCutPoint). */
function findCutPoint(
  entries: SessionEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPointResult {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }

  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0];

  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry.type !== "message") {
      continue;
    }
    const messageTokens = estimateTokens(entry.message);
    accumulatedTokens += messageTokens;
    if (accumulatedTokens >= keepRecentTokens) {
      for (let c = 0; c < cutPoints.length; c++) {
        if (cutPoints[c] >= i) {
          cutIndex = cutPoints[c];
          break;
        }
      }
      break;
    }
  }

  while (cutIndex > startIndex) {
    const prevEntry = entries[cutIndex - 1];
    if (prevEntry.type === "compaction" || prevEntry.type === "message") {
      break;
    }
    cutIndex--;
  }

  return { firstKeptEntryIndex: cutIndex, turnStartIndex: -1, isSplitTurn: false };
}

// ============================================================================
// SDK's BUGGY prepareCompaction (verbatim logic from compaction.js)
// ============================================================================

function prepareCompactionBuggy(pathEntries: SessionEntry[], settings: CompactionSettings) {
  if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
    return undefined;
  }

  let prevCompactionIndex = -1;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    if (pathEntries[i].type === "compaction") {
      prevCompactionIndex = i;
      break;
    }
  }

  // BUG: This skips keptMessages from previous round
  const boundaryStart = prevCompactionIndex + 1;
  const boundaryEnd = pathEntries.length;

  const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
  const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) {
    return undefined;
  }
  const firstKeptEntryId = firstKeptEntry.id;

  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

  const messagesToSummarize: Record<string, unknown>[] = [];
  for (let i = boundaryStart; i < historyEnd; i++) {
    const msg = getMessageFromEntry(pathEntries[i]);
    if (msg) {
      messagesToSummarize.push(msg);
    }
  }

  let previousSummary: string | undefined;
  if (prevCompactionIndex >= 0) {
    previousSummary = (pathEntries[prevCompactionIndex] as CompactionEntry).summary;
  }

  return { firstKeptEntryId, messagesToSummarize, previousSummary, boundaryStart, historyEnd };
}

// ============================================================================
// FIXED prepareCompaction — two-phase approach
//
// Phase 1: Previous round's keptMessages → ALWAYS go into messagesToSummarize.
//          They served their purpose (raw detail for recent turns) and must
//          now be summarized before they fall into a dead zone.
//
// Phase 2: New messages (after prev compaction entry) → apply findCutPoint
//          to determine which are summarized vs kept for the next round.
// ============================================================================

function prepareCompactionFixed(pathEntries: SessionEntry[], settings: CompactionSettings) {
  if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
    return undefined;
  }

  let prevCompactionIndex = -1;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    if (pathEntries[i].type === "compaction") {
      prevCompactionIndex = i;
      break;
    }
  }

  // Phase 1: Collect previous round's keptMessages (unconditionally summarized)
  const prevKeptMessages: Record<string, unknown>[] = [];
  if (prevCompactionIndex >= 0) {
    const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
    if (prevCompaction.firstKeptEntryId) {
      const keptIdx = pathEntries.findIndex((e) => e.id === prevCompaction.firstKeptEntryId);
      if (keptIdx >= 0 && keptIdx < prevCompactionIndex) {
        for (let i = keptIdx; i < prevCompactionIndex; i++) {
          const msg = getMessageFromEntry(pathEntries[i]);
          if (msg) {
            prevKeptMessages.push(msg);
          }
        }
      }
    }
  }

  // Phase 2: Apply findCutPoint only to new messages (after prev compaction)
  const newStart = prevCompactionIndex + 1;
  const boundaryEnd = pathEntries.length;

  const cutPoint = findCutPoint(pathEntries, newStart, boundaryEnd, settings.keepRecentTokens);
  const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) {
    return undefined;
  }
  const firstKeptEntryId = firstKeptEntry.id;

  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

  // New messages to summarize (between compaction and the new cut point)
  const newMessagesToSummarize: Record<string, unknown>[] = [];
  for (let i = newStart; i < historyEnd; i++) {
    if (pathEntries[i].type === "compaction") {
      continue;
    }
    const msg = getMessageFromEntry(pathEntries[i]);
    if (msg) {
      newMessagesToSummarize.push(msg);
    }
  }

  // Combined: prevKeptMessages + new messages to summarize
  const messagesToSummarize = [...prevKeptMessages, ...newMessagesToSummarize];

  let previousSummary: string | undefined;
  if (prevCompactionIndex >= 0) {
    previousSummary = (pathEntries[prevCompactionIndex] as CompactionEntry).summary;
  }

  return {
    firstKeptEntryId,
    messagesToSummarize,
    previousSummary,
    boundaryStart: prevCompactionIndex >= 0 ? newStart : 0,
    historyEnd,
  };
}

// ============================================================================
// SDK's context rebuild logic (from session-manager.js buildSessionContext)
// ============================================================================

function buildSessionContext(path: SessionEntry[]) {
  let compaction: CompactionEntry | undefined;
  for (const entry of path) {
    if (entry.type === "compaction") {
      compaction = entry;
    }
  }

  const messages: Record<string, unknown>[] = [];
  if (compaction) {
    messages.push({ role: "compactionSummary", summary: compaction.summary });
    const compactionIdx = path.findIndex((e) => e.type === "compaction" && e.id === compaction.id);
    let foundFirstKept = false;
    for (let i = 0; i < compactionIdx; i++) {
      if (path[i].id === compaction.firstKeptEntryId) {
        foundFirstKept = true;
      }
      if (foundFirstKept && path[i].type === "message") {
        messages.push((path[i] as MessageEntry).message);
      }
    }
    for (let i = compactionIdx + 1; i < path.length; i++) {
      if (path[i].type === "message") {
        messages.push((path[i] as MessageEntry).message);
      }
    }
  } else {
    for (const entry of path) {
      if (entry.type === "message") {
        messages.push(entry.message);
      }
    }
  }
  return messages;
}

// ============================================================================
// Helpers
// ============================================================================

let _id = 0;
function uid(): string {
  return `entry-${++_id}`;
}
function resetIds() {
  _id = 0;
}

function userMsg(text: string, id?: string): MessageEntry {
  return {
    type: "message",
    id: id ?? uid(),
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  };
}

function assistantMsg(text: string, id?: string): MessageEntry {
  return {
    type: "message",
    id: id ?? uid(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
      provider: "test",
      model: "test",
    },
  };
}

function compactEntry(
  summary: string,
  firstKeptEntryId: string,
  tokensBefore: number,
  id?: string,
): CompactionEntry {
  return {
    type: "compaction",
    id: id ?? uid(),
    summary,
    firstKeptEntryId,
    tokensBefore,
    timestamp: Date.now(),
  };
}

function bigText(targetTokens: number): string {
  return "X".repeat(targetTokens * 4);
}

function getTextFromMsg(msg: Record<string, unknown>): string {
  if (Array.isArray(msg.content)) {
    return msg.content[0]?.text ?? "";
  }
  return typeof msg.content === "string" ? msg.content : "";
}

const DEFAULT_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

// ============================================================================
// TESTS: Reproduce the bug
// ============================================================================

describe("compaction boundaryStart bug (current SDK behavior)", () => {
  beforeEach(() => resetIds());

  it("BUG: keptMessages from round 1 are excluded from round 2 messagesToSummarize", () => {
    // Simulate exp3a:
    //   L1-L10: small messages
    //   L11: huge (37K tokens), L12: small
    //   Compaction#1 (L13): summarizes L1-L10, keeps L11+L12
    //   L14-L27: small new messages
    //   Compaction#2: should include L11+L12 but DOESN'T

    const entries: SessionEntry[] = [];

    // L1-L10: 5 user/assistant pairs (~5K tokens)
    for (let i = 0; i < 5; i++) {
      entries.push(userMsg(`Question ${i + 1}: ${"q".repeat(400)}`));
      entries.push(assistantMsg(`Answer ${i + 1}: ${"a".repeat(600)}`));
    }

    // L11: huge (37K tokens)
    const L11 = userMsg(bigText(37000));
    entries.push(L11); // index 10

    // L12: small
    const L12 = assistantMsg("Short response to the big content.");
    entries.push(L12); // index 11

    // Verify round 1 prep
    const prep1 = prepareCompactionBuggy(entries, DEFAULT_SETTINGS);
    expect(prep1).toBeDefined();
    expect(prep1!.firstKeptEntryId).toBe(L11.id); // L11 is kept (exceeds 20K)
    expect(prep1!.messagesToSummarize.length).toBe(10); // L1-L10

    // Simulate compaction#1 appended
    const COMPACT1 = compactEntry("Summary of L1-L10: Five Q&A pairs.", L11.id, 30000);
    entries.push(COMPACT1); // index 12

    // L14-L27: 7 small pairs
    for (let i = 0; i < 7; i++) {
      entries.push(userMsg(`Follow-up ${i + 1}: ${"f".repeat(50)}`));
      entries.push(assistantMsg(`Reply ${i + 1}: ${"r".repeat(50)}`));
    }
    // entries now: [L1..L10(idx0-9), L11(10), L12(11), COMPACT1(12), L14..L27(13-26)]

    // Round 2 prep
    const prep2 = prepareCompactionBuggy(entries, DEFAULT_SETTINGS);
    expect(prep2).toBeDefined();

    // boundaryStart should be 13 (prevCompactionIndex=12, +1=13)
    expect(prep2!.boundaryStart).toBe(13);

    // BUG: L11 and L12 are NOT in messagesToSummarize
    const texts = prep2!.messagesToSummarize.map(getTextFromMsg);
    expect(texts.some((t) => t.includes("XXXX"))).toBe(false); // L11 missing!
    expect(texts.some((t) => t.includes("Short response"))).toBe(false); // L12 missing!

    // Only new messages (L14-L27) are in the input
    expect(prep2!.messagesToSummarize.length).toBeLessThanOrEqual(14);
  });

  it("BUG: infinite compaction loop — big kept message never gets summarized across 5 rounds", () => {
    const entries: SessionEntry[] = [];

    // Small early messages
    for (let i = 0; i < 3; i++) {
      entries.push(userMsg(`Q${i}: ${"q".repeat(200)}`));
      entries.push(assistantMsg(`A${i}: ${"a".repeat(200)}`));
    }

    // One huge message (37K tokens)
    const bigMsg = userMsg(bigText(37000));
    entries.push(bigMsg);
    entries.push(assistantMsg("ok"));

    // Round 1: first compaction
    const prep1 = prepareCompactionBuggy(entries, DEFAULT_SETTINGS);
    expect(prep1).toBeDefined();
    expect(prep1!.firstKeptEntryId).toBe(bigMsg.id);
    entries.push(compactEntry("Summary of early messages.", bigMsg.id, 20000));

    // Rounds 2-5: each round adds a small exchange, compacts, and
    // verifies the big message is NEVER in messagesToSummarize.
    for (let round = 2; round <= 5; round++) {
      entries.push(userMsg(`msg-round-${round}`));
      entries.push(assistantMsg(`reply-round-${round}`));

      const prep = prepareCompactionBuggy(entries, DEFAULT_SETTINGS);
      expect(prep).toBeDefined();

      const totalSummarizeTokens = prep!.messagesToSummarize.reduce(
        (sum, msg) => sum + estimateTokens(msg),
        0,
      );
      const hasBigMsg = prep!.messagesToSummarize.some((msg) => estimateTokens(msg) > 10000);

      // BUG: every single round, the 37K message is missing
      expect(hasBigMsg).toBe(false);
      expect(totalSummarizeTokens).toBeLessThan(2000);

      // Simulate this round's compaction completing
      entries.push(compactEntry(`Summary round ${round}.`, prep!.firstKeptEntryId, 20000));
    }

    // After 5 rounds, the big message has NEVER been summarized.
    // In a real session, compaction fires every message because
    // context tokens never drop below the threshold.
  });

  it("BUG: context rebuild includes keptMessages, but next compaction drops them", () => {
    // Show the contradiction: session-manager SEES keptMessages,
    // but prepareCompaction IGNORES them.

    const entries: SessionEntry[] = [];

    for (let i = 0; i < 3; i++) {
      entries.push(userMsg(`Q${i}: ${"q".repeat(200)}`));
      entries.push(assistantMsg(`A${i}: ${"a".repeat(200)}`));
    }

    const bigMsg = userMsg(
      "IMPORTANT_FACT: The project deadline is March 15th. " + "x".repeat(79000),
    );
    entries.push(bigMsg);
    entries.push(assistantMsg("Got it, deadline is March 15th."));

    // Compaction#1
    entries.push(compactEntry("Summary of early Q&A.", bigMsg.id, 20000));

    entries.push(userMsg("What's the deadline?"));
    entries.push(assistantMsg("The deadline is March 15th."));

    // Context rebuild: AI CAN see the big message
    const context = buildSessionContext(entries);
    const contextTexts = context.map(getTextFromMsg);
    expect(contextTexts.some((t) => t.includes("IMPORTANT_FACT"))).toBe(true);

    // But compaction prep EXCLUDES it
    const prep2 = prepareCompactionBuggy(entries, DEFAULT_SETTINGS);
    expect(prep2).toBeDefined();
    const summarizeTexts = prep2!.messagesToSummarize.map(getTextFromMsg);
    expect(summarizeTexts.some((t) => t.includes("IMPORTANT_FACT"))).toBe(false); // BUG!
  });
});

// ============================================================================
// TESTS: Verify the fix
// ============================================================================

describe("compaction boundaryStart fix", () => {
  beforeEach(() => resetIds());

  it("FIXED: keptMessages from round 1 ARE included in round 2 messagesToSummarize", () => {
    const entries: SessionEntry[] = [];

    for (let i = 0; i < 5; i++) {
      entries.push(userMsg(`Question ${i + 1}: ${"q".repeat(400)}`));
      entries.push(assistantMsg(`Answer ${i + 1}: ${"a".repeat(600)}`));
    }

    const L11 = userMsg(bigText(37000));
    entries.push(L11);
    const L12 = assistantMsg("Short response to the big content.");
    entries.push(L12);

    entries.push(compactEntry("Summary of L1-L10.", L11.id, 30000));

    for (let i = 0; i < 7; i++) {
      entries.push(userMsg(`Follow-up ${i + 1}: ${"f".repeat(50)}`));
      entries.push(assistantMsg(`Reply ${i + 1}: ${"r".repeat(50)}`));
    }

    const prep2 = prepareCompactionFixed(entries, DEFAULT_SETTINGS);
    expect(prep2).toBeDefined();

    const texts = prep2!.messagesToSummarize.map(getTextFromMsg);
    // FIXED: L11 (from prev keptMessages) and L12 are now included
    expect(texts.some((t) => t.includes("XXXX"))).toBe(true); // L11 included!
    expect(texts.some((t) => t.includes("Short response"))).toBe(true); // L12 included!
  });

  it("FIXED: big message gets summarized in round 2, no infinite loop", () => {
    const entries: SessionEntry[] = [];

    for (let i = 0; i < 3; i++) {
      entries.push(userMsg(`Q${i}: ${"q".repeat(200)}`));
      entries.push(assistantMsg(`A${i}: ${"a".repeat(200)}`));
    }

    const bigMsg = userMsg(bigText(37000));
    entries.push(bigMsg);
    entries.push(assistantMsg("ok"));

    // Round 1
    const prep1 = prepareCompactionFixed(entries, DEFAULT_SETTINGS);
    expect(prep1).toBeDefined();
    entries.push(compactEntry("Summary of early messages.", bigMsg.id, 20000));

    // Round 2: add small exchange
    entries.push(userMsg("hello"));
    entries.push(assistantMsg("hi"));

    const prep2 = prepareCompactionFixed(entries, DEFAULT_SETTINGS);
    expect(prep2).toBeDefined();

    // FIXED: 37K message IS in summarize input (via prevKeptMessages)
    const totalTokens = prep2!.messagesToSummarize.reduce(
      (sum, msg) => sum + estimateTokens(msg),
      0,
    );
    expect(totalTokens).toBeGreaterThan(35000);

    const hasBigMsg = prep2!.messagesToSummarize.some((msg) => estimateTokens(msg) > 10000);
    expect(hasBigMsg).toBe(true);

    // After round 2 summarizes the big message, the summary replaces 37K
    // with ~1K tokens. No more compaction loop — context stays small.
    // Simulate: round 2 compaction done (big message now summarized away)
    entries.push(compactEntry("Summary including big content.", prep2!.firstKeptEntryId, 5000));

    // Round 3: should NOT see the big message again (it was summarized)
    entries.push(userMsg("follow up"));
    entries.push(assistantMsg("sure"));

    const prep3 = prepareCompactionFixed(entries, DEFAULT_SETTINGS);
    expect(prep3).toBeDefined();

    const round3HasBig = prep3!.messagesToSummarize.some((msg) => estimateTokens(msg) > 10000);
    expect(round3HasBig).toBe(false); // big message was consumed in round 2
  });

  it("FIXED: keptMessages are properly carried into summarization, preserving info", () => {
    const entries: SessionEntry[] = [];

    for (let i = 0; i < 3; i++) {
      entries.push(userMsg(`Q${i}: ${"q".repeat(200)}`));
      entries.push(assistantMsg(`A${i}: ${"a".repeat(200)}`));
    }

    const bigMsg = userMsg(
      "IMPORTANT_FACT: The project deadline is March 15th. " + "x".repeat(79000),
    );
    entries.push(bigMsg);
    entries.push(assistantMsg("Got it, deadline is March 15th."));

    entries.push(compactEntry("Summary of early Q&A.", bigMsg.id, 20000));

    entries.push(userMsg("What's the deadline?"));
    entries.push(assistantMsg("The deadline is March 15th."));

    const prep2 = prepareCompactionFixed(entries, DEFAULT_SETTINGS);
    expect(prep2).toBeDefined();

    const summarizeTexts = prep2!.messagesToSummarize.map(getTextFromMsg);
    // FIXED: IMPORTANT_FACT is now in summarization input
    expect(summarizeTexts.some((t) => t.includes("IMPORTANT_FACT"))).toBe(true);
    expect(prep2!.previousSummary).toBe("Summary of early Q&A.");
  });

  it("FIXED: multi-round compaction — round 3 still preserves round 1 kept info", () => {
    const SMALL = { enabled: true, reserveTokens: 4096, keepRecentTokens: 2000 };
    const entries: SessionEntry[] = [];

    // Round 1: 5 pairs, ~750 tokens each = ~3750 total
    for (let i = 0; i < 5; i++) {
      entries.push(userMsg(`R1-Fact-${i}: ${"f".repeat(600)}`));
      entries.push(assistantMsg(`R1-Ack-${i}: ${"a".repeat(600)}`));
    }

    const prep1 = prepareCompactionFixed(entries, SMALL);
    expect(prep1).toBeDefined();
    const keptId1 = prep1!.firstKeptEntryId;
    const keptIdx1 = entries.findIndex((e) => e.id === keptId1);
    const numKeptR1 = entries.slice(keptIdx1).filter((e) => e.type === "message").length;
    expect(numKeptR1).toBeGreaterThan(0);

    entries.push(compactEntry("Round 1 summary.", keptId1, 5000));

    // Round 2: 5 more pairs
    for (let i = 0; i < 5; i++) {
      entries.push(userMsg(`R2-Fact-${i}: ${"n".repeat(600)}`));
      entries.push(assistantMsg(`R2-Ack-${i}: ${"a".repeat(600)}`));
    }

    const prep2 = prepareCompactionFixed(entries, SMALL);
    expect(prep2).toBeDefined();

    // Verify round 1's kept messages are in round 2's summarize input
    const r1KeptTexts = entries
      .slice(keptIdx1, keptIdx1 + numKeptR1)
      .filter((e): e is MessageEntry => e.type === "message")
      .map((e) => getTextFromMsg(e.message));

    const r2SumTexts = prep2!.messagesToSummarize.map(getTextFromMsg);

    const r1InR2 = r1KeptTexts.some((kt) => r2SumTexts.some((st) => st === kt));
    expect(r1InR2).toBe(true);

    // Simulate compaction#2
    const keptId2 = prep2!.firstKeptEntryId;
    entries.push(compactEntry("Round 2 summary (includes R1 kept info).", keptId2, 5000));

    // Round 3: 5 more pairs
    for (let i = 0; i < 5; i++) {
      entries.push(userMsg(`R3-Fact-${i}: ${"r".repeat(600)}`));
      entries.push(assistantMsg(`R3-Ack-${i}: ${"a".repeat(600)}`));
    }

    const prep3 = prepareCompactionFixed(entries, SMALL);
    expect(prep3).toBeDefined();

    // Round 2's kept messages should be in round 3's summarize input
    const keptIdx2 = entries.findIndex((e) => e.id === keptId2);
    const r2CompactIdx = entries.findIndex(
      (e) => e.type === "compaction" && e.firstKeptEntryId === keptId2,
    );
    const r2KeptTexts = entries
      .slice(keptIdx2, r2CompactIdx)
      .filter((e): e is MessageEntry => e.type === "message")
      .map((e) => getTextFromMsg(e.message));

    const r3SumTexts = prep3!.messagesToSummarize.map(getTextFromMsg);
    const r2InR3 = r2KeptTexts.some((kt) => r3SumTexts.some((st) => st === kt));
    expect(r2InR3).toBe(true);

    // previousSummary should be from round 2
    expect(prep3!.previousSummary).toBe("Round 2 summary (includes R1 kept info).");
  });
});
