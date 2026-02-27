import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type ToolEvent = {
  phase: "start" | "end";
  tool: string;
};

const REQUIRED_TOOLS = [
  "feishu_tasklist_create",
  "feishu_tasklist_get",
  "feishu_tasklist_list",
  "feishu_tasklist_update",
  "feishu_tasklist_add_members",
  "feishu_tasklist_remove_members",
  "feishu_tasklist_delete",
  "feishu_task_create",
  "feishu_task_get",
  "feishu_task_update",
  "feishu_task_delete",
  "feishu_task_subtask_create",
  "feishu_task_add_tasklist",
  "feishu_task_remove_tasklist",
] as const;

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k?.startsWith("--") || !v || v.startsWith("--")) {
      throw new Error(
        "Usage: bun extensions/feishu-her/src/tools/task-acceptance-log-check.ts --log <path> --run-id <runId>",
      );
    }
    args.set(k, v);
  }

  const logPath = args.get("--log");
  const runId = args.get("--run-id");
  if (!logPath || !runId) {
    throw new Error("Missing required arguments. Usage: --log <path> --run-id <runId>");
  }
  return { logPath: resolve(logPath), runId };
}

function pickField(line: string, key: string): string | undefined {
  const marker = `${key}=`;
  const start = line.indexOf(marker);
  if (start < 0) return undefined;
  const from = start + marker.length;
  const rest = line.slice(from);
  const end = rest.indexOf(" ");
  return end < 0 ? rest : rest.slice(0, end);
}

function collectEvents(logText: string, runId: string) {
  const lines = logText.split("\n");
  const events: ToolEvent[] = [];
  let failLines = 0;
  for (const line of lines) {
    if (!line.includes(runId)) continue;

    if (line.includes("embedded run tool start:")) {
      const tool = pickField(line, "tool");
      if (tool) events.push({ phase: "start", tool });
    }
    if (line.includes("embedded run tool end:")) {
      const tool = pickField(line, "tool");
      if (tool) events.push({ phase: "end", tool });
    }
    if (
      line.includes("embedded run tool error") ||
      line.includes("tool failed") ||
      line.includes("UNAVAILABLE")
    ) {
      failLines += 1;
    }
  }
  return { events, failLines };
}

function summarize(events: ToolEvent[]) {
  const startCount = new Map<string, number>();
  const endCount = new Map<string, number>();
  for (const e of events) {
    const target = e.phase === "start" ? startCount : endCount;
    target.set(e.tool, (target.get(e.tool) ?? 0) + 1);
  }

  const missingRequired = REQUIRED_TOOLS.filter(
    (tool) => (startCount.get(tool) ?? 0) === 0 || (endCount.get(tool) ?? 0) === 0,
  );

  const unclosed = [...startCount.entries()]
    .filter(([tool, cnt]) => cnt !== (endCount.get(tool) ?? 0))
    .map(([tool]) => tool);

  return { startCount, endCount, missingRequired, unclosed };
}

function main() {
  const { logPath, runId } = parseArgs();
  const text = readFileSync(logPath, "utf8");
  const { events, failLines } = collectEvents(text, runId);
  const { startCount, endCount, missingRequired, unclosed } = summarize(events);

  const pass =
    events.length > 0 && failLines === 0 && missingRequired.length === 0 && unclosed.length === 0;

  const result = {
    pass,
    runId,
    logPath,
    totals: {
      events: events.length,
      toolsStarted: startCount.size,
      toolsEnded: endCount.size,
      failLines,
    },
    missingRequired,
    unclosed,
  };

  // Deterministic machine-readable output for review/auditing.
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(pass ? 0 : 1);
}

main();
