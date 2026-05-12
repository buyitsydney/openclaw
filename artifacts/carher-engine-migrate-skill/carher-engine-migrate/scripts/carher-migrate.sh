#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-/data/.openclaw}"
HERMES_HOME="${HERMES_HOME:-/opt/data}"
ACTIVE_FILE="${CARHER_ENGINE_MARKER_FILE:-/data/.engine/active}"
HERMES_BIN="${HERMES_BIN:-/opt/hermes/venv/bin/hermes}"
PRESET="${CARHER_MIGRATE_PRESET:-user-data}"
SKILL_CONFLICT="${CARHER_MIGRATE_SKILL_CONFLICT:-skip}"
SOURCE_ALIAS="${CARHER_MIGRATE_SOURCE_ALIAS:-/tmp/carher-claw-source}"

usage() {
  cat <<'USAGE'
Usage:
  carher-migrate.sh status
  carher-migrate.sh plan
  carher-migrate.sh apply --confirm
  carher-migrate.sh apply --confirm --overwrite
  carher-migrate.sh reset-hermes-memory --confirm
  carher-migrate.sh reset-migration-targets --confirm
  carher-migrate.sh verify
  carher-migrate.sh review

Safe default:
  preset=user-data, skill-conflict=skip, secrets are not migrated.
USAGE
}

active_engine() {
  if [ -f "$ACTIVE_FILE" ]; then
    tr -d '[:space:]' < "$ACTIVE_FILE"
  else
    echo "unknown"
  fi
}

hermes_cmd() {
  if [ -x "$HERMES_BIN" ]; then
    "$HERMES_BIN" "$@"
  else
    hermes "$@"
  fi
}

ensure_neutral_argv() {
  if [ "${CARHER_MIGRATE_NEUTRAL_ARGV:-}" = "1" ]; then
    return 0
  fi
  case "$0 $*" in
    *openclaw*|*.openclaw*)
      local neutral_script
      neutral_script="$(mktemp "${TMPDIR:-/tmp}/carher-migrate-runner.XXXXXX")"
      cp "$0" "$neutral_script"
      chmod +x "$neutral_script"
      CARHER_MIGRATE_NEUTRAL_ARGV=1 exec bash "$neutral_script" "$@"
      ;;
  esac
}

process_table() {
  if [ "${CARHER_PROCESS_TABLE_FOR_TEST+x}" = "x" ]; then
    printf '%s\n' "$CARHER_PROCESS_TABLE_FOR_TEST"
  else
    ps -eo pid=,args=
  fi
}

openclaw_process_rows() {
  process_table | awk '
    /openclaw-to-hermes-migrate/ { next }
    /CARHER_PROCESS_TABLE_FOR_TEST/ { next }
    /openclaw gateway run/ { print; next }
    /openclaw .*gateway run/ { print; next }
    /\/openclaw\/.*dist\/index\.js/ { print; next }
    /\/openclaw\/.*bin\/openclaw/ { print; next }
  '
}

require_openclaw_source() {
  if [ ! -d "$OPENCLAW_HOME" ]; then
    echo "refuse: OPENCLAW_HOME does not exist: $OPENCLAW_HOME" >&2
    exit 3
  fi
}

migration_source() {
  require_openclaw_source
  if [ "$SOURCE_ALIAS" = "$OPENCLAW_HOME" ]; then
    printf '%s\n' "$OPENCLAW_HOME"
    return 0
  fi
  ln -sfn "$OPENCLAW_HOME" "$SOURCE_ALIAS"
  printf '%s\n' "$SOURCE_ALIAS"
}

warn_if_openclaw_running() {
  local rows
  rows="$(openclaw_process_rows || true)"
  if [ -n "$rows" ]; then
    echo "warning: OpenClaw appears to be running. plan is safe, but apply must run after switching to Hermes." >&2
    printf '%s\n' "$rows" >&2
  fi
}

require_apply_safe() {
  local active rows
  active="$(active_engine)"
  if [ "$active" = "openclaw" ]; then
    echo "refuse: active_engine=openclaw. Switch to Hermes first so OpenClaw is stopped, then rerun apply." >&2
    exit 5
  fi
  rows="$(openclaw_process_rows || true)"
  if [ -n "$rows" ]; then
    echo "refuse: OpenClaw process is still running. Hermes official migration would degrade to preview/dry-run." >&2
    printf '%s\n' "$rows" >&2
    exit 6
  fi
}

source_file() {
  local name="$1"
  for base in "$OPENCLAW_HOME/workspace" "$OPENCLAW_HOME/workspace-main" "$OPENCLAW_HOME/workspace.default" "$OPENCLAW_HOME/workspace-claude"; do
    if [ -f "$base/$name" ]; then
      printf '%s\n' "$base/$name"
      return 0
    fi
  done
  return 1
}

sha() {
  if [ -f "$1" ]; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "missing"
  fi
}

bytes() {
  if [ -f "$1" ]; then
    wc -c < "$1" | tr -d '[:space:]'
  else
    echo "0"
  fi
}

line() {
  printf '%s\n' "$*"
}

file_report() {
  local label="$1"
  local src="$2"
  local dst="$3"
  line "$label.source=$src"
  line "$label.source_exists=$([ -f "$src" ] && echo yes || echo no)"
  line "$label.source_bytes=$(bytes "$src")"
  line "$label.source_sha256=$(sha "$src")"
  line "$label.dest=$dst"
  line "$label.dest_exists=$([ -f "$dst" ] && echo yes || echo no)"
  line "$label.dest_bytes=$(bytes "$dst")"
  line "$label.dest_sha256=$(sha "$dst")"
}

status() {
  local soul_src user_src memory_src
  soul_src="$(source_file SOUL.md || true)"
  user_src="$(source_file USER.md || true)"
  memory_src="$(source_file MEMORY.md || true)"
  line "active_engine=$(active_engine)"
  if [ -n "$(openclaw_process_rows || true)" ]; then
    line "openclaw_process_running=yes"
    openclaw_process_rows | sed 's/^/openclaw_process=/'
  else
    line "openclaw_process_running=no"
  fi
  line "openclaw_home=$OPENCLAW_HOME"
  line "hermes_home=$HERMES_HOME"
  line "hermes_bin=$HERMES_BIN"
  file_report "SOUL" "${soul_src:-missing}" "$HERMES_HOME/SOUL.md"
  file_report "USER" "${user_src:-missing}" "$HERMES_HOME/memories/USER.md"
  file_report "MEMORY" "${memory_src:-missing}" "$HERMES_HOME/memories/MEMORY.md"
}

plan() {
  ensure_neutral_argv plan
  local source_arg
  source_arg="$(migration_source)"
  warn_if_openclaw_running
  HOME="$HERMES_HOME" HERMES_HOME="$HERMES_HOME" hermes_cmd claw migrate \
    --source "$source_arg" \
    --preset "$PRESET" \
    --skill-conflict "$SKILL_CONFLICT" \
    --dry-run \
    --yes
}

detect_forced_dry_run() {
  local output_file="$1"
  grep -F -q "No files were modified" "$output_file" ||
    grep -F -q "preview of what would happen" "$output_file" ||
    grep -F -q "To execute the migration, run without --dry-run" "$output_file"
}

detect_successful_apply() {
  local output_file="$1"
  grep -F -q "Migration complete!" "$output_file" ||
    grep -E -q "Summary: [1-9][0-9]* migrated" "$output_file"
}

detect_conflict_refusal() {
  local output_file="$1"
  grep -E -q "Plan has [0-9]+ conflict\\(s\\).*Refusing to apply|Refusing to apply" "$output_file"
}

run_apply_command() {
  local output_file="$1"
  local source_arg="$2"
  shift 2
  set +e
  HOME="$HERMES_HOME" HERMES_HOME="$HERMES_HOME" hermes_cmd claw migrate \
    --source "$source_arg" \
    --preset "$PRESET" \
    --skill-conflict "$SKILL_CONFLICT" \
    --yes \
    "$@" 2>&1 | tee "$output_file"
  local rc=${PIPESTATUS[0]}
  set -e
  return "$rc"
}

apply_migration() {
  local confirmed="no"
  local overwrite="no"
  for arg in "$@"; do
    if [ "$arg" = "--confirm" ]; then
      confirmed="yes"
    elif [ "$arg" = "--overwrite" ]; then
      overwrite="yes"
    fi
  done
  if [ "$confirmed" != "yes" ]; then
    echo "refuse: apply requires --confirm after owner approval" >&2
    exit 4
  fi
  require_openclaw_source
  require_apply_safe
  ensure_neutral_argv apply "$@"
  local output_file rc source_arg
  source_arg="$(migration_source)"
  output_file="$(mktemp "${TMPDIR:-/tmp}/carher-migrate-apply.XXXXXX")"
  if [ "$overwrite" = "yes" ]; then
    if run_apply_command "$output_file" "$source_arg" --overwrite; then
      rc=0
    else
      rc=$?
    fi
  else
    if run_apply_command "$output_file" "$source_arg"; then
      rc=0
    else
      rc=$?
    fi
  fi
  if detect_conflict_refusal "$output_file" && ! detect_successful_apply "$output_file"; then
    echo "refuse: Hermes found existing migration targets and refused to apply without --overwrite." >&2
    echo "next: ask the owner whether to overwrite existing Hermes targets, then rerun apply --confirm --overwrite if approved." >&2
    echo "apply_output=$output_file" >&2
    exit 7
  fi
  if detect_forced_dry_run "$output_file" && ! detect_successful_apply "$output_file"; then
    echo "refuse: Hermes reported a preview/dry-run instead of a real apply; no migration was accepted." >&2
    echo "apply_output=$output_file" >&2
    exit 8
  fi
  if [ "$rc" -ne 0 ]; then
    echo "refuse: Hermes migration command failed with exit_code=$rc" >&2
    echo "apply_output=$output_file" >&2
    exit "$rc"
  fi
  line "apply_output=$output_file"
}

copy_if_exists() {
  local src="$1"
  local dst="$2"
  if [ -f "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
  fi
}

reset_hermes_memory() {
  local confirmed="no"
  for arg in "$@"; do
    if [ "$arg" = "--confirm" ]; then
      confirmed="yes"
    fi
  done
  if [ "$confirmed" != "yes" ]; then
    echo "refuse: reset-hermes-memory requires --confirm after owner approval" >&2
    exit 4
  fi
  local stamp backup_dir
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_dir="$HERMES_HOME/backups/carher-migrate-reset-$stamp"
  mkdir -p "$backup_dir"
  copy_if_exists "$HERMES_HOME/SOUL.md" "$backup_dir/SOUL.md"
  copy_if_exists "$HERMES_HOME/USER.md" "$backup_dir/USER.md"
  copy_if_exists "$HERMES_HOME/MEMORY.md" "$backup_dir/MEMORY.md"
  copy_if_exists "$HERMES_HOME/memories/USER.md" "$backup_dir/memories/USER.md"
  copy_if_exists "$HERMES_HOME/memories/MEMORY.md" "$backup_dir/memories/MEMORY.md"
  rm -f "$HERMES_HOME/SOUL.md" \
    "$HERMES_HOME/USER.md" \
    "$HERMES_HOME/MEMORY.md" \
    "$HERMES_HOME/memories/USER.md" \
    "$HERMES_HOME/memories/MEMORY.md"
  line "reset_backup_dir=$backup_dir"
}

move_if_exists() {
  local src="$1"
  local dst="$2"
  if [ -e "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    mv "$src" "$dst"
  fi
}

reset_migration_targets() {
  local confirmed="no"
  for arg in "$@"; do
    if [ "$arg" = "--confirm" ]; then
      confirmed="yes"
    fi
  done
  if [ "$confirmed" != "yes" ]; then
    echo "refuse: reset-migration-targets requires --confirm after owner approval" >&2
    exit 4
  fi
  local stamp backup_dir
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_dir="$HERMES_HOME/backups/carher-migration-target-reset-$stamp"
  mkdir -p "$backup_dir"
  move_if_exists "$HERMES_HOME/SOUL.md" "$backup_dir/SOUL.md"
  move_if_exists "$HERMES_HOME/USER.md" "$backup_dir/USER.md"
  move_if_exists "$HERMES_HOME/MEMORY.md" "$backup_dir/MEMORY.md"
  move_if_exists "$HERMES_HOME/memories/USER.md" "$backup_dir/memories/USER.md"
  move_if_exists "$HERMES_HOME/memories/MEMORY.md" "$backup_dir/memories/MEMORY.md"
  move_if_exists "$HERMES_HOME/skills/openclaw-imports" "$backup_dir/skills/openclaw-imports"
  move_if_exists "$HERMES_HOME/migration/openclaw" "$backup_dir/migration/openclaw"
  mkdir -p "$HERMES_HOME/memories" "$HERMES_HOME/skills"
  line "reset_backup_dir=$backup_dir"
}

latest_report_dir() {
  find "$HERMES_HOME/migration/openclaw" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -1
}

review() {
  local report_dir
  report_dir="$(latest_report_dir || true)"
  status
  line "review.report_dir=${report_dir:-missing}"
  if [ -z "$report_dir" ] || [ ! -f "$report_dir/report.json" ]; then
    line "review.state=no_migration_report"
    line "review.next=run plan/apply first"
    return 0
  fi
  REVIEW_REPORT_DIR="$report_dir" REVIEW_HERMES_HOME="$HERMES_HOME" REVIEW_OPENCLAW_HOME="$OPENCLAW_HOME" python3 - <<'PY'
import json
import os
from pathlib import Path

report_dir = Path(os.environ["REVIEW_REPORT_DIR"])
hermes_home = Path(os.environ["REVIEW_HERMES_HOME"])
openclaw_home = Path(os.environ["REVIEW_OPENCLAW_HOME"])
report = json.loads((report_dir / "report.json").read_text())

counts = {}
for item in report.get("items", []):
    status = item.get("status") or item.get("result") or "unknown"
    counts[status] = counts.get(status, 0) + 1

print(f"review.summary.migrated={counts.get('migrated', 0)}")
print(f"review.summary.conflict={counts.get('conflict', 0)}")
print(f"review.summary.skipped={counts.get('skipped', 0)}")
print(f"review.summary.archived={counts.get('archived', 0)}")
print(f"review.summary.error={counts.get('error', 0)}")

memory_targets = [
    ("SOUL.md", openclaw_home / "workspace" / "SOUL.md", hermes_home / "SOUL.md"),
    ("USER.md", openclaw_home / "workspace" / "USER.md", hermes_home / "memories" / "USER.md"),
    ("MEMORY.md", openclaw_home / "workspace" / "MEMORY.md", hermes_home / "memories" / "MEMORY.md"),
]
for label, src, dst in memory_targets:
    src_ok = src.exists()
    dst_ok = dst.exists()
    print(f"review.memory.{label}.source_exists={'yes' if src_ok else 'no'}")
    print(f"review.memory.{label}.dest_exists={'yes' if dst_ok else 'no'}")
    if src_ok and dst_ok:
        print(f"review.memory.{label}.dest_bytes={dst.stat().st_size}")

source_shared = sorted(p.name for p in (openclaw_home / "skills").iterdir() if p.is_dir()) if (openclaw_home / "skills").is_dir() else []
imported_root = hermes_home / "skills" / "openclaw-imports"
imported = sorted(p.name for p in imported_root.iterdir() if p.is_dir()) if imported_root.is_dir() else []
print(f"review.skills.source_shared_count={len(source_shared)}")
print(f"review.skills.imported_openclaw_imports_count={len(imported)}")
missing = [name for name in source_shared if name not in imported]
print(f"review.skills.missing_shared_count={len(missing)}")
for idx, name in enumerate(missing[:20], 1):
    print(f"review.skills.missing_shared.{idx}={name}")
print("review.skills.user_prompt=Imported skills are files only; ask the owner to run /new, then verify the bot can invoke the needed skill names. Do not claim every imported skill is product-ready until verified.")

jobs_file = report_dir / "archive" / "cron-store" / "jobs.json"
if jobs_file.exists():
    jobs = json.loads(jobs_file.read_text()).get("jobs", [])
else:
    jobs = []
print(f"review.cron.archived_active_count={len(jobs)}")
for idx, job in enumerate(jobs, 1):
    schedule = job.get("schedule", {})
    payload = job.get("payload", {})
    text = payload.get("text") or payload.get("message") or ""
    print(f"review.cron.option.{idx}.id={job.get('id', '')}")
    print(f"review.cron.option.{idx}.name={job.get('name', '')}")
    print(f"review.cron.option.{idx}.enabled={str(job.get('enabled', False)).lower()}")
    print(f"review.cron.option.{idx}.schedule_kind={schedule.get('kind', '')}")
    print(f"review.cron.option.{idx}.schedule_expr={schedule.get('expr') or schedule.get('at') or ''}")
    print(f"review.cron.option.{idx}.timezone={schedule.get('tz', '')}")
    print(f"review.cron.option.{idx}.payload={text}")
print("review.cron.user_prompt=Cron jobs are archived only, not enabled in Hermes. Ask: reply with cron 1, cron 1,3, or cron all to recreate. Do not enable automatically.")
PY
}

verify_phrase() {
  local label="$1"
  local phrase="$2"
  local src_hits dst_hits
  src_hits="$(grep -R -F -n "$phrase" "$OPENCLAW_HOME"/workspace* 2>/dev/null | head -3 || true)"
  dst_hits="$(grep -R -F -n "$phrase" "$HERMES_HOME"/SOUL.md "$HERMES_HOME"/memories 2>/dev/null | head -5 || true)"
  line "phrase.$label=$phrase"
  line "phrase.$label.source_found=$([ -n "$src_hits" ] && echo yes || echo no)"
  if [ -n "$src_hits" ]; then
    printf '%s\n' "$src_hits"
  fi
  line "phrase.$label.dest_found=$([ -n "$dst_hits" ] && echo yes || echo no)"
  if [ -n "$dst_hits" ]; then
    printf '%s\n' "$dst_hits"
  fi
}

verify() {
  status
  verify_phrase "owner" "卜弋天"
  verify_phrase "nova" "Nova"
  verify_phrase "research3" "研究3"
  verify_phrase "glory_liao" "Glory Liao"
  if [ -n "${CARHER_VERIFY_PHRASES:-}" ]; then
    local old_ifs phrase idx
    old_ifs="$IFS"
    IFS='|'
    idx=1
    for phrase in $CARHER_VERIFY_PHRASES; do
      IFS="$old_ifs"
      verify_phrase "custom_$idx" "$phrase"
      idx=$((idx + 1))
      IFS='|'
    done
    IFS="$old_ifs"
  fi
}

cmd="${1:-}"
case "$cmd" in
  status)
    status
    ;;
  plan)
    plan
    ;;
  apply)
    shift
    apply_migration "$@"
    ;;
  reset-hermes-memory)
    shift
    reset_hermes_memory "$@"
    ;;
  reset-migration-targets)
    shift
    reset_migration_targets "$@"
    ;;
  verify)
    verify
    ;;
  review)
    review
    ;;
  -h|--help|help|"")
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
