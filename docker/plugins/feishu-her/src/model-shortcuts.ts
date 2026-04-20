const GPT_SHORTCUT_RE = /^\/gpt(?::|\s+|$)([\s\S]*)$/i;

/**
 * Normalize Feishu-friendly shortcut commands into the canonical OpenClaw
 * model switch directive so chat UX stays stable across runtimes.
 */
export function rewriteModelShortcutCommand(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }

  const match = trimmed.match(GPT_SHORTCUT_RE);
  if (!match) {
    return trimmed;
  }

  const rest = match[1]?.trim();
  return rest ? `/model gpt ${rest}` : "/model gpt";
}
