// node --test scripts/carher-patches/apply-session-decay.test.mjs
//
// TDD: prove that the upstream extractTimestamp logic does NOT decay
// session-reset paths (the bug), then apply the patch and assert that
// the same path now produces an exponentially decayed score.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APPLY_PATCH_SH = join(__dirname, "apply-session-decay.sh");

// A faithful stub of the relevant section from openclaw's manager-*.js.
// We keep it minimal so tests are fast — only the decay code path matters.
const STUB_HEADER = `"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const fs$1 = fs;

const DEFAULT_TEMPORAL_DECAY_CONFIG = { enabled: false, halfLifeDays: 30 };
const DAY_MS = 1440 * 60 * 1e3;
const DATED_MEMORY_PATH_RE = /(?:^|\\/)memory\\/(\\d{4})-(\\d{2})-(\\d{2})\\.md$/;
function toDecayLambda(halfLifeDays) {
\tif (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 0;
\treturn Math.LN2 / halfLifeDays;
}
function calculateTemporalDecayMultiplier(params) {
\tconst lambda = toDecayLambda(params.halfLifeDays);
\tconst clampedAge = Math.max(0, params.ageInDays);
\tif (lambda <= 0 || !Number.isFinite(clampedAge)) return 1;
\treturn Math.exp(-lambda * clampedAge);
}
function applyTemporalDecayToScore(params) {
\treturn params.score * calculateTemporalDecayMultiplier(params);
}
function parseMemoryDateFromPath(filePath) {
\tconst normalized = filePath.replaceAll("\\\\", "/").replace(/^\\.\\//, "");
\tconst match = DATED_MEMORY_PATH_RE.exec(normalized);
\tif (!match) return null;
\tconst year = Number(match[1]);
\tconst month = Number(match[2]);
\tconst day = Number(match[3]);
\tif (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
\tconst timestamp = Date.UTC(year, month - 1, day);
\tconst parsed = new Date(timestamp);
\tif (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
\treturn parsed;
}
function isEvergreenMemoryPath(filePath) {
\tconst normalized = filePath.replaceAll("\\\\", "/").replace(/^\\.\\//, "");
\tif (normalized === "MEMORY.md") return true;
\tif (!normalized.startsWith("memory/")) return false;
\treturn !DATED_MEMORY_PATH_RE.test(normalized);
}
async function extractTimestamp(params) {
\tconst fromPath = parseMemoryDateFromPath(params.filePath);
\tif (fromPath) return fromPath;
\tif (params.source === "memory" && isEvergreenMemoryPath(params.filePath)) return null;
\tif (!params.workspaceDir) return null;
\tconst absolutePath = path.isAbsolute(params.filePath) ? params.filePath : path.resolve(params.workspaceDir, params.filePath);
\ttry {
\t\tconst stat = await fs$1.stat(absolutePath);
\t\tif (!Number.isFinite(stat.mtimeMs)) return null;
\t\treturn new Date(stat.mtimeMs);
\t} catch {
\t\treturn null;
\t}
}
function ageInDaysFromTimestamp(timestamp, nowMs) {
\treturn Math.max(0, nowMs - timestamp.getTime()) / DAY_MS;
}
async function applyTemporalDecayToHybridResults(params) {
\tconst config = { ...DEFAULT_TEMPORAL_DECAY_CONFIG, ...params.temporalDecay };
\tif (!config.enabled) return [...params.results];
\tconst nowMs = params.nowMs ?? Date.now();
\treturn Promise.all(params.results.map(async (entry) => {
\t\tconst timestamp = await extractTimestamp({
\t\t\tfilePath: entry.path,
\t\t\tsource: entry.source,
\t\t\tworkspaceDir: params.workspaceDir
\t\t});
\t\tif (!timestamp) return entry;
\t\tconst decayedScore = applyTemporalDecayToScore({
\t\t\tscore: entry.score,
\t\t\tageInDays: ageInDaysFromTimestamp(timestamp, nowMs),
\t\t\thalfLifeDays: config.halfLifeDays
\t\t});
\t\treturn { ...entry, score: decayedScore };
\t}));
}
module.exports = { applyTemporalDecayToHybridResults };
`;

function makeStub() {
  const dir = mkdtempSync(join(tmpdir(), "carher-session-decay-"));
  const stub = join(dir, "manager-stub.js");
  writeFileSync(stub, STUB_HEADER);
  return { dir, stub };
}

// -------- TEST 1: Reproduce the bug — no decay for session-reset paths --------

test("BUG: unpatched extractTimestamp leaves session-reset score untouched", async () => {
  const { dir, stub } = makeStub();
  try {
    const mod = await import(stub);
    const NOW = Date.UTC(2026, 1, 10);
    const decayed = await mod.applyTemporalDecayToHybridResults({
      results: [{
        path: "sessions/main/abcd.jsonl.reset.2026-01-11T00-00-00.000Z",
        score: 1,
        source: "sessions",
      }],
      // workspaceDir intentionally missing: the file does not exist on disk;
      // fs.stat would fail; the bug returns the entry unchanged.
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      nowMs: NOW,
    });
    assert.equal(
      decayed[0].score,
      1,
      "before patch: session-reset paths bypass decay because fs.stat fails",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------- TEST 2: After patch, session-reset path decays exponentially --------

test("FIX: patched extractTimestamp parses .reset.<ISO>.Z and applies decay", async () => {
  const { dir, stub } = makeStub();
  try {
    execSync(`bash ${APPLY_PATCH_SH} ${stub}`, { stdio: "pipe" });

    const patched = readFileSync(stub, "utf8");
    assert.ok(
      patched.includes("CARHER_SESSION_DECAY_PATCH_MARKER"),
      "marker must be present after patch",
    );
    assert.ok(
      patched.includes("carherParseSessionResetDateFromPath"),
      "helper function must be inlined",
    );

    // node --check passes (syntax sanity)
    execSync(`node --check ${stub}`, { stdio: "pipe" });

    const mod = await import(`${stub}?t=${Date.now()}`);
    const NOW = Date.UTC(2026, 1, 10);
    const decayed = await mod.applyTemporalDecayToHybridResults({
      results: [{
        path: "sessions/main/abcd.jsonl.reset.2026-01-11T00-00-00.000Z", // 30 days old
        score: 1,
        source: "sessions",
      }],
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      nowMs: NOW,
    });
    // age = 30 days, halfLife = 30 days → multiplier = 0.5
    assert.ok(
      Math.abs(decayed[0].score - 0.5) < 0.01,
      `expected ≈ 0.5, got ${decayed[0].score}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------- TEST 3: Patcher is idempotent --------

test("FIX: applying patch twice does not duplicate the helper block", () => {
  const { dir, stub } = makeStub();
  try {
    execSync(`bash ${APPLY_PATCH_SH} ${stub}`, { stdio: "pipe" });
    const once = readFileSync(stub, "utf8");
    const onceCount = (once.match(/CARHER_SESSION_DECAY_PATCH_MARKER/g) ?? []).length;
    assert.equal(onceCount, 2, "single apply: 2 markers (start + end)");

    execSync(`bash ${APPLY_PATCH_SH} ${stub}`, { stdio: "pipe" });
    const twice = readFileSync(stub, "utf8");
    const twiceCount = (twice.match(/CARHER_SESSION_DECAY_PATCH_MARKER/g) ?? []).length;
    assert.equal(twiceCount, 2, "double apply: still 2 markers (idempotent)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------- TEST 4: Patched code preserves existing memory/YYYY-MM-DD.md decay --------

test("FIX: existing dated-memory decay path still works after patch", async () => {
  const { dir, stub } = makeStub();
  try {
    execSync(`bash ${APPLY_PATCH_SH} ${stub}`, { stdio: "pipe" });

    const mod = await import(`${stub}?t=${Date.now()}`);
    const NOW = Date.UTC(2026, 1, 10);
    const decayed = await mod.applyTemporalDecayToHybridResults({
      results: [{
        path: "memory/2026-01-11.md", // 30 days old
        score: 1,
        source: "memory",
      }],
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      nowMs: NOW,
    });
    assert.ok(
      Math.abs(decayed[0].score - 0.5) < 0.01,
      `dated-memory decay must still produce ≈0.5, got ${decayed[0].score}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------- TEST 5: kill switch prevents patching --------

test("kill switch CARHER_DISABLE_SESSION_DECAY_PATCH=1 leaves file untouched", () => {
  const { dir, stub } = makeStub();
  try {
    const original = readFileSync(stub, "utf8");
    execSync(`CARHER_DISABLE_SESSION_DECAY_PATCH=1 bash ${APPLY_PATCH_SH} ${stub}`, { stdio: "pipe" });
    const after = readFileSync(stub, "utf8");
    assert.equal(after, original, "kill switch must skip patching");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
