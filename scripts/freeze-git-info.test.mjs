// node --test scripts/freeze-git-info.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts/freeze-git-info.sh");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "CarHer Test",
      GIT_AUTHOR_EMAIL: "carher-test@example.invalid",
      GIT_COMMITTER_NAME: "CarHer Test",
      GIT_COMMITTER_EMAIL: "carher-test@example.invalid",
    },
  });
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "carher-freeze-git-info-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "CarHer Test"]);
  git(repo, ["config", "user.email", "carher-test@example.invalid"]);
  for (let i = 1; i <= 203; i++) {
    git(repo, ["commit", "--allow-empty", "-m", `main-${String(i).padStart(3, "0")}`]);
  }
  git(repo, ["checkout", "-b", "side", "HEAD~100"]);
  git(repo, ["commit", "--allow-empty", "-m", "side-only"]);
  git(repo, ["checkout", "main"]);
  return repo;
}

function runFreeze(repo, extraEnv = {}) {
  const stdout = execFileSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      CARHER_FREEZE_ROOT: repo,
      ...extraEnv,
    },
  });
  return JSON.parse(stdout);
}

test("freeze-git-info defaults to bounded HEAD history, not all refs", () => {
  const repo = makeRepo();
  try {
    const info = runFreeze(repo);
    assert.equal(info.freeze_depth, 200);
    assert.equal(info.freeze_scope, "HEAD");
    assert.equal(info.recent_commits.length, 200);
    assert.equal(info.recent_commits[0].subject, "main-203");
    assert.equal(
      info.recent_commits.some((commit) => commit.subject === "side-only"),
      false,
      "default build metadata must not scan unrelated refs",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("freeze-git-info honors explicit depth and still caps accidental huge values", () => {
  const repo = makeRepo();
  try {
    const top3 = runFreeze(repo, { CARHER_FREEZE_DEPTH: "3" });
    assert.equal(top3.freeze_depth, 3);
    assert.deepEqual(
      top3.recent_commits.map((commit) => commit.subject),
      ["main-203", "main-202", "main-201"],
    );

    const capped = runFreeze(repo, {
      CARHER_FREEZE_DEPTH: "999999",
      CARHER_FREEZE_MAX_DEPTH: "10",
    });
    assert.equal(capped.freeze_depth, 10);
    assert.equal(capped.recent_commits.length, 10);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("freeze-git-info can scan all refs only when explicitly requested", () => {
  const repo = makeRepo();
  try {
    const info = runFreeze(repo, {
      CARHER_FREEZE_SCOPE: "all",
      CARHER_FREEZE_DEPTH: "20",
    });
    assert.equal(info.freeze_scope, "all");
    assert.equal(
      info.recent_commits.some((commit) => commit.subject === "side-only"),
      true,
      "all-ref scanning must be opt-in",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
