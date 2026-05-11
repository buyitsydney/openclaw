---
name: carher-peer-sessions
description: Use when the user asks to inspect the other CarHer engine's session history or memory after hot switch, including OpenClaw-from-Hermes, Hermes-from-OpenClaw, peer engine memory, cross-engine sessions, another framework/entity/session, or comparing OpenClaw/Hermes stored memory.
---

# CarHer Peer Sessions

Use this skill when the user asks about memory, session history, or prior messages that may live in the other CarHer engine after a hot switch: OpenClaw from Hermes, Hermes from OpenClaw, or "another framework/entity/session".

## Rule

Never answer cross-engine memory from guesswork. Inspect the peer engine's files with the helper script, then answer with the source path and line evidence.

## Quick Start

1. Locate this skill directory, then run:

   ```bash
   bash scripts/peer-session-search.sh status
   ```

2. Search the inactive peer engine first:

   ```bash
   bash scripts/peer-session-search.sh search peer "keyword or exact phrase"
   ```

3. If the user asks for recent memory rather than a keyword, list latest files:

   ```bash
   bash scripts/peer-session-search.sh recent peer
   ```

4. Read a matched file with line context:

   ```bash
   bash scripts/peer-session-search.sh show /path/from/search 120
   ```

## Engine Names

- `openclaw`: OpenClaw homes, workspace memory, session jsonl, and Feishu group archives.
- `hermes`: Hermes homes, memory files, and session jsonl.
- `peer`: the engine that is not currently active according to `/data/.engine/active`.
- `both`: both OpenClaw and Hermes.

## Useful Commands

```bash
bash scripts/peer-session-search.sh status
bash scripts/peer-session-search.sh memory
bash scripts/peer-session-search.sh recent openclaw
bash scripts/peer-session-search.sh recent hermes
bash scripts/peer-session-search.sh search both "soul.md"
bash scripts/peer-session-search.sh show /data/.openclaw/agents/main/sessions/example.jsonl 40
```

## Answer Format

When you use this skill, answer with:

- What you found.
- Which engine storage it came from.
- The exact file path and line number, when available.
- Any uncertainty, especially if Lark history, session jsonl, and injected context disagree.

## Safety

This skill is read-only. Do not write, delete, migrate, compact, or edit session/memory files from this skill. If migration is required, use the official Hermes migration command path separately and run dry-run first.
