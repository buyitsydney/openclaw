#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrateScript = process.env.CARHER_MIGRATE_SCRIPT || resolve(__dirname, "carher-migrate.sh");
const sleepMs = Number(process.env.CARHER_MIGRATE_UI_SLEEP_MS || "400");
let cachedTenantAccessToken = "";

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

function strictModeRejectsBotIdentity(text) {
  const body = String(text || "");
  return (
    /strict_mode/i.test(body) &&
    /strict mode is ["']?user["']?/i.test(body) &&
    /only user-identity commands are available/i.test(body)
  );
}

function feishuOpenApiBaseUrl() {
  return (process.env.CARHER_FEISHU_OPENAPI_BASE_URL || "https://open.feishu.cn/open-apis").replace(/\/+$/, "");
}

function appendOpenApiMockRequest(request) {
  const logPath = process.env.CARHER_MIGRATE_UI_OPENAPI_MOCK_LOG;
  if (!logPath) {
    return false;
  }
  appendFileSync(logPath, `${JSON.stringify(request)}\n`);
  return true;
}

async function feishuJsonRequest(method, path, body, token = "") {
  const url = `${feishuOpenApiBaseUrl()}${path}`;
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`飞书 OpenAPI 返回了非 JSON 响应: ${text}`);
  }
  if (!response.ok || Number(parsed.code || 0) !== 0) {
    throw new Error(`飞书 OpenAPI ${method} ${path} 失败: ${text || response.statusText}`);
  }
  return parsed;
}

async function tenantAccessToken() {
  if (cachedTenantAccessToken) {
    return cachedTenantAccessToken;
  }
  const appId = process.env.FEISHU_APP_ID || process.env.LARK_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error(
      "飞书 bot 卡片需要 FEISHU_APP_ID/FEISHU_APP_SECRET。当前 lark-cli strict-mode=user，不能使用 --as bot；请给容器注入飞书应用凭证后重试。",
    );
  }
  if (
    appendOpenApiMockRequest({
      method: "POST",
      path: "/auth/v3/tenant_access_token/internal",
      token: "",
      body: { app_id: appId, app_secret: appSecret },
    })
  ) {
    cachedTenantAccessToken = "tenant-token";
    return cachedTenantAccessToken;
  }
  const parsed = await feishuJsonRequest("POST", "/auth/v3/tenant_access_token/internal", {
    app_id: appId,
    app_secret: appSecret,
  });
  if (!parsed.tenant_access_token) {
    throw new Error("飞书 OpenAPI 没有返回 tenant_access_token，无法发送迁移卡片。");
  }
  cachedTenantAccessToken = parsed.tenant_access_token;
  return cachedTenantAccessToken;
}

async function directCreateCard(chatId, card) {
  const token = await tenantAccessToken();
  const path = "/im/v1/messages?receive_id_type=chat_id";
  const body = {
    receive_id: chatId,
    msg_type: "interactive",
    content: JSON.stringify(card),
    uuid: randomUUID(),
  };
  if (appendOpenApiMockRequest({ method: "POST", path, token, body })) {
    return "om_direct_api";
  }
  const parsed = await feishuJsonRequest("POST", path, body, token);
  const messageId = findMessageId(parsed);
  if (!messageId) {
    throw new Error(`飞书 OpenAPI 发卡成功但没有返回 message_id: ${JSON.stringify(parsed)}`);
  }
  return messageId;
}

async function directPatchCard(messageId, card) {
  const token = await tenantAccessToken();
  const path = `/im/v1/messages/${encodeURIComponent(messageId)}`;
  const body = { content: JSON.stringify(card) };
  if (appendOpenApiMockRequest({ method: "PATCH", path, token, body })) {
    return JSON.stringify({ code: 0, msg: "ok" });
  }
  return JSON.stringify(await feishuJsonRequest("PATCH", path, body, token));
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

async function sendCard(chatId, card) {
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
    const output = result.stderr || result.stdout;
    if (strictModeRejectsBotIdentity(output)) {
      return directCreateCard(chatId, card);
    }
    throw new Error(`lark-cli send failed: ${output}`);
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

async function patchCard(messageId, card) {
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
    const output = result.stderr || result.stdout;
    if (strictModeRejectsBotIdentity(output)) {
      return directPatchCard(messageId, card);
    }
    throw new Error(`lark-cli patch failed: ${output}`);
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
    return translateFailureLines([resultOrError.message]);
  }
  const chunks = [resultOrError.stderr, resultOrError.stdout].filter(Boolean).join("\n");
  const lines = chunks
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6);
  return translateFailureLines(lines);
}

function translateFailureLines(lines) {
  const out = [];
  for (const line of lines) {
    let match = line.match(/Summary:\s*(\d+)\s+would migrate,\s*(\d+)\s+conflict\(s\),\s*(\d+)\s+skipped/i);
    if (match) {
      out.push(`计划摘要: 将迁移 ${match[1]} 项，冲突 ${match[2]} 项，跳过 ${match[3]} 项`);
      continue;
    }
    match = line.match(/Plan has\s*(\d+)\s+conflict\(s\)\. Refusing to apply\./i);
    if (match) {
      out.push(`检测到 ${match[1]} 个已有 Hermes 目标，已安全拒绝写入。`);
      continue;
    }
    if (/Each conflict is an item whose target already exists/i.test(line)) {
      out.push("如要替换已有 Hermes 目标，请明确回复「同意覆盖迁移」；迁移报告里会保留备份。");
      continue;
    }
    if (/To execute the migration/i.test(line) || /hermes claw migrate/i.test(line) || /Or re-run with --dry-run/i.test(line)) {
      continue;
    }
    match = line.match(/refuse:\s*active_engine=openclaw/i);
    if (match) {
      out.push("当前还是 OpenClaw。请先切到 Hermes，看到 Hermes 已就位后再回复「迁移记忆」。");
      continue;
    }
    if (/lark-cli send failed/i.test(line)) {
      out.push(`飞书迁移卡片发送失败: ${line.replace(/^lark-cli send failed:\s*/i, "")}`);
      continue;
    }
    if (/lark-cli patch failed/i.test(line)) {
      out.push(`飞书迁移卡片更新失败: ${line.replace(/^lark-cli patch failed:\s*/i, "")}`);
      continue;
    }
    out.push(line);
  }
  return out.length ? out : ["迁移失败，但没有返回更多错误细节。"];
}

async function patchFrame(messageId, frame) {
  await patchCard(messageId, buildCard(frame));
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
    messageId = await sendCard(
      options["chat-id"],
      buildCard({
        phase: "开始",
        percent: 0,
        lines: ["写入迁移任务", "准备扫描 OpenClaw 与 Hermes 记忆目录"],
      }),
    );
    console.log(`carher_migrate_ui_message_id=${messageId}`);
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
      await patchCard(
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
    const messageId = await sendCard(
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
    await patchCard(
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
