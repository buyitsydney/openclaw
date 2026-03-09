/**
 * Deterministic verifier for Feishu Drive raw-file reading.
 *
 * Uses the local Her user OAuth token to:
 * 1. Search Feishu Drive for a target file
 * 2. Download it through the official Drive download API
 * 3. Verify MIME/header/size
 * 4. Extract PDF text and assert required substrings exist
 *
 * Usage:
 *   node scripts/verify-feishu-drive-file-read.mjs
 *   node scripts/verify-feishu-drive-file-read.mjs --query="任职资格管理办法" --expect="任职资格管理办法"
 */

import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const FEISHU_OPEN_API_BASE = "https://open.feishu.cn/open-apis";
const DEFAULT_QUERY = "任职资格管理办法";
const DEFAULT_EXPECT = ["任职资格管理办法", "CL-31-07"];

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    query: DEFAULT_QUERY,
    expect: [...DEFAULT_EXPECT],
    limit: 10,
    maxPages: 3,
    outDir: "/tmp/openclaw/feishu-drive-verify",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--query=")) {
      options.query = arg.slice("--query=".length).trim();
      continue;
    }
    if (arg === "--query") {
      options.query = String(argv[++i] ?? "").trim();
      continue;
    }
    if (arg.startsWith("--expect=")) {
      options.expect = [arg.slice("--expect=".length).trim()];
      continue;
    }
    if (arg === "--expect") {
      options.expect = [String(argv[++i] ?? "").trim()];
      continue;
    }
    if (arg.startsWith("--expect-many=")) {
      options.expect = arg
        .slice("--expect-many=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if (arg.startsWith("--limit=")) {
      options.limit = Number.parseInt(arg.slice("--limit=".length), 10);
      continue;
    }
    if (arg.startsWith("--max-pages=")) {
      options.maxPages = Number.parseInt(arg.slice("--max-pages=".length), 10);
      continue;
    }
    if (arg.startsWith("--out-dir=")) {
      options.outDir = arg.slice("--out-dir=".length).trim();
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }

  if (!options.query) {
    fail("--query is required");
  }
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    fail("--limit must be a positive integer");
  }
  if (!Number.isInteger(options.maxPages) || options.maxPages <= 0) {
    fail("--max-pages must be a positive integer");
  }
  if (!options.outDir) {
    fail("--out-dir is required");
  }
  if (options.expect.length === 0 || options.expect.some((value) => !value)) {
    fail("--expect/--expect-many must contain non-empty strings");
  }

  return options;
}

function loadSingleUserToken() {
  const tokenDir = path.join(os.homedir(), ".openclaw", "feishu-user-tokens");
  if (!fs.existsSync(tokenDir)) {
    fail(`Feishu token directory not found: ${tokenDir}`);
  }
  const tokenFiles = fs
    .readdirSync(tokenDir)
    .filter((name) => name.endsWith(".json"))
    .toSorted();
  if (tokenFiles.length !== 1) {
    fail(`Expected exactly 1 user token file, found ${tokenFiles.length}`);
  }
  const tokenPath = path.join(tokenDir, tokenFiles[0]);
  const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  if (typeof token.access_token !== "string" || !token.access_token.trim()) {
    fail(`access_token missing in ${tokenPath}`);
  }
  return {
    tokenPath,
    openId: token.open_id,
    name: token.name,
    accessToken: token.access_token.trim(),
  };
}

async function callFeishuUserJson({ method, endpoint, userToken, body }) {
  const url = `${FEISHU_OPEN_API_BASE}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${userToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`Non-JSON response from ${endpoint}: ${raw.slice(0, 300)}`);
  }
  return parsed;
}

function ensureSuccess(label, payload) {
  const code = typeof payload?.code === "number" ? payload.code : -1;
  const msg = typeof payload?.msg === "string" ? payload.msg : "";
  if (code !== 0) {
    fail(`${label} failed: code=${code} msg=${msg}`);
  }
  return payload.data;
}

async function searchDriveFile({ userToken, query, limit }) {
  const data = ensureSuccess(
    "drive_search",
    await callFeishuUserJson({
      method: "POST",
      endpoint: "/suite/docs-api/search/object",
      userToken,
      body: {
        search_key: query,
        count: limit,
        offset: 0,
        owner_ids: [],
        docs_types: ["file"],
      },
    }),
  );

  const docs = Array.isArray(data?.docs_entities) ? data.docs_entities : [];
  const normalized = docs
    .filter(
      (item) =>
        item &&
        typeof item.docs_token === "string" &&
        typeof item.title === "string" &&
        typeof item.docs_type === "string",
    )
    .map((item) => ({
      token: item.docs_token.trim(),
      title: item.title.trim(),
      type: item.docs_type.trim(),
      ownerId: typeof item.owner_id === "string" ? item.owner_id.trim() : "",
    }));

  const matches = normalized.filter((item) => item.type === "file" && item.title.includes(query));
  if (matches.length !== 1) {
    fail(
      `Expected exactly 1 file match for "${query}", found ${matches.length}. Matches: ${JSON.stringify(matches, null, 2)}`,
    );
  }
  return matches[0];
}

async function downloadDriveFile({ userToken, fileToken }) {
  const url = `${FEISHU_OPEN_API_BASE}/drive/v1/files/${fileToken}/download`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${userToken}`,
    },
  });
  if (!response.ok) {
    fail(`drive_file_download failed: HTTP ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    fail("drive_file_download returned empty body");
  }
  return { contentType, buffer };
}

function verifyPdfEnvelope({ contentType, buffer }) {
  if (!contentType.toLowerCase().startsWith("application/pdf")) {
    fail(`Unexpected content-type: ${contentType}`);
  }
  const header = buffer.subarray(0, 5).toString("utf8");
  if (header !== "%PDF-") {
    fail(`Unexpected PDF header: ${JSON.stringify(header)}`);
  }
}

async function extractPdfText({ buffer, maxPages }) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true })
    .promise;
  const textParts = [];
  const pageCount = Math.min(pdf.numPages, maxPages);
  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? String(item.str) : ""))
      .filter(Boolean)
      .join(" ");
    textParts.push(pageText);
  }
  const text = textParts.join("\n\n").trim();
  if (!text) {
    fail("PDF text extraction returned empty text");
  }
  return { pageCount: pdf.numPages, text };
}

function verifyExpectedText(text, expectedList) {
  const missing = expectedList.filter((needle) => !text.includes(needle));
  if (missing.length > 0) {
    fail(`Extracted PDF text missing expected substrings: ${missing.join(", ")}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const user = loadSingleUserToken();
  const match = await searchDriveFile({
    userToken: user.accessToken,
    query: options.query,
    limit: options.limit,
  });
  const { contentType, buffer } = await downloadDriveFile({
    userToken: user.accessToken,
    fileToken: match.token,
  });
  verifyPdfEnvelope({ contentType, buffer });
  const { pageCount, text } = await extractPdfText({
    buffer,
    maxPages: options.maxPages,
  });
  verifyExpectedText(text, options.expect);

  await mkdir(options.outDir, { recursive: true });
  const outputPath = path.join(
    options.outDir,
    `${match.token}-${match.title.replace(/[^a-zA-Z0-9._-]+/g, "_")}.pdf`,
  );
  await writeFile(outputPath, buffer);

  const summary = {
    ok: true,
    query: options.query,
    tokenPath: user.tokenPath,
    user: {
      openId: user.openId,
      name: user.name,
    },
    file: {
      token: match.token,
      title: match.title,
      type: match.type,
      ownerId: match.ownerId,
      savedTo: outputPath,
      bytes: buffer.length,
      contentType,
      totalPages: pageCount,
    },
    verification: {
      checkedSubstrings: options.expect,
      textSample: text.slice(0, 600),
    },
  };

  console.log(JSON.stringify(summary, null, 2));
}

await main();
