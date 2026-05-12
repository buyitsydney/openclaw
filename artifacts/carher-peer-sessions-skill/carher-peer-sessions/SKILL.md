---
name: carher-peer-sessions
description: Use when the user asks to inspect the other CarHer engine's session history or memory after hot switch, including OpenClaw-from-Hermes, Hermes-from-OpenClaw, peer engine memory, cross-engine sessions, another framework/entity/session, or comparing OpenClaw/Hermes stored memory.
---

# CarHer Peer Sessions

Use this skill when the user asks about memory, session history, or prior messages that may live in the other CarHer engine after a hot switch: OpenClaw from Hermes, Hermes from OpenClaw, or "another framework/entity/session".

## Core Rule

Never answer cross-engine memory from guesswork or from the active prompt alone. Inspect the peer engine's persisted files directly, then answer with concrete source evidence.

This skill is only a map of the two engines' storage layouts and safety rules. It intentionally does not provide a custom helper program. Use the normal file inspection tools available in the environment and adapt to the live filesystem.

## Engine And Peer

- Active engine marker: `/data/.engine/active`.
- Valid active values: `openclaw` or `hermes`.
- `peer` means the other engine:
  - active `openclaw` -> peer `hermes`
  - active `hermes` -> peer `openclaw`
- If the marker is absent or unreadable, inspect both engines and state the uncertainty.

## OpenClaw Storage

OpenClaw normally uses `/data/.openclaw` as its persisted home in CarHer runtime containers.

Important paths:

- Agent state: `/data/.openclaw/agents/`
- Main agent sessions index: `/data/.openclaw/agents/main/sessions.json`
- Main agent session transcripts: `/data/.openclaw/agents/main/sessions/*.jsonl`
- Reset backups may appear beside transcripts as `*.jsonl.reset.*`
- Feishu group archives, when present: `/data/.openclaw/feishu-groups/`
- Workspace memory:
  - `/data/.openclaw/workspace/SOUL.md`
  - `/data/.openclaw/workspace/USER.md`
  - `/data/.openclaw/workspace/MEMORY.md`
- Some older CarHer workspaces may also have:
  - `/data/.openclaw/workspace-claude/SOUL.md`
  - `/data/.openclaw/workspace-claude/USER.md`
  - `/data/.openclaw/workspace-claude/MEMORY.md`

OpenClaw session transcripts are JSONL. Expect records for session metadata and messages. Message records usually include role, content blocks, timestamps, and optional metadata such as Feishu ids or `source=peer-engine`.

When the user asks for the "current" OpenClaw session, do not assume the newest file is always current. Prefer the session id referenced by `sessions.json` for the relevant session key, then fall back to updated time and visible Feishu ids.

## Hermes Storage

Hermes normally uses `/opt/data` as its persisted home in CarHer runtime containers.

Important paths:

- Sessions: `/opt/data/sessions/*.jsonl`
- Soul memory: `/opt/data/SOUL.md`
- Structured memory:
  - `/opt/data/memories/USER.md`
  - `/opt/data/memories/MEMORY.md`
- Logs, when needed for routing/debug context: `/opt/data/logs/`

Hermes session transcripts are JSONL. Expect message records, tool records, parent/ordering metadata, and imported peer-engine records when catch-up has run.

If a container uses a different Hermes home, prefer the live environment variables or obvious mounted data directory over this default path, and state which path was used.

## How To Investigate

Start from the user's question:

- If they provide an exact phrase, unique fact, message id, or marker, inspect the peer engine's session and memory roots for that value.
- If they ask for recent peer history without a phrase, start from the active marker, then inspect the peer engine's newest relevant session files and indexes.
- If they ask for a DM or group continuity check, correlate message ids, Feishu chat ids, parent/order fields, and session JSONL order when those fields are present.
- If they ask for memory migration verification, compare OpenClaw workspace memory with Hermes memory files and mention whether content is byte-identical, transformed, missing, or conflicting.

Prefer evidence from the peer engine's persisted session or memory file over summaries, logs, or current prompt text. Logs can explain routing, but they are not the source of truth for remembered conversation content.

Ignore noisy implementation traces unless the user explicitly asks for them:

- `*.trajectory.jsonl`
- gateway debug logs
- transient swap animation cards
- shutdown or restart notices
- stale anchor diagnostics that are not actual user/assistant conversation content

## Answer Format

When you use this skill, answer with:

- What you found or did not find.
- Which engine storage it came from.
- The exact file path and line or record position when available.
- Whether the evidence came from session history, long-term memory, Feishu archive, or logs.
- Any uncertainty, especially if Feishu history, session JSONL, and injected context disagree.

## Safety

This skill is read-only. Do not write, delete, migrate, compact, or edit session or memory files while using it. If migration is required, use the official Hermes migration path separately and run a dry run first.
