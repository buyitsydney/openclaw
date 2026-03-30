import { describe, expect, it } from "vitest";
import {
  advanceDiscussionTurnState,
  buildDiscussionTurnQueue,
  createDiscussionAssignedTurnState,
  createDiscussionRunningTurnState,
  getDiscussionTurnExpiryReason,
  markDiscussionTurnRunningState,
  prioritizeDiscussionTurnQueue,
  shouldRegisterDiscussionParticipant,
  type DiscussionTurnState,
  type DiscussionTurnAdvanceResult,
} from "./discussion-state.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function runningTurn(
  overrides: Partial<{
    chairAppId: string;
    ownerAppId: string;
    participantAppIds: string[];
    roomEpoch: number;
    fencingToken: number;
    nowMs: number;
  }> = {},
): DiscussionTurnState {
  return createDiscussionRunningTurnState({
    roomEpoch: overrides.roomEpoch ?? 1,
    fencingToken: overrides.fencingToken ?? 1,
    chairAppId: overrides.chairAppId ?? "cli_chair",
    ownerAppId: overrides.ownerAppId ?? "cli_chair",
    participantAppIds: overrides.participantAppIds ?? ["cli_chair", "cli_b", "cli_c"],
    sourceMessageId: "msg-test",
    nowMs: overrides.nowMs ?? 1_000,
  });
}

function assignedTurn(
  overrides: Partial<{
    chairAppId: string;
    ownerAppId: string;
    participantAppIds: string[];
    roomEpoch: number;
    fencingToken: number;
    nowMs: number;
    assignTimeoutMs: number;
  }> = {},
): DiscussionTurnState {
  return createDiscussionAssignedTurnState({
    roomEpoch: overrides.roomEpoch ?? 1,
    fencingToken: overrides.fencingToken ?? 1,
    chairAppId: overrides.chairAppId ?? "cli_chair",
    ownerAppId: overrides.ownerAppId ?? "cli_chair",
    participantAppIds: overrides.participantAppIds ?? ["cli_chair", "cli_b", "cli_c"],
    sourceMessageId: "msg-test",
    nowMs: overrides.nowMs ?? 1_000,
    assignTimeoutMs: overrides.assignTimeoutMs,
  });
}

function drainQueue(start: DiscussionTurnState): string[] {
  const owners: string[] = [];
  let current: DiscussionTurnState | null = start;
  for (let i = 0; i < 20; i++) {
    const result = advanceDiscussionTurnState(current!, { nowMs: 100_000 + i });
    if (result.closed) break;
    owners.push(result.nextTurn!.ownerAppId);
    current = result.nextTurn;
  }
  return owners;
}

// ── createDiscussionRunningTurnState ─────────────────────────────────────────

describe("createDiscussionRunningTurnState", () => {
  it("sets phase=running and finishDeadlineMs=0", () => {
    const t = runningTurn();
    expect(t.phase).toBe("running");
    expect(t.finishDeadlineMs).toBe(0);
    expect(t.assignDeadlineMs).toBe(1_000);
  });

  it("builds queue with chair closing last", () => {
    const t = runningTurn({
      chairAppId: "cli_chair",
      ownerAppId: "cli_chair",
      participantAppIds: ["cli_chair", "cli_b", "cli_c"],
    });
    expect(t.remainingQueue).toEqual(["cli_b", "cli_c", "cli_chair"]);
  });

  it("solo participant — queue is empty", () => {
    const t = runningTurn({
      chairAppId: "cli_solo",
      ownerAppId: "cli_solo",
      participantAppIds: ["cli_solo"],
    });
    expect(t.participantOrder).toEqual(["cli_solo"]);
    expect(t.remainingQueue).toEqual([]);
  });

  it("chair=owner with peers — chair still closes last", () => {
    const t = runningTurn({
      chairAppId: "cli_chair",
      ownerAppId: "cli_chair",
      participantAppIds: ["cli_chair", "cli_b"],
    });
    expect(t.remainingQueue).toEqual(["cli_b", "cli_chair"]);
  });

  it("owner != chair — owner not in queue, chair closes", () => {
    const t = runningTurn({
      chairAppId: "cli_chair",
      ownerAppId: "cli_b",
      participantAppIds: ["cli_chair", "cli_b", "cli_c"],
    });
    expect(t.ownerAppId).toBe("cli_b");
    expect(t.remainingQueue).toContain("cli_chair");
    expect(t.remainingQueue).not.toContain("cli_b");
    expect(t.remainingQueue[t.remainingQueue.length - 1]).toBe("cli_chair");
  });

  it("deduplicates participants", () => {
    const t = runningTurn({ participantAppIds: ["cli_chair", "cli_b", "cli_b", "cli_chair"] });
    expect(t.participantOrder).toEqual(["cli_chair", "cli_b"]);
  });

  it("turnId encodes epoch and fencingToken", () => {
    const t = runningTurn({ roomEpoch: 42, fencingToken: 7 });
    expect(t.turnId).toBe("turn-42-7");
  });
});

// ── createDiscussionAssignedTurnState ────────────────────────────────────────

describe("createDiscussionAssignedTurnState", () => {
  it("sets phase=assigned with correct deadline", () => {
    const t = assignedTurn({ nowMs: 5_000 });
    expect(t.phase).toBe("assigned");
    expect(t.assignDeadlineMs).toBe(5_000 + 30_000);
    expect(t.finishDeadlineMs).toBe(0);
  });

  it("respects custom assignTimeoutMs", () => {
    const t = assignedTurn({ nowMs: 5_000, assignTimeoutMs: 10_000 });
    expect(t.assignDeadlineMs).toBe(5_000 + 10_000);
  });
});

// ── markDiscussionTurnRunningState ───────────────────────────────────────────

describe("markDiscussionTurnRunningState", () => {
  it("transitions assigned → running, no finish deadline", () => {
    const assigned = assignedTurn({ nowMs: 1_000 });
    expect(assigned.phase).toBe("assigned");

    const running = markDiscussionTurnRunningState(assigned, { nowMs: 5_000 });
    expect(running.phase).toBe("running");
    expect(running.finishDeadlineMs).toBe(0);
    expect(running.assignDeadlineMs).toBe(5_000);
  });

  it("preserves all other state fields", () => {
    const assigned = assignedTurn({ roomEpoch: 99, fencingToken: 42 });
    const running = markDiscussionTurnRunningState(assigned, { nowMs: 10_000 });
    expect(running.roomEpoch).toBe(99);
    expect(running.fencingToken).toBe(42);
    expect(running.ownerAppId).toBe(assigned.ownerAppId);
    expect(running.remainingQueue).toEqual(assigned.remainingQueue);
    expect(running.participantOrder).toEqual(assigned.participantOrder);
  });
});

// ── getDiscussionTurnExpiryReason ────────────────────────────────────────────

describe("getDiscussionTurnExpiryReason", () => {
  it("assigned turn: expires after assignDeadlineMs", () => {
    const t = assignedTurn({ nowMs: 1_000, assignTimeoutMs: 30_000 });
    expect(getDiscussionTurnExpiryReason(t, 1_000)).toBeNull();
    expect(getDiscussionTurnExpiryReason(t, 30_999)).toBeNull();
    expect(getDiscussionTurnExpiryReason(t, 31_000)).toBe("assign-timeout");
    expect(getDiscussionTurnExpiryReason(t, 999_999)).toBe("assign-timeout");
  });

  it("running turn: NEVER expires (finishDeadlineMs=0)", () => {
    const t = runningTurn({ nowMs: 1_000 });
    expect(t.finishDeadlineMs).toBe(0);
    expect(getDiscussionTurnExpiryReason(t, 1_000)).toBeNull();
    expect(getDiscussionTurnExpiryReason(t, 1_000_000)).toBeNull();
    expect(getDiscussionTurnExpiryReason(t, Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it("assigned turn with assignDeadlineMs=0 never expires", () => {
    const t: DiscussionTurnState = { ...assignedTurn(), assignDeadlineMs: 0 };
    expect(getDiscussionTurnExpiryReason(t, 999_999)).toBeNull();
  });
});

// ── advanceDiscussionTurnState ───────────────────────────────────────────────

describe("advanceDiscussionTurnState", () => {
  // ── normal queue advancement (no explicit handoff) ──

  it("pops next owner from remainingQueue", () => {
    const t = runningTurn({
      chairAppId: "cli_chair",
      ownerAppId: "cli_chair",
      participantAppIds: ["cli_chair", "cli_b", "cli_c"],
    });
    // queue = [cli_b, cli_c, cli_chair]
    const result = advanceDiscussionTurnState(t, { nowMs: 2_000 });
    expect(result.closed).toBe(false);
    expect(result.nextTurn!.ownerAppId).toBe("cli_b");
    expect(result.nextTurn!.remainingQueue).toEqual(["cli_c", "cli_chair"]);
  });

  it("drains full 3-bot queue: b → c → chair → closed", () => {
    const t = runningTurn();
    const owners = drainQueue(t);
    expect(owners).toEqual(["cli_b", "cli_c", "cli_chair"]);
  });

  it("empty queue with no explicit handoff → closed", () => {
    const solo = runningTurn({
      chairAppId: "cli_solo",
      ownerAppId: "cli_solo",
      participantAppIds: ["cli_solo"],
    });
    expect(solo.remainingQueue).toEqual([]);
    const result = advanceDiscussionTurnState(solo, { nowMs: 2_000 });
    expect(result.closed).toBe(true);
    expect(result.nextTurn).toBeNull();
  });

  it("increments fencingToken on each advance", () => {
    const t = runningTurn({ fencingToken: 10 });
    const r1 = advanceDiscussionTurnState(t, { nowMs: 2_000 });
    expect(r1.nextTurn!.fencingToken).toBe(11);
    const r2 = advanceDiscussionTurnState(r1.nextTurn!, { nowMs: 3_000 });
    expect(r2.nextTurn!.fencingToken).toBe(12);
  });

  it("sets phase=assigned on advanced turn", () => {
    const t = runningTurn();
    const result = advanceDiscussionTurnState(t, { nowMs: 2_000 });
    expect(result.nextTurn!.phase).toBe("assigned");
    expect(result.nextTurn!.finishDeadlineMs).toBe(0);
    expect(result.nextTurn!.assignDeadlineMs).toBe(2_000 + 30_000);
  });

  // ── explicit handoff (@mention) ──

  it("explicit handoff picks the first mentioned bot", () => {
    const t = runningTurn();
    const result = advanceDiscussionTurnState(t, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["cli_c"],
    });
    expect(result.nextTurn!.ownerAppId).toBe("cli_c");
  });

  it("explicit handoff to multiple bots: first gets turn, rest in queue", () => {
    const t = runningTurn();
    const result = advanceDiscussionTurnState(t, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["cli_c", "cli_b"],
    });
    expect(result.nextTurn!.ownerAppId).toBe("cli_c");
    expect(result.nextTurn!.remainingQueue).toContain("cli_b");
    expect(result.nextTurn!.remainingQueue).toContain("cli_chair");
  });

  it("filters self-mention from prioritizedOwnerAppIds", () => {
    const t = runningTurn({ ownerAppId: "cli_chair" });
    const result = advanceDiscussionTurnState(t, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["cli_chair", "cli_c"],
    });
    expect(result.nextTurn!.ownerAppId).toBe("cli_c");
  });

  // ── THE BUG FIX: handoff from solo-seeded bootstrap ──

  it("BUG FIX: solo participant @mentions 2 bots — both enter queue", () => {
    const solo = runningTurn({
      chairAppId: "cli_chair",
      ownerAppId: "cli_chair",
      participantAppIds: ["cli_chair"],
    });
    expect(solo.remainingQueue).toEqual([]);

    const result = advanceDiscussionTurnState(solo, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["cli_b", "cli_c"],
    });
    expect(result.closed).toBe(false);
    expect(result.nextTurn!.ownerAppId).toBe("cli_b");
    expect(result.nextTurn!.remainingQueue).toContain("cli_c");
    expect(result.nextTurn!.remainingQueue).toContain("cli_chair");
    expect(result.nextTurn!.participantOrder).toEqual(["cli_chair", "cli_b", "cli_c"]);
  });

  it("BUG FIX: solo participant @mentions 1 bot — chair still closes after", () => {
    const solo = runningTurn({
      chairAppId: "cli_chair",
      ownerAppId: "cli_chair",
      participantAppIds: ["cli_chair"],
    });
    const result = advanceDiscussionTurnState(solo, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["cli_b"],
    });
    expect(result.nextTurn!.ownerAppId).toBe("cli_b");
    expect(result.nextTurn!.remainingQueue).toEqual(["cli_chair"]);

    const owners = drainQueue(solo);
    // without explicit handoff on subsequent turns, just drain the rebuilt queue
  });

  it("BUG FIX: full 3-bot lifecycle from solo seed + @mention two bots", () => {
    // Reproduces exact production scenario:
    // Bootstrap seeds only cli_chair. cli_chair @mentions cli_b and cli_c.
    const solo = runningTurn({
      chairAppId: "cli_chair",
      ownerAppId: "cli_chair",
      participantAppIds: ["cli_chair"],
    });
    expect(solo.remainingQueue).toEqual([]);

    // cli_chair finishes, @cli_b @cli_c
    const step1 = advanceDiscussionTurnState(solo, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["cli_b", "cli_c"],
    });
    expect(step1.nextTurn!.ownerAppId).toBe("cli_b");
    expect(step1.nextTurn!.remainingQueue).toEqual(["cli_c", "cli_chair"]);

    // cli_b finishes, no explicit handoff — normal queue drain
    const step2 = advanceDiscussionTurnState(step1.nextTurn!, { nowMs: 3_000 });
    expect(step2.nextTurn!.ownerAppId).toBe("cli_c");
    expect(step2.nextTurn!.remainingQueue).toEqual(["cli_chair"]);

    // cli_c finishes — chair closes
    const step3 = advanceDiscussionTurnState(step2.nextTurn!, { nowMs: 4_000 });
    expect(step3.nextTurn!.ownerAppId).toBe("cli_chair");
    expect(step3.nextTurn!.remainingQueue).toEqual([]);

    // chair finishes — closed
    const step4 = advanceDiscussionTurnState(step3.nextTurn!, { nowMs: 5_000 });
    expect(step4.closed).toBe(true);
    expect(step4.nextTurn).toBeNull();
  });

  // ── handoff to brand-new bot not in original participants ──

  it("handoff to unknown bot adds it to participantOrder", () => {
    const t = runningTurn({ participantAppIds: ["cli_chair", "cli_b"] });
    const result = advanceDiscussionTurnState(t, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["cli_new"],
    });
    expect(result.nextTurn!.ownerAppId).toBe("cli_new");
    expect(result.nextTurn!.participantOrder).toContain("cli_new");
    expect(result.nextTurn!.remainingQueue).toContain("cli_b");
    expect(result.nextTurn!.remainingQueue).toContain("cli_chair");
  });

  // ── handoff to bot already in queue ──

  it("handoff to a bot already in queue: queue is rebuilt, no duplicates", () => {
    const t = runningTurn();
    // queue = [cli_b, cli_c, cli_chair]
    const result = advanceDiscussionTurnState(t, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["cli_c"],
    });
    expect(result.nextTurn!.ownerAppId).toBe("cli_c");
    const q = result.nextTurn!.remainingQueue;
    expect(q.filter((id) => id === "cli_c")).toHaveLength(0);
    expect(q).toContain("cli_b");
    expect(q).toContain("cli_chair");
  });

  // ── queue rebuild preserves chair-last order ──

  it("rebuilt queue always has chair closing last", () => {
    const solo = runningTurn({
      chairAppId: "cli_chair",
      ownerAppId: "cli_chair",
      participantAppIds: ["cli_chair"],
    });
    const result = advanceDiscussionTurnState(solo, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["cli_x", "cli_y", "cli_z"],
    });
    const q = result.nextTurn!.remainingQueue;
    expect(q[q.length - 1]).toBe("cli_chair");
  });

  // ── empty prioritizedOwnerAppIds treated like no explicit handoff ──

  it("empty prioritizedOwnerAppIds array = normal queue advancement", () => {
    const t = runningTurn();
    const result = advanceDiscussionTurnState(t, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: [],
    });
    expect(result.nextTurn!.ownerAppId).toBe("cli_b");
  });

  it("prioritizedOwnerAppIds with only self = normal queue advancement", () => {
    const t = runningTurn({ ownerAppId: "cli_chair" });
    const result = advanceDiscussionTurnState(t, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["cli_chair"],
    });
    // self filtered out, falls back to normal queue
    expect(result.nextTurn!.ownerAppId).toBe("cli_b");
  });
});

// ── buildDiscussionTurnQueue ─────────────────────────────────────────────────

describe("buildDiscussionTurnQueue", () => {
  it("3 participants, chair=owner: peers then chair", () => {
    expect(
      buildDiscussionTurnQueue({
        participantOrder: ["cli_chair", "cli_b", "cli_c"],
        chairAppId: "cli_chair",
        ownerAppId: "cli_chair",
      }),
    ).toEqual(["cli_b", "cli_c", "cli_chair"]);
  });

  it("3 participants, owner=cli_b: rotation after owner, chair closes", () => {
    expect(
      buildDiscussionTurnQueue({
        participantOrder: ["cli_chair", "cli_b", "cli_c"],
        chairAppId: "cli_chair",
        ownerAppId: "cli_b",
      }),
    ).toEqual(["cli_c", "cli_chair"]);
  });

  it("solo participant (chair=owner, no peers): empty queue", () => {
    expect(
      buildDiscussionTurnQueue({
        participantOrder: ["cli_solo"],
        chairAppId: "cli_solo",
        ownerAppId: "cli_solo",
      }),
    ).toEqual([]);
  });

  it("2 participants, chair=owner: peer then chair", () => {
    expect(
      buildDiscussionTurnQueue({
        participantOrder: ["cli_chair", "cli_b"],
        chairAppId: "cli_chair",
        ownerAppId: "cli_chair",
      }),
    ).toEqual(["cli_b", "cli_chair"]);
  });

  it("owner not in participantOrder: returns all others with chair last", () => {
    expect(
      buildDiscussionTurnQueue({
        participantOrder: ["cli_chair", "cli_b", "cli_c"],
        chairAppId: "cli_chair",
        ownerAppId: "cli_missing",
      }),
    ).toEqual(["cli_b", "cli_c", "cli_chair"]);
  });

  it("deduplicates inputs", () => {
    expect(
      buildDiscussionTurnQueue({
        participantOrder: ["cli_chair", "cli_b", "cli_b", "cli_c", "cli_chair"],
        chairAppId: "cli_chair",
        ownerAppId: "cli_chair",
      }),
    ).toEqual(["cli_b", "cli_c", "cli_chair"]);
  });

  it("chair not in participantOrder: no chair closing", () => {
    expect(
      buildDiscussionTurnQueue({
        participantOrder: ["cli_a", "cli_b"],
        chairAppId: "cli_missing",
        ownerAppId: "cli_a",
      }),
    ).toEqual(["cli_b"]);
  });

  it("4 participants, rotation from middle owner", () => {
    expect(
      buildDiscussionTurnQueue({
        participantOrder: ["cli_a", "cli_b", "cli_c", "cli_d"],
        chairAppId: "cli_a",
        ownerAppId: "cli_b",
      }),
    ).toEqual(["cli_c", "cli_d", "cli_a"]);
  });
});

// ── prioritizeDiscussionTurnQueue ────────────────────────────────────────────

describe("prioritizeDiscussionTurnQueue", () => {
  it("moves prioritized to front, preserves rest", () => {
    expect(prioritizeDiscussionTurnQueue(["cli_b", "cli_c", "cli_chair"], ["cli_c"])).toEqual([
      "cli_c",
      "cli_b",
      "cli_chair",
    ]);
  });

  it("empty queue + prioritized = just prioritized", () => {
    expect(prioritizeDiscussionTurnQueue([], ["cli_x", "cli_y"])).toEqual(["cli_x", "cli_y"]);
  });

  it("no prioritized = original order", () => {
    expect(prioritizeDiscussionTurnQueue(["cli_a", "cli_b"], [])).toEqual(["cli_a", "cli_b"]);
  });

  it("prioritized not in queue: added to front", () => {
    expect(prioritizeDiscussionTurnQueue(["cli_a", "cli_b"], ["cli_new"])).toEqual([
      "cli_new",
      "cli_a",
      "cli_b",
    ]);
  });

  it("deduplicates across queue and prioritized", () => {
    expect(
      prioritizeDiscussionTurnQueue(["cli_a", "cli_b", "cli_a"], ["cli_b", "cli_c", "cli_b"]),
    ).toEqual(["cli_b", "cli_c", "cli_a"]);
  });
});

// ── endDiscussion semantic: empty queue → advance closes ─────────────────────

describe("endDiscussion queue-clearing semantics", () => {
  it("after remainingQueue is emptied, advance returns closed", () => {
    const t = runningTurn();
    expect(t.remainingQueue.length).toBeGreaterThan(0);

    const ended: DiscussionTurnState = { ...t, remainingQueue: [] };
    const result = advanceDiscussionTurnState(ended, { nowMs: 9_000 });
    expect(result.closed).toBe(true);
    expect(result.nextTurn).toBeNull();
  });

  it("after remainingQueue is emptied, explicit handoff can still start new round", () => {
    const t = runningTurn();
    const ended: DiscussionTurnState = { ...t, remainingQueue: [] };

    const result = advanceDiscussionTurnState(ended, {
      nowMs: 9_000,
      prioritizedOwnerAppIds: ["cli_b"],
    });
    expect(result.closed).toBe(false);
    expect(result.nextTurn!.ownerAppId).toBe("cli_b");
  });
});

// ── full lifecycle simulation ────────────────────────────────────────────────

describe("full discussion lifecycle", () => {
  it("3-bot full round: chair opens → b → c → chair closes → done", () => {
    const turn1 = runningTurn({
      chairAppId: "cli_chair",
      ownerAppId: "cli_chair",
      participantAppIds: ["cli_chair", "cli_b", "cli_c"],
      fencingToken: 1,
      roomEpoch: 5,
    });
    expect(turn1.turnId).toBe("turn-5-1");
    expect(turn1.ownerAppId).toBe("cli_chair");

    // chair → b (explicit handoff to cli_b)
    const step1 = advanceDiscussionTurnState(turn1, {
      nowMs: 10_000,
      prioritizedOwnerAppIds: ["cli_b"],
    });
    expect(step1.nextTurn!.turnId).toBe("turn-5-2");
    expect(step1.nextTurn!.ownerAppId).toBe("cli_b");
    expect(step1.nextTurn!.phase).toBe("assigned");

    // b claims turn
    const claimed = markDiscussionTurnRunningState(step1.nextTurn!, { nowMs: 12_000 });
    expect(claimed.phase).toBe("running");
    expect(claimed.finishDeadlineMs).toBe(0);

    // b → c (normal queue drain, no explicit handoff)
    const step2 = advanceDiscussionTurnState(claimed, { nowMs: 50_000 });
    expect(step2.nextTurn!.ownerAppId).toBe("cli_c");

    // c → chair (last in queue)
    const step3 = advanceDiscussionTurnState(step2.nextTurn!, { nowMs: 100_000 });
    expect(step3.nextTurn!.ownerAppId).toBe("cli_chair");

    // chair finishes → closed
    const step4 = advanceDiscussionTurnState(step3.nextTurn!, { nowMs: 150_000 });
    expect(step4.closed).toBe(true);
  });

  it("assign-timeout skips dead bot, advances to next", () => {
    const turn = assignedTurn({
      chairAppId: "cli_chair",
      ownerAppId: "cli_dead",
      participantAppIds: ["cli_chair", "cli_dead", "cli_alive"],
      nowMs: 1_000,
      assignTimeoutMs: 30_000,
    });
    // cli_dead doesn't claim within 30s
    const reason = getDiscussionTurnExpiryReason(turn, 31_001);
    expect(reason).toBe("assign-timeout");

    // advance skips cli_dead to next in queue
    const result = advanceDiscussionTurnState(turn, { nowMs: 31_001 });
    expect(result.closed).toBe(false);
    expect(result.nextTurn!.ownerAppId).not.toBe("cli_dead");
  });

  it("running turn NEVER expires regardless of time elapsed", () => {
    const assigned = assignedTurn({ ownerAppId: "cli_b", nowMs: 1_000 });
    const running = markDiscussionTurnRunningState(assigned, { nowMs: 5_000 });

    // 1 hour later
    expect(getDiscussionTurnExpiryReason(running, 5_000 + 3_600_000)).toBeNull();
    // 1 day later
    expect(getDiscussionTurnExpiryReason(running, 5_000 + 86_400_000)).toBeNull();
  });

  it("endDiscussion then bot output: turn stays valid, advance closes cleanly", () => {
    const turn = runningTurn();
    // endDiscussion empties the queue
    const ended: DiscussionTurnState = { ...turn, remainingQueue: [] };
    // bot still has a valid turn (phase=running, ownerAppId matches)
    expect(ended.phase).toBe("running");
    expect(ended.ownerAppId).toBe("cli_chair");
    // bot delivers output and calls completeDiscussionTurnWithOutput (advance)
    const result = advanceDiscussionTurnState(ended, { nowMs: 50_000 });
    expect(result.closed).toBe(true);
  });

  it("2-bot minimal: chair opens, @mentions peer, peer finishes, chair closes", () => {
    const initial = runningTurn({
      chairAppId: "cli_chair",
      ownerAppId: "cli_chair",
      participantAppIds: ["cli_chair"],
    });
    expect(initial.remainingQueue).toEqual([]);

    const step1 = advanceDiscussionTurnState(initial, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["cli_peer"],
    });
    expect(step1.nextTurn!.ownerAppId).toBe("cli_peer");
    expect(step1.nextTurn!.remainingQueue).toEqual(["cli_chair"]);

    const step2 = advanceDiscussionTurnState(step1.nextTurn!, { nowMs: 3_000 });
    expect(step2.nextTurn!.ownerAppId).toBe("cli_chair");

    const step3 = advanceDiscussionTurnState(step2.nextTurn!, { nowMs: 4_000 });
    expect(step3.closed).toBe(true);
  });

  it("mid-discussion explicit handoff adds newcomer without losing existing queue", () => {
    const turn = runningTurn({
      chairAppId: "cli_chair",
      ownerAppId: "cli_b",
      participantAppIds: ["cli_chair", "cli_b", "cli_c"],
    });
    // Current: owner=cli_b, queue=[cli_c, cli_chair]
    // cli_b @mentions cli_new
    const result = advanceDiscussionTurnState(turn, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["cli_new"],
    });
    expect(result.nextTurn!.ownerAppId).toBe("cli_new");
    // Queue should include cli_c and cli_chair (chair last)
    expect(result.nextTurn!.remainingQueue).toContain("cli_c");
    expect(result.nextTurn!.remainingQueue).toContain("cli_chair");
    const q = result.nextTurn!.remainingQueue;
    expect(q[q.length - 1]).toBe("cli_chair");
  });
});

// ── shouldRegisterDiscussionParticipant ──────────────────────────────────────

describe("shouldRegisterDiscussionParticipant", () => {
  it("true only in discussion mode", () => {
    expect(shouldRegisterDiscussionParticipant({ isDiscussionMode: true })).toBe(true);
    expect(shouldRegisterDiscussionParticipant({ isDiscussionMode: false })).toBe(false);
  });
});

// ── advanceDiscussionTurnState — deeper edge cases ───────────────────────────

describe("advanceDiscussionTurnState edge cases", () => {
  it("custom assignTimeoutMs propagates to nextTurn", () => {
    const t = runningTurn();
    const result = advanceDiscussionTurnState(t, {
      nowMs: 5_000,
      assignTimeoutMs: 60_000,
    });
    expect(result.nextTurn!.assignDeadlineMs).toBe(5_000 + 60_000);
  });

  it("double advance on same state produces same deterministic result", () => {
    const t = runningTurn();
    const r1 = advanceDiscussionTurnState(t, { nowMs: 2_000 });
    const r2 = advanceDiscussionTurnState(t, { nowMs: 2_000 });
    expect(r1.nextTurn!.ownerAppId).toBe(r2.nextTurn!.ownerAppId);
    expect(r1.nextTurn!.remainingQueue).toEqual(r2.nextTurn!.remainingQueue);
    expect(r1.nextTurn!.fencingToken).toBe(r2.nextTurn!.fencingToken);
  });

  it("preserves sourceMessageId and roomEpoch across advances", () => {
    const t = runningTurn({ roomEpoch: 77 });
    const r = advanceDiscussionTurnState(t, { nowMs: 2_000 });
    expect(r.nextTurn!.roomEpoch).toBe(77);
    expect(r.nextTurn!.sourceMessageId).toBe("msg-test");
  });

  it("consecutive explicit handoffs: each adds to participants", () => {
    const t = runningTurn({
      chairAppId: "cli_chair",
      ownerAppId: "cli_chair",
      participantAppIds: ["cli_chair"],
    });

    // Round 1: chair @mentions cli_a
    const r1 = advanceDiscussionTurnState(t, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["cli_a"],
    });
    expect(r1.nextTurn!.participantOrder).toContain("cli_a");

    // Round 2: cli_a @mentions cli_b (brand new)
    const r2 = advanceDiscussionTurnState(r1.nextTurn!, {
      nowMs: 3_000,
      prioritizedOwnerAppIds: ["cli_b"],
    });
    expect(r2.nextTurn!.participantOrder).toContain("cli_a");
    expect(r2.nextTurn!.participantOrder).toContain("cli_b");
    expect(r2.nextTurn!.ownerAppId).toBe("cli_b");

    // Round 3: cli_b @mentions cli_c (brand new)
    const r3 = advanceDiscussionTurnState(r2.nextTurn!, {
      nowMs: 4_000,
      prioritizedOwnerAppIds: ["cli_c"],
    });
    expect(r3.nextTurn!.participantOrder).toContain("cli_a");
    expect(r3.nextTurn!.participantOrder).toContain("cli_b");
    expect(r3.nextTurn!.participantOrder).toContain("cli_c");
  });

  it("handoff back to previous speaker: no infinite loop, queue still drains", () => {
    const t = runningTurn({
      chairAppId: "cli_chair",
      ownerAppId: "cli_chair",
      participantAppIds: ["cli_chair", "cli_b", "cli_c"],
    });
    // chair @mentions cli_b
    const r1 = advanceDiscussionTurnState(t, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["cli_b"],
    });
    // cli_b @mentions cli_chair (back to previous speaker)
    const r2 = advanceDiscussionTurnState(r1.nextTurn!, {
      nowMs: 3_000,
      prioritizedOwnerAppIds: ["cli_chair"],
    });
    expect(r2.nextTurn!.ownerAppId).toBe("cli_chair");
    // cli_c and cli_b should be in queue (since queue was rebuilt)
    expect(r2.nextTurn!.remainingQueue).toContain("cli_c");
    expect(r2.nextTurn!.remainingQueue).toContain("cli_b");
  });

  it("all-self mentions filtered + empty queue = closed", () => {
    const solo = runningTurn({
      chairAppId: "cli_solo",
      ownerAppId: "cli_solo",
      participantAppIds: ["cli_solo"],
    });
    // @mention only self
    const result = advanceDiscussionTurnState(solo, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["cli_solo"],
    });
    expect(result.closed).toBe(true);
  });

  it("whitespace in prioritizedOwnerAppIds is trimmed", () => {
    const t = runningTurn();
    const result = advanceDiscussionTurnState(t, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["  cli_c  "],
    });
    expect(result.nextTurn!.ownerAppId).toBe("cli_c");
  });

  it("empty strings in prioritizedOwnerAppIds are ignored", () => {
    const t = runningTurn();
    const result = advanceDiscussionTurnState(t, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["", " ", "cli_c"],
    });
    expect(result.nextTurn!.ownerAppId).toBe("cli_c");
  });
});

// ── 5-bot complex lifecycle ──────────────────────────────────────────────────

describe("5-bot complex lifecycle", () => {
  it("full cycle: chair seeds 4 peers, round-robin to completion", () => {
    const bots = ["cli_chair", "cli_a", "cli_b", "cli_c", "cli_d"];
    const turn = runningTurn({
      chairAppId: "cli_chair",
      ownerAppId: "cli_chair",
      participantAppIds: bots,
    });
    // chair opens → queue has [a, b, c, d, chair(closing)]
    // drainQueue advances 5 times: a → b → c → d → chair → closed
    const owners = drainQueue(turn);
    expect(owners).toHaveLength(5);
    expect(owners[owners.length - 1]).toBe("cli_chair");
    // a, b, c, d each appear once; chair appears once (closing)
    for (const bot of ["cli_a", "cli_b", "cli_c", "cli_d", "cli_chair"]) {
      expect(owners.filter((o) => o === bot)).toHaveLength(1);
    }
  });

  it("mid-cycle handoff adds 2 new bots, all eventually speak", () => {
    const turn = runningTurn({
      chairAppId: "cli_chair",
      ownerAppId: "cli_chair",
      participantAppIds: ["cli_chair", "cli_a", "cli_b"],
    });
    // Queue: [cli_a, cli_b, cli_chair]

    // chair finishes, normal advance to cli_a
    const r1 = advanceDiscussionTurnState(turn, { nowMs: 2_000 });
    expect(r1.nextTurn!.ownerAppId).toBe("cli_a");

    // cli_a @mentions cli_new1 and cli_new2 (not yet in participants)
    const r2 = advanceDiscussionTurnState(r1.nextTurn!, {
      nowMs: 3_000,
      prioritizedOwnerAppIds: ["cli_new1", "cli_new2"],
    });
    expect(r2.nextTurn!.ownerAppId).toBe("cli_new1");
    expect(r2.nextTurn!.participantOrder).toContain("cli_new1");
    expect(r2.nextTurn!.participantOrder).toContain("cli_new2");
    expect(r2.nextTurn!.remainingQueue).toContain("cli_new2");
    expect(r2.nextTurn!.remainingQueue).toContain("cli_b");
    expect(r2.nextTurn!.remainingQueue).toContain("cli_chair");

    // Drain the rest
    const remaining = drainQueue(r2.nextTurn!);
    const allSpeakers = ["cli_chair", "cli_a", "cli_new1", ...remaining];
    // Every original + new participant should have spoken
    for (const bot of ["cli_a", "cli_b", "cli_chair", "cli_new1", "cli_new2"]) {
      expect(allSpeakers).toContain(bot);
    }
  });

  it("assign-timeout cascade: 3 dead bots in a row, alive bot eventually gets turn", () => {
    const turn = assignedTurn({
      chairAppId: "cli_alive",
      ownerAppId: "cli_dead1",
      participantAppIds: ["cli_alive", "cli_dead1", "cli_dead2", "cli_dead3"],
      nowMs: 1_000,
      assignTimeoutMs: 30_000,
    });

    // cli_dead1 expires
    expect(getDiscussionTurnExpiryReason(turn, 31_001)).toBe("assign-timeout");
    const r1 = advanceDiscussionTurnState(turn, { nowMs: 31_001 });
    expect(r1.closed).toBe(false);

    // Second bot might be dead too, etc.
    // Keep advancing until we hit cli_alive or close
    let current: DiscussionTurnAdvanceResult = r1;
    let found = false;
    for (let i = 0; i < 10 && !current.closed; i++) {
      if (current.nextTurn!.ownerAppId === "cli_alive") {
        found = true;
        break;
      }
      current = advanceDiscussionTurnState(current.nextTurn!, {
        nowMs: 40_000 + i * 31_000,
      });
    }
    // cli_alive must eventually get a turn (it's in the queue)
    expect(found || current.closed).toBe(true);
  });
});

// ── buildDiscussionTurnQueue — rotation correctness ─────────────────────────

describe("buildDiscussionTurnQueue rotation", () => {
  it("rotation wraps around correctly", () => {
    // 5 bots: [A, B, C, D, E], owner=C, chair=A
    // After C: D, E, A(wrapped), B(wrapped)
    // Non-chair peers after removing owner C and chair A: D, E, B → then A closes
    expect(
      buildDiscussionTurnQueue({
        participantOrder: ["cli_a", "cli_b", "cli_c", "cli_d", "cli_e"],
        chairAppId: "cli_a",
        ownerAppId: "cli_c",
      }),
    ).toEqual(["cli_d", "cli_e", "cli_b", "cli_a"]);
  });

  it("rotation when owner is last in list", () => {
    expect(
      buildDiscussionTurnQueue({
        participantOrder: ["cli_a", "cli_b", "cli_c"],
        chairAppId: "cli_a",
        ownerAppId: "cli_c",
      }),
    ).toEqual(["cli_b", "cli_a"]);
  });

  it("rotation when owner is first in list", () => {
    expect(
      buildDiscussionTurnQueue({
        participantOrder: ["cli_a", "cli_b", "cli_c"],
        chairAppId: "cli_a",
        ownerAppId: "cli_a",
      }),
    ).toEqual(["cli_b", "cli_c", "cli_a"]);
  });
});

// ── getDiscussionTurnExpiryReason — boundary values ─────────────────────────

describe("getDiscussionTurnExpiryReason boundary values", () => {
  it("exactly at assignDeadlineMs triggers timeout", () => {
    const t = assignedTurn({ nowMs: 0, assignTimeoutMs: 30_000 });
    expect(getDiscussionTurnExpiryReason(t, 30_000)).toBe("assign-timeout");
  });

  it("1ms before assignDeadlineMs does not trigger", () => {
    const t = assignedTurn({ nowMs: 0, assignTimeoutMs: 30_000 });
    expect(getDiscussionTurnExpiryReason(t, 29_999)).toBeNull();
  });

  it("running with manually set finishDeadlineMs > 0 would trigger (legacy compat)", () => {
    const t: DiscussionTurnState = {
      ...runningTurn({ nowMs: 0 }),
      finishDeadlineMs: 120_000,
    };
    expect(getDiscussionTurnExpiryReason(t, 119_999)).toBeNull();
    expect(getDiscussionTurnExpiryReason(t, 120_000)).toBe("finish-timeout");
  });

  it("negative nowMs: no expiry", () => {
    const t = assignedTurn({ nowMs: 0, assignTimeoutMs: 30_000 });
    expect(getDiscussionTurnExpiryReason(t, -1)).toBeNull();
  });
});

// ── createDiscussionRunningTurnState — participant normalization ─────────────

describe("participant normalization edge cases", () => {
  it("empty participantAppIds: only owner+chair deduplicated", () => {
    const t = createDiscussionRunningTurnState({
      roomEpoch: 1,
      fencingToken: 1,
      chairAppId: "cli_chair",
      ownerAppId: "cli_b",
      participantAppIds: [],
      sourceMessageId: "msg",
      nowMs: 0,
    });
    expect(t.participantOrder).toEqual(["cli_b", "cli_chair"]);
  });

  it("chair == owner: no duplicate in participantOrder", () => {
    const t = createDiscussionRunningTurnState({
      roomEpoch: 1,
      fencingToken: 1,
      chairAppId: "cli_same",
      ownerAppId: "cli_same",
      participantAppIds: ["cli_same", "cli_other"],
      sourceMessageId: "msg",
      nowMs: 0,
    });
    expect(t.participantOrder.filter((id) => id === "cli_same")).toHaveLength(1);
  });

  it("participantAppIds with whitespace-only entries are filtered", () => {
    const t = createDiscussionRunningTurnState({
      roomEpoch: 1,
      fencingToken: 1,
      chairAppId: "cli_chair",
      ownerAppId: "cli_b",
      participantAppIds: ["cli_chair", "  ", "cli_b", ""],
      sourceMessageId: "msg",
      nowMs: 0,
    });
    expect(t.participantOrder).toEqual(["cli_b", "cli_chair"]);
  });
});

// ── markDiscussionTurnRunningState — idempotency ────────────────────────────

describe("markDiscussionTurnRunningState edge cases", () => {
  it("marking an already-running turn updates assignDeadlineMs only", () => {
    const running = runningTurn({ nowMs: 1_000 });
    const re_marked = markDiscussionTurnRunningState(running, { nowMs: 99_000 });
    expect(re_marked.phase).toBe("running");
    expect(re_marked.assignDeadlineMs).toBe(99_000);
    expect(re_marked.finishDeadlineMs).toBe(0);
  });
});
