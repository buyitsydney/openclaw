import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type GroupModeInfo = { mode: string; context?: string };

export function resolveGroupModesDir(): string {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    join(homedir(), ".openclaw");
  return join(stateDir, "workspace", "group-modes");
}

/**
 * Read per-group mode from {workspace}/group-modes/{chatId}.json.
 * Returns the normalized mode string ("owner-at", "group-at", "discussion")
 * or "owner-at" if the file doesn't exist or is invalid.
 * Legacy names (default, auto-reply, owner, at-reply, monitor, manager, group) are auto-mapped.
 */
export function readGroupMode(chatId: string): GroupModeInfo {
  const dir = resolveGroupModesDir();
  let filePath = join(dir, `${chatId}.json`);
  if (!existsSync(filePath)) {
    filePath = join(dir, `feishu:${chatId}.json`);
    if (!existsSync(filePath)) {
      return { mode: "owner-at" };
    }
  }
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    const mode = typeof data?.mode === "string" && data.mode.trim() ? data.mode.trim() : "owner-at";
    // Legacy "owner" mode removed — fall back to owner-at (safe default).
    const aliasMap: Record<string, string> = {
      default: "owner-at",
      "auto-reply": "owner-at",
      owner: "owner-at",
      "at-reply": "group-at",
      monitor: "group-at",
      manager: "group-at",
      group: "group-at",
    };
    const normalizedMode = aliasMap[mode] ?? mode;
    const context = typeof data?.context === "string" ? data.context.trim() : undefined;
    return { mode: normalizedMode, context };
  } catch {
    return { mode: "owner-at" };
  }
}

/**
 * Update only the `context` field in an existing group-modes JSON file.
 * No-op if the file doesn't exist (mode was never set for this group).
 */
export function updateGroupModeContext(chatId: string, context: string): boolean {
  const dir = resolveGroupModesDir();
  let filePath = join(dir, `${chatId}.json`);
  if (!existsSync(filePath)) {
    filePath = join(dir, `feishu:${chatId}.json`);
    if (!existsSync(filePath)) return false;
  }
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    data.context = context;
    data.set_at = new Date().toISOString();
    writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}
