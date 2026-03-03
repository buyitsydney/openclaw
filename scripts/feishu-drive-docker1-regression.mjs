/**
 * Real E2E regression for Drive/Docx APIs on local docker1 container.
 *
 * Usage (inside carher-1):
 *   FEISHU_DRIVE_TEST_FOLDER_TOKEN=<token> node scripts/feishu-drive-docker1-regression.mjs
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import * as Lark from "@larksuiteoapi/node-sdk";

const FEISHU_OPEN_API_BASE = "https://open.feishu.cn/open-apis";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function optionalPositiveIntEnv(name, defaultValue) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function getConfigPath() {
  const customPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
  return customPath || "/data/.openclaw/openclaw.json";
}

async function loadConfig(configPath) {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = await readFile(configPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Config parse failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Config root must be an object`);
  }
  return parsed;
}

function getRequiredString(value, field) {
  if (typeof value !== "string") {
    throw new Error(`${field} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  return trimmed;
}

function getFeishuCredentials(config) {
  const channels = config.channels;
  if (!channels || typeof channels !== "object") {
    throw new Error(`channels is missing in config`);
  }
  const feishu = channels.feishu;
  if (!feishu || typeof feishu !== "object") {
    throw new Error(`channels.feishu is missing in config`);
  }
  const appId = getRequiredString(feishu.appId, "channels.feishu.appId");
  const appSecret = getRequiredString(feishu.appSecret, "channels.feishu.appSecret");
  return { appId, appSecret };
}

function createClient(config) {
  const { appId, appSecret } = getFeishuCredentials(config);
  return new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
  });
}

async function getTenantAccessToken(client) {
  const token = await client.tokenManager?.getTenantAccessToken({});
  if (!token) {
    throw new Error(`failed_to_get_tenant_access_token`);
  }
  return token;
}

async function callOpenApiJson(token, endpoint, body) {
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const response = await fetch(`${FEISHU_OPEN_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`non_json_response from ${endpoint}: ${raw.slice(0, 400)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`invalid_json_response from ${endpoint}`);
  }
  return parsed;
}

function expectSuccess(label, response) {
  const code = typeof response.code === "number" ? response.code : -1;
  const msg = typeof response.msg === "string" ? response.msg : "";
  if (code !== 0) {
    throw new Error(`${label} failed: code=${code} msg=${msg}`);
  }
  if (!response.data || typeof response.data !== "object") {
    throw new Error(`${label} missing data`);
  }
  return response.data;
}

async function resolveShareUrl(token, docToken, docType) {
  const metaData = expectSuccess(
    `resolve_share_url(${docType})`,
    await callOpenApiJson(token, "/drive/v1/metas/batch_query", {
      request_docs: [{ doc_token: docToken, doc_type: docType }],
      with_url: true,
    }),
  );
  const first = Array.isArray(metaData.metas) ? metaData.metas[0] : undefined;
  const url = first && typeof first.url === "string" ? first.url.trim() : "";
  if (!url) {
    throw new Error(`resolve_share_url(${docType}) missing url for token=${docToken}`);
  }
  return url;
}

async function createOnlineDocx(client, tenantToken, folderToken, title) {
  const response = await client.docx.document.create({
    data: { title, folder_token: folderToken },
  });
  if (response.code !== 0) {
    throw new Error(`create_online_docx failed: code=${response.code} msg=${response.msg}`);
  }
  const documentId =
    typeof response.data?.document?.document_id === "string"
      ? response.data.document.document_id.trim()
      : "";
  if (!documentId) {
    throw new Error(`create_online_docx failed: missing document_id`);
  }
  const url = await resolveShareUrl(tenantToken, documentId, "docx");
  return {
    online_type: "docx",
    token: documentId,
    url,
    revision: response.data?.document?.revision_id,
  };
}

async function createOnlineDrive(token, folderToken, title, onlineType) {
  const data = expectSuccess(
    `create_online_${onlineType}`,
    await callOpenApiJson(token, `/drive/explorer/v2/file/${folderToken}`, {
      title,
      type: onlineType,
    }),
  );
  return {
    online_type: onlineType,
    token: data.token,
    url: data.url,
    revision: data.revision,
  };
}

async function uploadPart(token, uploadId, seq, chunk) {
  const form = new FormData();
  form.append("upload_id", uploadId);
  form.append("seq", String(seq));
  form.append("size", String(chunk.length));
  form.append("file", new Blob([chunk]), `part-${seq}`);

  const response = await fetch(`${FEISHU_OPEN_API_BASE}/drive/v1/files/upload_part`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });
  const raw = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`upload_part non_json_response seq=${seq}`);
  }
  const code = typeof parsed.code === "number" ? parsed.code : -1;
  const msg = typeof parsed.msg === "string" ? parsed.msg : "";
  if (code !== 0) {
    throw new Error(`upload_part failed: seq=${seq} code=${code} msg=${msg}`);
  }
}

async function uploadLargeFile(token, folderToken, filePath, fileName) {
  const stat = await open(filePath, "r");
  let size = 0;
  try {
    const meta = await stat.stat();
    size = meta.size;
  } finally {
    await stat.close();
  }
  if (size <= 0) {
    throw new Error(`upload file is empty: ${filePath}`);
  }

  const prepareData = expectSuccess(
    "upload_prepare",
    await callOpenApiJson(token, "/drive/v1/files/upload_prepare", {
      file_name: fileName,
      parent_type: "explorer",
      parent_node: folderToken,
      size,
    }),
  );
  const uploadId = getRequiredString(prepareData.upload_id, "upload_prepare.upload_id");
  const blockSize =
    typeof prepareData.block_size === "number" && prepareData.block_size > 0
      ? prepareData.block_size
      : 0;
  const blockNum =
    typeof prepareData.block_num === "number" && prepareData.block_num > 0
      ? prepareData.block_num
      : 0;
  if (!Number.isInteger(blockSize) || !Number.isInteger(blockNum)) {
    throw new Error(`upload_prepare invalid block_size/block_num`);
  }

  const file = await open(filePath, "r");
  let uploadedBytes = 0;
  try {
    for (let seq = 0; seq < blockNum; seq++) {
      const expected = Math.min(blockSize, size - uploadedBytes);
      if (expected <= 0) {
        throw new Error(`upload chunk size mismatch at seq=${seq}`);
      }
      const chunk = Buffer.alloc(expected);
      const { bytesRead } = await file.read(chunk, 0, expected, uploadedBytes);
      if (bytesRead !== expected) {
        throw new Error(
          `upload chunk read mismatch seq=${seq} expected=${expected} actual=${bytesRead}`,
        );
      }
      uploadedBytes += bytesRead;
      await uploadPart(token, uploadId, seq, chunk);
    }
  } finally {
    await file.close();
  }

  if (uploadedBytes !== size) {
    throw new Error(`upload bytes mismatch expected=${size} actual=${uploadedBytes}`);
  }

  const finishData = expectSuccess(
    "upload_finish",
    await callOpenApiJson(token, "/drive/v1/files/upload_finish", {
      upload_id: uploadId,
      block_num: blockNum,
    }),
  );
  const fileToken = getRequiredString(finishData.file_token, "upload_finish.file_token");

  const metaData = expectSuccess(
    "drive_meta_batch_query",
    await callOpenApiJson(token, "/drive/v1/metas/batch_query", {
      request_docs: [{ doc_token: fileToken, doc_type: "file" }],
      with_url: true,
    }),
  );
  const firstMeta = Array.isArray(metaData.metas) ? metaData.metas[0] : undefined;
  const shareUrl =
    firstMeta && typeof firstMeta.url === "string" && firstMeta.url.trim()
      ? firstMeta.url.trim()
      : "";
  if (!shareUrl) {
    throw new Error(`drive_meta_batch_query missing share url`);
  }

  return {
    file_token: fileToken,
    share_url: shareUrl,
    upload_id: uploadId,
    block_size: blockSize,
    block_num: blockNum,
    file_size: size,
  };
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timeout after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function createZeroFile(path, bytes) {
  const chunkSize = 4 * 1024 * 1024;
  const chunk = Buffer.alloc(chunkSize, 0);
  const file = await open(path, "w");
  let written = 0;
  try {
    while (written < bytes) {
      const size = Math.min(chunkSize, bytes - written);
      await file.write(chunk, 0, size, written);
      written += size;
    }
  } finally {
    await file.close();
  }
  if (written !== bytes) {
    throw new Error(`file size mismatch: expected=${bytes} actual=${written}`);
  }
}

async function runStep(name, fn) {
  const started = performance.now();
  const result = await fn();
  const ended = performance.now();
  return {
    name,
    duration_ms: Math.round(ended - started),
    result,
  };
}

async function main() {
  const folderToken = requiredEnv("FEISHU_DRIVE_TEST_FOLDER_TOKEN");
  const uploadMb = optionalPositiveIntEnv("FEISHU_DRIVE_UPLOAD_MB", 200);
  const uploadTimeoutMs = optionalPositiveIntEnv("FEISHU_DRIVE_UPLOAD_TIMEOUT_MS", 30 * 60 * 1000);
  const uploadPath =
    process.env.FEISHU_DRIVE_UPLOAD_PATH?.trim() ||
    `/tmp/feishu-drive-regression-${uploadMb}mb.bin`;

  const configPath = getConfigPath();
  const config = await loadConfig(configPath);
  const client = createClient(config);
  const tenantToken = await getTenantAccessToken(client);

  const runId = new Date().toISOString().replaceAll(":", "-");
  const titleSuffix = runId.replaceAll(".", "_");

  const steps = [];

  steps.push(
    await runStep("create_online_docx", async () =>
      createOnlineDocx(client, tenantToken, folderToken, `回归-Drive-Docx-${titleSuffix}`),
    ),
  );

  steps.push(
    await runStep("create_online_sheet", async () =>
      createOnlineDrive(tenantToken, folderToken, `回归-Drive-Sheet-${titleSuffix}`, "sheet"),
    ),
  );

  steps.push(
    await runStep("create_online_bitable", async () =>
      createOnlineDrive(tenantToken, folderToken, `回归-Drive-Bitable-${titleSuffix}`, "bitable"),
    ),
  );

  const uploadBytes = uploadMb * 1024 * 1024;
  steps.push(
    await runStep("prepare_upload_file", async () => {
      await createZeroFile(uploadPath, uploadBytes);
      return {
        upload_path: uploadPath,
        upload_bytes: uploadBytes,
      };
    }),
  );

  steps.push(
    await runStep("upload_file", async () =>
      withTimeout(
        uploadLargeFile(
          tenantToken,
          folderToken,
          uploadPath,
          `regression-${uploadMb}mb-${titleSuffix}.bin`,
        ),
        uploadTimeoutMs,
        "upload_file",
      ),
    ),
  );

  const totalDurationMs = steps.reduce((acc, step) => acc + step.duration_ms, 0);
  const report = {
    ok: true,
    run_id: runId,
    hostname: hostname(),
    config_path: configPath,
    folder_token: folderToken,
    upload_mb: uploadMb,
    upload_timeout_ms: uploadTimeoutMs,
    steps,
    total_duration_ms: totalDurationMs,
  };

  const reportDir = "/tmp/feishu-drive-regression-reports";
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `report-${runId}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`report_path=${reportPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[feishu-drive-regression] FAILED: ${message}`);
  process.exit(1);
});
