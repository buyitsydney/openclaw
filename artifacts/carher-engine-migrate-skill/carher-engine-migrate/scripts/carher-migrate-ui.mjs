#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrateScript = process.env.CARHER_MIGRATE_SCRIPT || resolve(__dirname, "carher-migrate.sh");
const sleepMs = Number(process.env.CARHER_MIGRATE_UI_SLEEP_MS || "400");

function usage() {
  console.log(`Usage:
  carher-migrate-ui.mjs render --phase <name> --percent <0-100> [--status running|success|failed]
  carher-migrate-ui.mjs send --chat-id <oc_xxx> --phase <name> --percent <0-100>
  carher-migrate-ui.mjs patch --message-id <om_xxx> --phase <name> --percent <0-100>
  carher-migrate-ui.mjs run --chat-id <oc_xxx> --confirm [--overwrite]

The run command edits one Feishu card from start to finish.
`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === "confirm" || key === "overwrite" || key === "json") {
      out[key] = true;
      continue;
    }
    out[key] = argv[i + 1] || "";
    i += 1;
  }
  return out;
}

function delay(ms) {
  if (!ms) {
    return Promise.resolve();
  }
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function progressBar(percent) {
  const safe = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((safe / 100) * 16);
  return `${"█".repeat(filled)}${"░".repeat(16 - filled)}`;
}

function templateFor(status) {
  if (status === "success") {
    return "green";
  }
  if (status === "failed") {
    return "red";
  }
  return "yellow";
}

function titleFor(status, phase) {
  if (status === "success") {
    return "✅ ☤ Hermes 记忆迁移完成";
  }
  if (status === "failed") {
    return "❌ ☤ Hermes 记忆迁移未完成";
  }
  return `☤ Hermes 记忆迁移中 · ${phase}`;
}

function cleanLine(value, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function buildCard({ phase, percent, status = "running", lines = [], details = [] }) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  const body = [
    `${progressBar(safePercent)}  ${safePercent}%`,
    "",
    ...lines.filter(Boolean).map((line) => `• ${cleanLine(line)}`),
  ];
  const cleanDetails = details.filter(Boolean).map((line) => cleanLine(line, 220));
  if (cleanDetails.length) {
    body.push("", "---", ...cleanDetails.map((line) => `• ${line}`));
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: "plain_text", content: titleFor(status, phase || "准备") },
      template: templateFor(status),
    },
    elements: [{ tag: "markdown", content: body.join("\n") }],
  };
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function larkCliEnv() {
  const env = { ...process.env };
  const hermesHome = env.HERMES_HOME || env.HERMES_DATA_DIR || "/opt/data";
  const hermesConfig = resolve(hermesHome, ".lark-cli/hermes/config.json");
  if (existsSync(hermesConfig)) {
    env.HOME = hermesHome;
    env.HERMES_HOME = hermesHome;
    env.HERMES_DATA_DIR = hermesHome;
  }
  return env;
}

function runLarkCli(args) {
  return runChecked("lark-cli", args, { env: larkCliEnv() });
}

function findMessageId(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  if (typeof value.message_id === "string") {
    return value.message_id;
  }
  if (value.data && typeof value.data === "object") {
    const nested = findMessageId(value.data);
    if (nested) {
      return nested;
    }
  }
  for (const item of Object.values(value)) {
    const nested = findMessageId(item);
    if (nested) {
      return nested;
    }
  }
  return "";
}

function sendCard(chatId, card) {
  const result = runLarkCli([
    "im",
    "+messages-send",
    "--as",
    "bot",
    "--chat-id",
    chatId,
    "--msg-type",
    "interactive",
    "--content",
    JSON.stringify(card),
  ]);
  if (result.status !== 0) {
    throw new Error(`lark-cli send failed: ${result.stderr || result.stdout}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch {
    throw new Error(`lark-cli send returned non-JSON: ${result.stdout}`);
  }
  const messageId = findMessageId(parsed);
  if (!messageId) {
    throw new Error(`lark-cli send returned no message_id: ${result.stdout}`);
  }
  return messageId;
}

function patchCard(messageId, card) {
  const result = runLarkCli([
    "api",
    "PATCH",
    `/open-apis/im/v1/messages/${messageId}`,
    "--as",
    "bot",
    "--data",
    JSON.stringify({ content: JSON.stringify(card) }),
    "--format",
    "json",
  ]);
  if (result.status !== 0) {
    throw new Error(`lark-cli patch failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function runMigrate(args) {
  return runChecked("bash", [migrateScript, ...args]);
}

function parseKeyValues(text) {
  const map = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      map.set(line.slice(0, idx), line.slice(idx + 1));
    }
  }
  return map;
}

function summarizeReview(reviewText) {
  const kv = parseKeyValues(reviewText);
  const lines = [];
  const details = [];
  const soulMatch =
    kv.get("SOUL.source_sha256") &&
    kv.get("SOUL.source_sha256") === kv.get("SOUL.dest_sha256");
  lines.push(`SOUL.md: ${soulMatch ? "sha 匹配" : "sha 未匹配或缺失"}`);
  lines.push(
    `USER.md: ${kv.get("review.memory.USER.md.dest_exists") || kv.get("USER.dest_exists") || "unknown"}`,
  );
  lines.push(
    `MEMORY.md: ${kv.get("review.memory.MEMORY.md.dest_exists") || kv.get("MEMORY.dest_exists") || "unknown"}`,
  );
  lines.push(
    `迁移统计: migrated=${kv.get("review.summary.migrated") || "0"}, conflict=${kv.get("review.summary.conflict") || "0"}, skipped=${kv.get("review.summary.skipped") || "0"}, archived=${kv.get("review.summary.archived") || "0"}`,
  );
  lines.push(
    `skills: imported=${kv.get("review.skills.imported_openclaw_imports_count") || "0"}, missing=${kv.get("review.skills.missing_shared_count") || "0"}`,
  );
  lines.push(`cron: archived=${kv.get("review.cron.archived_active_count") || "0"}，未自动启用`);
  lines.push("secrets: 默认未迁移");

  for (const [key, value] of kv) {
    if (/^review\.cron\.option\.\d+\.name$/.test(key)) {
      details.push(`cron archived: ${value}`);
    }
  }
  const reportDir = kv.get("review.report_dir");
  if (reportDir) {
    details.push(`report: ${reportDir}`);
  }
  details.push("下一步: 如需启用归档 cron，请回复 cron 1、cron 1,3 或 cron all。");
  return { lines, details };
}

function failureDetails(resultOrError) {
  if (resultOrError instanceof Error) {
    return [resultOrError.message];
  }
  const chunks = [resultOrError.stderr, resultOrError.stdout].filter(Boolean).join("\n");
  return chunks
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6);
}

async function patchFrame(messageId, frame) {
  patchCard(messageId, buildCard(frame));
  await delay(sleepMs);
}

async function runUi(options) {
  if (!options["chat-id"]) {
    throw new Error("--chat-id is required");
  }
  if (!options.confirm) {
    throw new Error("--confirm is required after owner approval");
  }

  let messageId = "";
  try {
    messageId = sendCard(
      options["chat-id"],
      buildCard({
        phase: "开始",
        percent: 0,
        lines: ["写入迁移任务", "准备扫描 OpenClaw 与 Hermes 记忆目录"],
      }),
    );
    await delay(sleepMs);

    const status = runMigrate(["status"]);
    if (status.status !== 0) {
      await patchFrame(messageId, {
        phase: "失败",
        percent: 20,
        status: "failed",
        lines: ["status 失败"],
        details: failureDetails(status),
      });
      process.exit(status.status || 1);
    }
    await patchFrame(messageId, {
      phase: "扫描",
      percent: 20,
      lines: ["已读取 source/destination 快照", "准备运行官方 Hermes dry-run plan"],
    });

    const plan = runMigrate(["plan"]);
    if (plan.status !== 0) {
      await patchFrame(messageId, {
        phase: "失败",
        percent: 40,
        status: "failed",
        lines: ["plan 失败，未修改文件"],
        details: failureDetails(plan),
      });
      process.exit(plan.status || 1);
    }
    await patchFrame(messageId, {
      phase: "规划",
      percent: 40,
      lines: ["官方 dry-run plan 完成", "准备执行已确认的迁移"],
    });

    const applyArgs = ["apply", "--confirm"];
    if (options.overwrite) {
      applyArgs.push("--overwrite");
    }
    const applied = runMigrate(applyArgs);
    if (applied.status !== 0) {
      await patchFrame(messageId, {
        phase: "失败",
        percent: 60,
        status: "failed",
        lines: ["apply 被拒绝或失败，未接受为成功迁移"],
        details: failureDetails(applied),
      });
      process.exit(applied.status || 1);
    }
    await patchFrame(messageId, {
      phase: "迁移",
      percent: 60,
      lines: ["官方迁移命令完成", "开始 verify/review"],
    });

    const verify = runMigrate(["verify"]);
    const review = runMigrate(["review"]);
    if (verify.status !== 0 || review.status !== 0) {
      await patchFrame(messageId, {
        phase: "失败",
        percent: 80,
        status: "failed",
        lines: ["verify/review 失败"],
        details: failureDetails(verify.status !== 0 ? verify : review),
      });
      process.exit(verify.status || review.status || 1);
    }
    await patchFrame(messageId, {
      phase: "校验",
      percent: 80,
      lines: ["verify 完成", "review 完成，正在生成结果摘要"],
    });

    const summary = summarizeReview(`${verify.stdout}\n${review.stdout}`);
    await patchFrame(messageId, {
      phase: "完成",
      percent: 100,
      status: "success",
      lines: summary.lines,
      details: summary.details,
    });
    console.log(`message_id=${messageId}`);
  } catch (error) {
    if (messageId) {
      patchCard(
        messageId,
        buildCard({
          phase: "失败",
          percent: 100,
          status: "failed",
          lines: ["迁移 UI runner 异常"],
          details: failureDetails(error),
        }),
      );
    }
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0] || "";
  if (command === "render") {
    console.log(
      JSON.stringify(
        buildCard({
          phase: options.phase || "预览",
          percent: options.percent || 0,
          status: options.status || "running",
          lines: options.line ? [options.line] : ["预览迁移卡片"],
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "send") {
    if (!options["chat-id"]) {
      throw new Error("--chat-id is required");
    }
    const messageId = sendCard(
      options["chat-id"],
      buildCard({
        phase: options.phase || "开始",
        percent: options.percent || 0,
        status: options.status || "running",
        lines: options.line ? [options.line] : ["迁移卡片已创建"],
      }),
    );
    console.log(`message_id=${messageId}`);
    return;
  }
  if (command === "patch") {
    if (!options["message-id"]) {
      throw new Error("--message-id is required");
    }
    patchCard(
      options["message-id"],
      buildCard({
        phase: options.phase || "更新",
        percent: options.percent || 0,
        status: options.status || "running",
        lines: options.line ? [options.line] : ["迁移卡片已更新"],
      }),
    );
    console.log(`message_id=${options["message-id"]}`);
    return;
  }
  if (command === "run") {
    await runUi(options);
    return;
  }
  usage();
  process.exit(command ? 2 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
