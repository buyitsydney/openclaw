/**
 * A2A session cleanup — delete ephemeral .jsonl files + sessions.json entries.
 *
 * Separated into its own module to avoid jiti transpilation side effects
 * on executor.ts (which caused "sessionKey is not defined" errors when
 * cleanup functions were co-located in the same file).
 *
 * Security: a2a sessions MUST be fully cleaned (both .jsonl AND sessions.json
 * entry) to prevent spoke bots from discovering a2a session keys via
 * sessions_list and bypassing outbound gate via sessions_send.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function resolveSessionsDir(): string {
  const home = process.env.OPENCLAW_STATE_DIR?.trim()
    || process.env.HOME
    || os.homedir();
  return path.join(home, ".openclaw", "agents", "main", "sessions");
}

/** Delete .jsonl file + sessions.json entry for an a2a session. Best-effort, never throws. */
export function cleanupA2aSessionFile(
  sKey: string,
  logger?: { warn: (msg: string) => void },
): void {
  try {
    const sessionsDir = resolveSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    if (!fs.existsSync(storePath)) return;

    const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    const entry = store[sKey];
    if (!entry?.sessionId) return;

    // Delete .jsonl transcript file
    const jsonlPath = path.join(sessionsDir, `${entry.sessionId}.jsonl`);
    if (fs.existsSync(jsonlPath)) {
      fs.unlinkSync(jsonlPath);
    }

    // Remove entry from sessions.json to prevent sessions_list from
    // exposing a2a session keys (security: blocks sessions_send bypass).
    delete store[sKey];
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    logger?.warn(`a2a-gateway: session cleanup failed for ${sKey}: ${String(err).slice(0, 120)}`);
  }
}

/** Startup cleanup: delete all historical a2a session .jsonl files. */
export function cleanupAllA2aSessions(
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): void {
  try {
    const sessionsDir = resolveSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    if (!fs.existsSync(storePath)) return;

    const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    const a2aKeys = Object.keys(store).filter((k) => k.includes(":a2a:"));
    if (a2aKeys.length === 0) return;

    let deleted = 0;
    for (const key of a2aKeys) {
      const entry = store[key];
      if (entry?.sessionId) {
        const jsonlPath = path.join(sessionsDir, `${entry.sessionId}.jsonl`);
        try { fs.unlinkSync(jsonlPath); } catch {}
      }
      delete store[key];
      deleted++;
    }
    // Startup: safe to rewrite sessions.json (no concurrent gateway writes yet).
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
    logger?.info(`a2a-gateway: startup cleanup removed ${deleted} stale a2a sessions (files + index)`);
  } catch (err) {
    logger?.warn(`a2a-gateway: startup session cleanup failed: ${String(err).slice(0, 120)}`);
  }
}
