import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = resolve(__dirname, "carher-migrate-ui.mjs");

function makeFixture({ applyFails = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "carher-migrate-ui-test-"));
  const bin = join(root, "bin");
  const log = join(root, "lark.log");
  const envLog = join(root, "lark-env.log");
  const migrate = join(root, "carher-migrate.sh");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "lark-cli"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${log}"
if [ "\${CARHER_MIGRATE_UI_LOG_ENV:-0}" = "1" ]; then
  printf 'HOME=%s HERMES_HOME=%s HERMES_DATA_DIR=%s\\n' "\${HOME:-}" "\${HERMES_HOME:-}" "\${HERMES_DATA_DIR:-}" >> "${envLog}"
fi
if [ "$1" = "im" ]; then
  echo '{"data":{"message_id":"om_ui_test"}}'
else
  echo '{"code":0,"msg":"ok"}'
fi
`,
  );
  chmodSync(join(bin, "lark-cli"), 0o755);
  writeFileSync(
    migrate,
    `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  status)
    echo 'active_engine=hermes'
    echo 'SOUL.source_sha256=sha-soul'
    echo 'SOUL.dest_sha256=sha-soul'
    ;;
  plan)
    echo 'Summary: 3 would migrate, 0 conflict(s), 2 skipped'
    ;;
  apply)
    ${applyFails ? "echo 'refuse: test conflict' >&2; exit 7" : "echo 'Migration complete!'"}
    ;;
  verify)
    echo 'SOUL.source_sha256=sha-soul'
    echo 'SOUL.dest_sha256=sha-soul'
    ;;
  review)
    echo 'SOUL.source_sha256=sha-soul'
    echo 'SOUL.dest_sha256=sha-soul'
    echo 'review.memory.USER.md.dest_exists=yes'
    echo 'review.memory.MEMORY.md.dest_exists=yes'
    echo 'review.summary.migrated=3'
    echo 'review.summary.conflict=0'
    echo 'review.summary.skipped=2'
    echo 'review.summary.archived=1'
    echo 'review.skills.imported_openclaw_imports_count=2'
    echo 'review.skills.missing_shared_count=0'
    echo 'review.cron.archived_active_count=1'
    echo 'review.cron.option.1.name=daily-check'
    echo 'review.report_dir=/tmp/report'
    ;;
esac
`,
  );
  chmodSync(migrate, 0o755);
  return {
    root,
    log,
    envLog,
    migrate,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CARHER_MIGRATE_SCRIPT: migrate,
      CARHER_MIGRATE_UI_SLEEP_MS: "0",
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("render builds a shared warm-gold migration card", () => {
  const result = spawnSync("node", [script, "render", "--phase", "规划", "--percent", "40"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const card = JSON.parse(result.stdout);
  assert.equal(card.config.update_multi, true);
  assert.equal(card.config.wide_screen_mode, true);
  assert.equal(card.header.template, "yellow");
  assert.match(card.elements[0].content, /40%/);
});

test("run edits the same Feishu card through success frames", () => {
  const fixture = makeFixture();
  try {
    const result = spawnSync(
      "node",
      [script, "run", "--chat-id", "oc_test", "--confirm"],
      { encoding: "utf8", env: fixture.env },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /message_id=om_ui_test/);
    const lines = readFileSync(fixture.log, "utf8").trim().split(/\r?\n/);
    assert.equal(lines.filter((line) => line.startsWith("im +messages-send")).length, 1);
    assert.equal(lines.filter((line) => line.startsWith("api PATCH")).length, 5);
    assert.match(lines.at(-1) || "", /im\/v1\/messages\/om_ui_test/);
    assert.match(lines.at(-1) || "", /100%|100/);
    assert.match(lines.at(-1) || "", /green|完成/);
  } finally {
    fixture.cleanup();
  }
});

test("run uses Hermes lark-cli home when a Hermes bind config exists", () => {
  const fixture = makeFixture();
  const hermesHome = join(fixture.root, "opt-data");
  mkdirSync(join(hermesHome, ".lark-cli/hermes"), { recursive: true });
  writeFileSync(join(hermesHome, ".lark-cli/hermes/config.json"), "{}");
  try {
    const result = spawnSync(
      "node",
      [script, "run", "--chat-id", "oc_test", "--confirm"],
      {
        encoding: "utf8",
        env: {
          ...fixture.env,
          HOME: "/root",
          HERMES_HOME: hermesHome,
          CARHER_MIGRATE_UI_LOG_ENV: "1",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const envLines = readFileSync(fixture.envLog, "utf8").trim().split(/\r?\n/);
    assert.ok(envLines.length >= 2);
    for (const line of envLines) {
      assert.match(line, new RegExp(`HOME=${hermesHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(line, new RegExp(`HERMES_HOME=${hermesHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(line, new RegExp(`HERMES_DATA_DIR=${hermesHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
  } finally {
    fixture.cleanup();
  }
});

test("run turns the same card red when apply refuses", () => {
  const fixture = makeFixture({ applyFails: true });
  try {
    const result = spawnSync(
      "node",
      [script, "run", "--chat-id", "oc_test", "--confirm"],
      { encoding: "utf8", env: fixture.env },
    );
    assert.equal(result.status, 7);
    const lines = readFileSync(fixture.log, "utf8").trim().split(/\r?\n/);
    assert.equal(lines.filter((line) => line.startsWith("im +messages-send")).length, 1);
    assert.equal(lines.filter((line) => line.startsWith("api PATCH")).length, 3);
    assert.match(lines.at(-1) || "", /red|失败|refuse/);
  } finally {
    fixture.cleanup();
  }
});
