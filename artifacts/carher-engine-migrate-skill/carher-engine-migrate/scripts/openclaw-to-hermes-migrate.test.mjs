import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = resolve(__dirname, "carher-migrate.sh");
const legacyScript = resolve(__dirname, "openclaw-to-hermes-migrate.sh");

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "carher-engine-migrate-test-"));
  const openclawHome = join(root, ".openclaw");
  const hermesHome = join(root, "hermes");
  const activeFile = join(root, "active");
  mkdirSync(join(openclawHome, "workspace"), { recursive: true });
  mkdirSync(join(openclawHome, "skills", "carher-peer-sessions"), { recursive: true });
  mkdirSync(join(openclawHome, "skills", "feishu-search"), { recursive: true });
  mkdirSync(join(hermesHome, "memories"), { recursive: true });
  writeFileSync(join(openclawHome, "workspace", "SOUL.md"), "SOUL MIGRATE_TEST_TOKEN\n");
  writeFileSync(join(openclawHome, "workspace", "USER.md"), "USER MIGRATE_TEST_TOKEN\n");
  writeFileSync(join(openclawHome, "workspace", "MEMORY.md"), "MEMORY MIGRATE_TEST_TOKEN\n");
  writeFileSync(join(openclawHome, "skills", "carher-peer-sessions", "SKILL.md"), "# peer\n");
  writeFileSync(join(openclawHome, "skills", "feishu-search", "SKILL.md"), "# search\n");
  writeFileSync(activeFile, "hermes\n");

  return {
    root,
    openclawHome,
    hermesHome,
    activeFile,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeHermesStub(root, body) {
  const stub = join(root, "hermes-stub.sh");
  writeFileSync(stub, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(stub, 0o755);
  return stub;
}

function run(args, fixture, extraEnv = {}) {
  return spawnSync("bash", [script, ...args], {
    env: {
      ...process.env,
      OPENCLAW_HOME: fixture.openclawHome,
      HERMES_HOME: fixture.hermesHome,
      CARHER_ENGINE_MARKER_FILE: fixture.activeFile,
      CARHER_PROCESS_TABLE_FOR_TEST: "",
      CARHER_MIGRATE_SOURCE_ALIAS: join(fixture.root, "carher-claw-source"),
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function runLegacy(args, fixture, extraEnv = {}) {
  return spawnSync("bash", [legacyScript, ...args], {
    env: {
      ...process.env,
      OPENCLAW_HOME: fixture.openclawHome,
      HERMES_HOME: fixture.hermesHome,
      CARHER_ENGINE_MARKER_FILE: fixture.activeFile,
      CARHER_PROCESS_TABLE_FOR_TEST: "",
      CARHER_MIGRATE_SOURCE_ALIAS: join(fixture.root, "carher-claw-source"),
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

test("legacy openclaw-named entry refuses plan and apply", () => {
  const fixture = makeFixture();
  try {
    const plan = runLegacy(["plan"], fixture);
    const apply = runLegacy(["apply", "--confirm"], fixture);

    assert.equal(plan.status, 9);
    assert.equal(apply.status, 9);
    assert.match(plan.stderr, /use scripts\/carher-migrate\.sh/);
  } finally {
    fixture.cleanup();
  }
});

test("plan uses a neutral source alias and noninteractive confirmation", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(fixture.activeFile, "openclaw\n");
    const hermes = makeHermesStub(fixture.root, 'printf "%s\\n" "$@"');
    const result = run(["plan"], fixture, { HERMES_BIN: hermes });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--source/);
    assert.match(result.stdout, /carher-claw-source/);
    assert.doesNotMatch(result.stdout, new RegExp(fixture.openclawHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.stdout, /--dry-run/);
    assert.match(result.stdout, /--yes/);
  } finally {
    fixture.cleanup();
  }
});

test("apply refuses while active engine is OpenClaw", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(fixture.activeFile, "openclaw\n");
    const hermes = makeHermesStub(fixture.root, "exit 99");
    const result = run(["apply", "--confirm"], fixture, { HERMES_BIN: hermes });

    assert.equal(result.status, 5);
    assert.match(result.stderr, /active_engine=openclaw/);
  } finally {
    fixture.cleanup();
  }
});

test("apply refuses when an OpenClaw process is still running", () => {
  const fixture = makeFixture();
  try {
    const hermes = makeHermesStub(fixture.root, "exit 99");
    const result = run(["apply", "--confirm"], fixture, {
      HERMES_BIN: hermes,
      CARHER_PROCESS_TABLE_FOR_TEST: "131 /opt/node22/bin/node /opt/openclaw/dist/index.js gateway run",
    });

    assert.equal(result.status, 6);
    assert.match(result.stderr, /OpenClaw process is still running/);
    assert.match(result.stderr, /official migration would degrade/);
  } finally {
    fixture.cleanup();
  }
});

test("apply fails when Hermes silently degrades to preview", () => {
  const fixture = makeFixture();
  try {
    const hermes = makeHermesStub(
      fixture.root,
      [
        'echo "No files were modified. This is a preview of what would happen."',
        'echo "To execute the migration, run without --dry-run"',
      ].join("\n"),
    );
    const result = run(["apply", "--confirm"], fixture, { HERMES_BIN: hermes });

    assert.equal(result.status, 8);
    assert.match(result.stderr, /preview\/dry-run/);
  } finally {
    fixture.cleanup();
  }
});

test("apply reports conflicts separately from forced dry-run", () => {
  const fixture = makeFixture();
  try {
    const hermes = makeHermesStub(
      fixture.root,
      [
        'echo "No files were modified. This is a preview of what would happen."',
        'echo "Summary: 3 would migrate, 17 conflict(s), 32 skipped"',
        'echo "✗ Plan has 17 conflict(s). Refusing to apply."',
      ].join("\n"),
    );
    const result = run(["apply", "--confirm"], fixture, { HERMES_BIN: hermes });

    assert.equal(result.status, 7);
    assert.match(result.stderr, /existing migration targets/);
    assert.match(result.stderr, /apply --confirm --overwrite/);
  } finally {
    fixture.cleanup();
  }
});

test("apply succeeds and verify finds a migrated marker", () => {
  const fixture = makeFixture();
  try {
    const hermes = makeHermesStub(
      fixture.root,
      [
        'source_dir=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --source) source_dir="$2"; shift 2 ;;',
        '    *) shift ;;',
        "  esac",
        "done",
        'mkdir -p "$HERMES_HOME/memories"',
        'echo "No files were modified. This is a preview of what would happen."',
        'cp "$source_dir/workspace/SOUL.md" "$HERMES_HOME/SOUL.md"',
        'cp "$source_dir/workspace/USER.md" "$HERMES_HOME/memories/USER.md"',
        'cp "$source_dir/workspace/MEMORY.md" "$HERMES_HOME/memories/MEMORY.md"',
        'echo "Migrated 3 items"',
        'echo "Migration complete!"',
      ].join("\n"),
    );
    const applied = run(["apply", "--confirm"], fixture, { HERMES_BIN: hermes });
    assert.equal(applied.status, 0, applied.stderr);

    const verified = run(["verify"], fixture, {
      HERMES_BIN: hermes,
      CARHER_VERIFY_PHRASES: "MIGRATE_TEST_TOKEN",
    });
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /phrase\.custom_1\.source_found=yes/);
    assert.match(verified.stdout, /phrase\.custom_1\.dest_found=yes/);
  } finally {
    fixture.cleanup();
  }
});

test("reset-migration-targets backs up memory, imported skills, and migration reports", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(join(fixture.hermesHome, "SOUL.md"), "old soul\n");
    writeFileSync(join(fixture.hermesHome, "memories", "USER.md"), "old user\n");
    mkdirSync(join(fixture.hermesHome, "skills", "openclaw-imports", "feishu-search"), { recursive: true });
    mkdirSync(join(fixture.hermesHome, "migration", "openclaw", "20260101T000000"), { recursive: true });
    writeFileSync(join(fixture.hermesHome, "skills", "openclaw-imports", "feishu-search", "SKILL.md"), "# imported\n");
    writeFileSync(join(fixture.hermesHome, "migration", "openclaw", "20260101T000000", "summary.md"), "old report\n");

    const result = run(["reset-migration-targets", "--confirm"], fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(fixture.hermesHome, "SOUL.md")), false);
    assert.equal(existsSync(join(fixture.hermesHome, "memories", "USER.md")), false);
    assert.equal(existsSync(join(fixture.hermesHome, "skills", "openclaw-imports")), false);
    assert.equal(existsSync(join(fixture.hermesHome, "migration", "openclaw")), false);

    const backupDir = result.stdout.match(/reset_backup_dir=(.*)/)?.[1]?.trim();
    assert.ok(backupDir);
    assert.equal(readFileSync(join(backupDir, "SOUL.md"), "utf8"), "old soul\n");
    assert.equal(readFileSync(join(backupDir, "skills", "openclaw-imports", "feishu-search", "SKILL.md"), "utf8"), "# imported\n");
    assert.equal(readFileSync(join(backupDir, "migration", "openclaw", "20260101T000000", "summary.md"), "utf8"), "old report\n");
  } finally {
    fixture.cleanup();
  }
});

test("review reports imported skills and archived cron choices without claiming cron is enabled", () => {
  const fixture = makeFixture();
  try {
    const reportDir = join(fixture.hermesHome, "migration", "openclaw", "20260101T000000");
    mkdirSync(join(reportDir, "archive", "cron-store"), { recursive: true });
    mkdirSync(join(fixture.hermesHome, "skills", "openclaw-imports", "carher-peer-sessions"), { recursive: true });
    writeFileSync(
      join(reportDir, "report.json"),
      JSON.stringify({
        items: [
          { id: "soul", status: "migrated" },
          { id: "skill", status: "conflict" },
          { id: "cron-jobs", status: "archived" },
        ],
      }),
    );
    writeFileSync(
      join(reportDir, "archive", "cron-store", "jobs.json"),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "job-1",
            name: "daily-check",
            enabled: true,
            schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
            payload: { kind: "systemEvent", text: "check updates" },
          },
        ],
      }),
    );
    writeFileSync(join(fixture.hermesHome, "SOUL.md"), "SOUL MIGRATE_TEST_TOKEN\n");
    writeFileSync(join(fixture.hermesHome, "memories", "USER.md"), "USER MIGRATE_TEST_TOKEN\n");
    writeFileSync(join(fixture.hermesHome, "memories", "MEMORY.md"), "MEMORY MIGRATE_TEST_TOKEN\n");

    const result = run(["review"], fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /review\.summary\.migrated=1/);
    assert.match(result.stdout, /review\.summary\.conflict=1/);
    assert.match(result.stdout, /review\.summary\.archived=1/);
    assert.match(result.stdout, /review\.skills\.source_shared_count=2/);
    assert.match(result.stdout, /review\.skills\.imported_openclaw_imports_count=1/);
    assert.match(result.stdout, /review\.skills\.missing_shared_count=1/);
    assert.match(result.stdout, /review\.cron\.archived_active_count=1/);
    assert.match(result.stdout, /review\.cron\.option\.1\.name=daily-check/);
    assert.match(result.stdout, /Cron jobs are archived only, not enabled in Hermes/);
  } finally {
    fixture.cleanup();
  }
});

test("reset-hermes-memory backs up and clears target files", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(join(fixture.hermesHome, "SOUL.md"), "old soul\n");
    writeFileSync(join(fixture.hermesHome, "USER.md"), "old root user\n");
    writeFileSync(join(fixture.hermesHome, "MEMORY.md"), "old root memory\n");
    writeFileSync(join(fixture.hermesHome, "memories", "USER.md"), "old user\n");
    writeFileSync(join(fixture.hermesHome, "memories", "MEMORY.md"), "old memory\n");

    const result = run(["reset-hermes-memory", "--confirm"], fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(fixture.hermesHome, "SOUL.md")), false);
    assert.equal(existsSync(join(fixture.hermesHome, "USER.md")), false);
    assert.equal(existsSync(join(fixture.hermesHome, "MEMORY.md")), false);
    assert.equal(existsSync(join(fixture.hermesHome, "memories", "USER.md")), false);
    assert.equal(existsSync(join(fixture.hermesHome, "memories", "MEMORY.md")), false);

    const backupDir = result.stdout.match(/reset_backup_dir=(.*)/)?.[1]?.trim();
    assert.ok(backupDir);
    assert.equal(readFileSync(join(backupDir, "SOUL.md"), "utf8"), "old soul\n");
    assert.equal(readFileSync(join(backupDir, "memories", "USER.md"), "utf8"), "old user\n");
  } finally {
    fixture.cleanup();
  }
});
