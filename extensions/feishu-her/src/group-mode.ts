import { existsSync, readFileSync } from "node:fs";
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
 * Returns the normalized mode string ("owner-at", "owner", "group-at", "group", "discussion")
 * or "owner-at" if the file doesn't exist or is invalid.
 * Legacy names (default, auto-reply, at-reply, monitor, manager) are auto-mapped.
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
    const aliasMap: Record<string, string> = {
      default: "owner-at",
      "auto-reply": "owner",
      "at-reply": "group-at",
      monitor: "group",
      manager: "group",
    };
    const normalizedMode = aliasMap[mode] ?? mode;
    const context = typeof data?.context === "string" ? data.context.trim() : undefined;
    return { mode: normalizedMode, context };
  } catch {
    return { mode: "owner-at" };
  }
}
