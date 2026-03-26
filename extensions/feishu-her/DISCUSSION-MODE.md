# Feishu Discussion Mode — Architecture

## Overview

Discussion mode enables multi-bot group conversations in Feishu. Multiple bots
(each running in a separate Docker container) collaborate via Redis pub/sub
to hold real-time discussions initiated by a human user.

## Components

### 1. Redis State (`discussion-state.ts`)

| Redis Key | Type | Purpose |
|---|---|---|
| `discussion:{chatId}:participants` | Sorted Set | Active bots (score = epoch-seconds) |
| `discussion:{chatId}:leader` | String | Current leader appId |
| `discussion:{chatId}:last_activity` | String | Last activity epoch-ms (for auto-exit) |

- **Participant Lease**: bots ZADD themselves every 10s tick. Stale members (>30s) are pruned.
- **Leader Election**: smallest appId among active participants. Re-elected only when current leader drops.
- **Auto-Exit**: if `last_activity` exceeds `AUTO_EXIT_MS` (5 min), discussion mode reverts to `group-at`.

### 2. Bot-to-Bot Broadcast (`discussion-state.ts` pub/sub)

- **Channel**: `bot-msg:{chatId}`
- **Publisher**: `publishBotMessage()` — called from two paths:
  1. Card stream finalize (deliver callback path)
  2. `sendText()` in `channel.ts` (message tool path)
- **Subscriber**: `subscribeBotMessages()` — receives other bots' messages in <100ms.
- **Inject**: `injectBroadcastMessage()` in `gateway.ts` — converts broadcast into an inbound message for `handleInboundMessage`, with a collect-buffer to avoid flooding the session lane.

### 3. Broadcast Collect Buffer (`gateway.ts`)

Only one broadcast dispatches at a time per chat. Subsequent broadcasts during
an active dispatch are buffered (`broadcastPending` map, keeps latest only).
When the active dispatch completes, the pending message is drained.
AI sees intermediate messages via 20-message history injection.

### 4. Heartbeat — Deferred Model (gateway.ts)

Leader heartbeats check discussion health (continue/activate participants/exit).

**Old model (removed)**: heartbeats called `handleInboundMessage` directly, occupying
the session lane for 4-9s per tick, blocking real messages.

**Current model (deferred + true-idle fallback)**:

```
Timer tick (10s)
  └─ heartbeat conditions met?
       ├─ No existing deferred → store in deferredHeartbeat map ("deferred")
       ├─ Existing but < 60s old → skip (wait for merge or true-idle)
       └─ Existing ≥ 60s old (true idle) → check lane free → dispatch
```

- **`deferredHeartbeat`** (module-level `Map<string, { prompt, deferredAt }>`):
  Stores heartbeat prompt. Consumed by the next real message's `handleInboundMessage`,
  merged into `ctxPayload.BodyForAgent` or `ctxPayload.Body`. Zero extra lane occupancy.

- **`activeDispatchChats`** (module-level `Set<string>`):
  Tracks active dispatches. Heartbeat true-idle dispatch only fires when the chat
  has no active dispatch AND no active broadcast processing.

- **True-Idle Fallback** (`DEFERRED_HEARTBEAT_TRUE_IDLE_MS = 60s`):
  If no real message consumes the deferred heartbeat for 60s, and the lane is free,
  dispatch it directly.

### 5. Card Stream Guard (gateway.ts)

`startCardStream()` skips when:
- `isSyntheticMessage` (heartbeat) — always skipped
- `isBotSender` (broadcast from another bot) — **added to prevent 180s orphan card streams**
- `!sharedCardStreamingEnabled` or `cardStream` already exists

**Why**: when AI responds to broadcasts via `message` tool (bypassing `deliver` callback),
the card stream is never updated or finalized, causing a 180s hang on `stopCardStream()`.

### 6. Activity Timer (gateway.ts webhook handler)

`recordDiscussionActivity(chatId)` is called fire-and-forget for every group
message received via webhook (line ~1005). This ensures the Redis `last_activity`
key stays fresh even when the bot doesn't produce a response, preventing
premature auto-exit during active human participation.

Previously, only broadcast injection called `recordDiscussionActivity`, so direct
webhook messages didn't reset the timer.

## Message Flow

```
Human @mentions bots in group
  │
  ├─► Bot A (webhook) ──► handleInboundMessage ──► AI dispatch ──► response
  │     │                    │                                        │
  │     │                    └─ consume deferredHeartbeat (if any)    │
  │     │                                                             │
  │     └─ recordDiscussionActivity(chatId)                           │
  │                                                                   │
  │   AI responds via deliver callback OR message tool                │
  │     │                                                             │
  │     └─► publishBotMessage ──► Redis pub/sub ──────────────────────┘
  │                                    │
  ├─► Bot B (subscriber) ◄────────────┘
  │     │
  │     └─► injectBroadcastMessage ──► handleInboundMessage ──► AI dispatch
  │           │
  │           └─ broadcastActive/broadcastPending collect buffer
  │
  └─► Bot C (subscriber) ◄── same flow as Bot B
```

## Key Constants

| Constant | Value | Location |
|---|---|---|
| `TICK_INTERVAL_MS` | 10,000 ms | gateway.ts |
| `LEADER_HEARTBEAT_INTERVAL_MS` | 30,000 ms | gateway.ts |
| `HEARTBEAT_SUPPRESS_MS` | 60,000 ms | gateway.ts |
| `LEADER_HEARTBEAT_MAX_IDLE` | 3 | gateway.ts |
| `DEFERRED_HEARTBEAT_TRUE_IDLE_MS` | 60,000 ms | gateway.ts (module-level) |
| `AUTO_EXIT_MS` | 300,000 ms (5 min) | discussion-state.ts |
| `LEASE_TTL_S` | 30 s | discussion-state.ts |

## Known Limitations

1. **AI message quality**: AI sometimes sends empty @mention-only messages via `feishu_message` tool. Needs prompt-level tuning.
2. **Reply-to formatting**: broadcast-injected messages may lose the "reply to" visual in Feishu depending on the message tool path used.
3. **Status footer**: may not appear when AI uses `message` tool (bypasses the card stream finalize path where footer is appended).
