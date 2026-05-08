#!/bin/bash
# Car Her 容器入口：同时启动 Gateway + Live Frontend Proxy
set -e

echo "🚗 Car Her Container Starting..."
echo "   Gateway:  :18789"
echo "   Realtime: :18790"
echo "   Frontend: :8000 (WS proxy: :8080)"

# Ensure data directories exist
mkdir -p /data/.openclaw/workspace
mkdir -p /data/.openclaw/local/bin

# Symlink persistent CLI binaries into /usr/local/bin so all processes find them.
# NPM_CONFIG_PREFIX and PATH are set in Dockerfile ENV (survives docker exec too).
ln -sf /data/.openclaw/local/bin/* /usr/local/bin/ 2>/dev/null || true

# ── Three-component runtime plugin install ──────────────────────────
# openclaw-lark (channel "feishu" + 40 tools) and lark-cli (24 AI skills)
# are npm packages installed at runtime into the persistent volume.
# This decouples plugin versions from the Docker image — upgrade by
# npm update + restart, no image rebuild needed.
PLUGIN_DIR="/data/.openclaw/extensions"
mkdir -p "$PLUGIN_DIR"

# openclaw-lark: channel provider + tools
LARK_WANT="${CARHER_OPENCLAW_LARK_VERSION:-latest}"
LARK_PKG="$PLUGIN_DIR/node_modules/@larksuite/openclaw-lark"
CARHER_PATCHES_DIR="/carher-patches"
LARK_DISPATCH="$LARK_PKG/src/messaging/inbound/dispatch.js"
if [ ! -d "$LARK_PKG" ] || [ "${CARHER_FORCE_PLUGIN_INSTALL:-}" = "1" ]; then
  echo "▶ Installing @larksuite/openclaw-lark@${LARK_WANT}..."
  npm install --prefix "$PLUGIN_DIR" "@larksuite/openclaw-lark@${LARK_WANT}" --omit=dev 2>&1 | tail -3
  echo "  ✓ openclaw-lark installed"
else
  echo "  ✓ openclaw-lark already installed"
fi

# ── openclaw-lark: stripBotMentions=false patch (multi-bot group bug) ──
# Bug: 上游 parse.js:102 硬编码 `stripBotMentions: true`,多 bot 群 @ 多 bot 时,
# 每个 bot 看到的 prompt 里自己的 @ 被剥掉 → LLM 认为没被 @ → 回 NO_REPLY。
# 上游 @larksuite/openclaw-lark 闭源,不可提 PR;此 patch 必须在 npm install 后
# 每次重跑(幂等)。已通过 preflight dry-run + unit test 验证(见 plan 文件)。
# Kill switch: CARHER_DISABLE_STRIP_BOT_MENTIONS_PATCH=1
LARK_PARSE="$LARK_PKG/src/messaging/inbound/parse.js"
if [ -f "$LARK_PARSE" ] && [ -z "${CARHER_DISABLE_STRIP_BOT_MENTIONS_PATCH:-}" ]; then
  LARK_PARSE_HASH=$(sha256sum "$LARK_PARSE" | cut -c1-12)
  LARK_PARSE_BAK="$LARK_PARSE.bak.$LARK_PARSE_HASH"
  [ -f "$LARK_PARSE_BAK" ] || cp -p "$LARK_PARSE" "$LARK_PARSE_BAK"
  if grep -qE 'stripBotMentions:[[:space:]]*true' "$LARK_PARSE"; then
    sed -i -E 's/^([[:space:]]*)stripBotMentions:[[:space:]]*true([[:space:]]*,?)/\1stripBotMentions: false\2/' "$LARK_PARSE"
    if node --check "$LARK_PARSE" 2>/dev/null; then
      echo "  ✓ openclaw-lark stripBotMentions → false (backup: $LARK_PARSE_BAK)"
    else
      echo "  ✗ stripBotMentions patch broke syntax, restoring backup" >&2
      cp -p "$LARK_PARSE_BAK" "$LARK_PARSE"
    fi
  else
    echo "  ✓ stripBotMentions already false (or renamed upstream)"
  fi
fi
# ── end stripBotMentions patch ────────────────────────────────────

# ── openclaw-lark: command body mention normalization ─────────────
# Keep bot mentions visible to the LLM for normal group turns, but strip this
# bot's addressing mention from slash-command CommandBody so `/new @bot` is
# handled as bare `/new` instead of `/new` with a prompt tail.
# Also ignores slash commands targeted at another mentioned account.
# Kill switch: CARHER_DISABLE_COMMAND_BODY_NORMALIZE_PATCH=1
if [ "${CARHER_DISABLE_COMMAND_BODY_NORMALIZE_PATCH:-0}" = "1" ]; then
  echo "  ⏭  command-body normalize patch skipped (CARHER_DISABLE_COMMAND_BODY_NORMALIZE_PATCH=1)"
elif [ ! -d "$CARHER_PATCHES_DIR" ]; then
  echo "  ⚠️  $CARHER_PATCHES_DIR not mounted — command-body normalize patch skipped"
elif [ ! -f "$LARK_DISPATCH" ]; then
  echo "  ⚠️  $LARK_DISPATCH not found — command-body normalize patch skipped"
else
  echo "  ▶ Patching openclaw-lark dispatch.js → slash command mention normalization..."
  if bash "$CARHER_PATCHES_DIR/apply-command-body-normalize.sh" "$LARK_DISPATCH"; then
    echo "    ✓ command-body normalize patch applied"
  else
    echo "    ✗ command-body normalize patch failed — group /new @bot may enter agent" >&2
  fi
fi
# ── end command body mention normalization ────────────────────────

# ── P8: proactive 20-msg group history fill (restores feishu-her behavior) ──
# Before the three-component migration (commit 32c2b19), feishu-her/gateway.ts
# pulled the last 20 group messages from /im/v1/messages on every @mention.
# After the migration the channel moved to @larksuite/openclaw-lark which only
# accumulates history passively via im.message.receive_v1 events — so a bot
# that just restarted (or a quiet group that wakes up hours later) has zero
# context when @mentioned. This patch restores the pre-migration behavior
# by injecting a proactive back-fill call before buildEnvelopeWithHistory.
#
# Source of truth: scripts/carher-patches/ (bind-mounted into /carher-patches)
# Kill switches:
#   CARHER_DISABLE_HISTORY_FILL_PATCH=1  → skip patch at boot
#   CARHER_DISABLE_HISTORY_FILL=1        → patch applied but helper no-ops at runtime
if [ "${CARHER_DISABLE_HISTORY_FILL_PATCH:-0}" = "1" ]; then
  echo "  ⏭  history-fill patch skipped (CARHER_DISABLE_HISTORY_FILL_PATCH=1)"
elif [ ! -d "$CARHER_PATCHES_DIR" ]; then
  echo "  ⚠️  $CARHER_PATCHES_DIR not mounted — history-fill patch skipped"
elif [ ! -f "$LARK_DISPATCH" ]; then
  echo "  ⚠️  $LARK_DISPATCH not found — history-fill patch skipped"
else
  echo "  ▶ Patching openclaw-lark dispatch.js → proactive 20-msg history fill..."
  cp "$CARHER_PATCHES_DIR/history-fill-helper.js" \
     "$LARK_PKG/src/messaging/inbound/carher-history-fill.js"
  if bash "$CARHER_PATCHES_DIR/apply-history-fill.sh" "$LARK_DISPATCH"; then
    echo "    ✓ history-fill patch applied (helper + dispatch.js)"
  else
    echo "    ✗ history-fill patch failed — bot will run with since-last-reply behavior" >&2
  fi
fi
# ── end P8 history-fill patch ────────────────────────────────────

# NOTE: an R-7 "CommandSource" / "sourceReplyDeliveryMode" patch was attempted
# 2026-05-08 to fix /new delivered=false in groups. Neither approach worked:
# core's /new native handler does a silent session-reset (no onBlockReply
# emission), so no replyOptions tweak helps. /new in group appears to have
# NEVER worked after the three-component migration (commit 32c2b19). DM /new
# still works because DMs take a different core path.
# See `.cursor/skills/carher-ops/SKILL.md` 第 13 章 踩坑 #11.

# lark-cli: 24 AI skills (Go binary)
LARK_CLI_WANT="${CARHER_LARK_CLI_VERSION:-latest}"
if ! command -v lark-cli &>/dev/null || [ "${CARHER_FORCE_PLUGIN_INSTALL:-}" = "1" ]; then
  echo "▶ Installing @larksuite/cli@${LARK_CLI_WANT}..."
  npm install -g "@larksuite/cli@${LARK_CLI_WANT}" --prefix /data/.openclaw/local 2>&1 | tail -3
  ln -sf /data/.openclaw/local/bin/lark-cli /usr/local/bin/lark-cli 2>/dev/null || true
  echo "  ✓ lark-cli installed"
else
  echo "  ✓ lark-cli already installed"
fi

# ── openclaw-lark: channel-only mode ──────────────────────────────
# Strip tools + skills from openclaw-lark manifest: keep ONLY the channel.
# Tools are blocked by owner-policy anyway; skills waste context.
# All feishu API access goes through lark-cli (no owner restriction).
LARK_MANIFEST="$LARK_PKG/openclaw.plugin.json"
if [ -f "$LARK_MANIFEST" ]; then
  echo "  ▶ Patching openclaw-lark → channel-only (no tools, no skills)..."
  node -e "
    const fs = require('fs');
    const m = JSON.parse(fs.readFileSync('$LARK_MANIFEST', 'utf8'));
    m.contracts = { tools: [] };
    m.skills = [];
    fs.writeFileSync('$LARK_MANIFEST', JSON.stringify(m, null, 2));
    console.log('    ✓ openclaw-lark stripped to channel-only');
  "
fi
# ── end openclaw-lark channel-only ───────────────────────────────

# ── feishu-her 0503 compat: declare contracts.tools ───────────────
# feishu-her (baked in image) also needs contracts.tools for 0503.
FEISHU_HER_MANIFEST="/app/docker/plugins/feishu-her/openclaw.plugin.json"
if [ -f "$FEISHU_HER_MANIFEST" ]; then
  echo "  ▶ Ensuring feishu-her manifest has contracts.tools (0503 compat)..."
  node -e "
    const fs = require('fs');
    const TOOLS = [
      'end_discussion', 'reset_discussion', 'set_discussion_leader', 'set_group_mode',
      'feishu_bitable', 'feishu_board', 'feishu_bot_directory',
      'feishu_calendar', 'feishu_chat', 'feishu_chat_capability',
      'feishu_chat_controls', 'feishu_chat_manage', 'feishu_chat_members',
      'feishu_chat_pins', 'feishu_chat_tabs', 'feishu_chat_top_notice',
      'feishu_deep_search', 'feishu_directory', 'feishu_doc',
      'feishu_doc_comments', 'feishu_drive', 'feishu_group_history',
      'feishu_knowledge_qa', 'feishu_mail', 'feishu_message',
      'feishu_message_search', 'feishu_minutes', 'feishu_search',
      'feishu_sheet', 'feishu_wiki'
    ];
    const m = JSON.parse(fs.readFileSync('$FEISHU_HER_MANIFEST', 'utf8'));
    m.contracts = { ...m.contracts, tools: TOOLS };
    m.activation = { onStartup: true };
    fs.writeFileSync('$FEISHU_HER_MANIFEST', JSON.stringify(m, null, 2));
    console.log('    ✓ contracts.tools (' + TOOLS.length + ') + activation.onStartup patched');
  "
fi
# ── end feishu-her 0503 compat ───────────────────────────────────

# ── shadow-daemon: ensure activation.onStartup ────────────────────
SHADOW_MANIFEST="/app/docker/plugins/shadow-daemon/openclaw.plugin.json"
if [ -f "$SHADOW_MANIFEST" ]; then
  node -e "
    const fs = require('fs');
    const m = JSON.parse(fs.readFileSync('$SHADOW_MANIFEST', 'utf8'));
    if (!m.activation?.onStartup) {
      m.activation = { onStartup: true };
      fs.writeFileSync('$SHADOW_MANIFEST', JSON.stringify(m, null, 2));
    }
  "
fi
# ── end shadow-daemon ─────────────────────────────────────────────

# Re-symlink after plugin install (new binaries may have been added)
ln -sf /data/.openclaw/local/bin/* /usr/local/bin/ 2>/dev/null || true
# ── end three-component runtime plugin install ──────────────────────

# ACP: install Claude Code CLI + acpx on first startup (only if ACP enabled)
if [ "${CARHER_ACP_ENABLED:-}" = "1" ]; then
  if ! command -v claude &>/dev/null; then
    echo "▶ Installing Claude Code CLI..."
    npm install -g @anthropic-ai/claude-code --prefix /data/.openclaw/local 2>&1 | tail -1
  fi
  ACPX_WANT="0.5.3"
  ACPX_HAVE=$(acpx --version 2>/dev/null || echo "none")
  if [ "$ACPX_HAVE" != "$ACPX_WANT" ]; then
    echo "▶ Installing acpx@${ACPX_WANT} (current: ${ACPX_HAVE})..."
    npm install -g acpx@${ACPX_WANT} --prefix /data/.openclaw/local 2>&1 | tail -1
  fi
  ln -sf /data/.openclaw/local/bin/* /usr/local/bin/ 2>/dev/null || true

  # Wrap claude binary to inject API credentials (acpx strips provider env vars)
  CLAUDE_REAL="/data/.openclaw/local/bin/claude-real"
  CLAUDE_BIN="/data/.openclaw/local/bin/claude"
  if [ -x "$CLAUDE_BIN" ] && [ ! -x "$CLAUDE_REAL" ]; then
    mv "$CLAUDE_BIN" "$CLAUDE_REAL"
  fi
  # Always regenerate wrapper (env vars may change between restarts)
  cat > "$CLAUDE_BIN" <<WRAP
#!/usr/bin/env bash
[ -n "\${ANTHROPIC_BASE_URL:-}" ] || export ANTHROPIC_BASE_URL="\${CARHER_ANTHROPIC_BASE_URL:-}"
[ -n "\${ANTHROPIC_AUTH_TOKEN:-}" ] || export ANTHROPIC_AUTH_TOKEN="\${CARHER_ANTHROPIC_AUTH_TOKEN:-}"
export ANTHROPIC_MODEL="\${ANTHROPIC_MODEL:-anthropic.claude-opus-4-6}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="\${ANTHROPIC_DEFAULT_SONNET_MODEL:-anthropic.claude-sonnet-4-6}"
export ANTHROPIC_DEFAULT_OPUS_MODEL="\${ANTHROPIC_DEFAULT_OPUS_MODEL:-anthropic.claude-opus-4-6}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="\${ANTHROPIC_DEFAULT_HAIKU_MODEL:-anthropic.claude-haiku-4-5}"
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
export DISABLE_INTERLEAVED_THINKING=1
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
exec "${CLAUDE_REAL}" "\$@"
WRAP
  chmod +x "$CLAUDE_BIN"
  ln -sf "$CLAUDE_BIN" /usr/local/bin/claude

  # Generate Claude Code settings.json (survives container recreation via volume)
  mkdir -p /data/.claude
  cat > /data/.claude/settings.json <<SETTINGS
{
  "model": "anthropic.claude-opus-4-6",
  "sandbox": {
    "enabled": false
  },
  "permissions": {
    "defaultMode": "acceptEdits",
    "allow": ["Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "WebSearch(*)", "WebFetch(*)"]
  },
  "env": {
    "ANTHROPIC_BASE_URL": "${ANTHROPIC_BASE_URL:-}",
    "ANTHROPIC_AUTH_TOKEN": "${ANTHROPIC_AUTH_TOKEN:-}",
    "ANTHROPIC_MODEL": "anthropic.claude-opus-4-6",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "anthropic.claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "anthropic.claude-opus-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "anthropic.claude-haiku-4-5",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1"
  }
}
SETTINGS

  # Generate credentials.json so Claude Code can authenticate without interactive login
  cat > /data/.claude/.credentials.json <<CREDS
{
  "apiKey": "${ANTHROPIC_AUTH_TOKEN:-}",
  "baseURL": "${ANTHROPIC_BASE_URL:-}"
}
CREDS

  # Fix dist-runtime symlink issue: replace SKILL.md symlinks with real files
  # so the skill loader's realpath check passes
  find /app/dist-runtime/extensions -name "SKILL.md" -type l 2>/dev/null | while read -r link; do
    target=$(readlink -f "$link" 2>/dev/null)
    if [ -f "$target" ]; then
      rm "$link" && cp "$target" "$link"
    fi
  done

  # Clear stale acpx sessions (but keep config)
  rm -rf /data/.acpx/sessions /data/.acpx/queues 2>/dev/null || true
  rm -rf /data/.openclaw/agents/claude 2>/dev/null || true

  # Clean acpx config (use default npx @agentclientprotocol/claude-agent-acp adapter)
  rm -f /data/.acpx/config.json 2>/dev/null || true

  echo "  ✓ ACP ready (Claude Code + acpx + wrapper + settings + skill)"
fi
# Clean stale Chrome singleton locks — hostname changes on container restart,
# causing Chromium to refuse starting ("profile in use by another computer").
find /data/.openclaw/browser -name "SingletonLock" -o -name "SingletonSocket" -o -name "SingletonCookie" 2>/dev/null | xargs rm -f 2>/dev/null || true

# Clean stale session write locks — previous container may have been killed
# before releasing locks; PID reuse in containers causes false "alive" detection.
find /data/.openclaw -name "*.jsonl.lock" -delete 2>/dev/null || true

# Start Live Frontend Proxy in background
echo "▶ Starting Live Frontend Proxy..."
cd /app/extensions/realtime/live-frontend
python3 server.py &
PROXY_PID=$!

# Trap signals to clean up
cleanup() {
  echo "Stopping..."
  kill "$PROXY_PID" 2>/dev/null || true
  wait "$PROXY_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── Resolve openclaw peerDependency for load.paths plugins ─────────
# Plugins loaded via plugins.load.paths sit outside gateway's node_modules
# tree, so they can't resolve the openclaw peerDep. Symlink the SDK shim
# (already provided by gateway at dist/extensions/node_modules/openclaw)
# into each plugin's node_modules.
# The shim only ships a subset of plugin-sdk files; backfill any missing
# ones from the gateway's full dist/plugin-sdk/ build output.
OPENCLAW_SDK_SHIM="/app/dist/extensions/node_modules/openclaw"
for f in /app/dist/plugin-sdk/*.js; do
  base=$(basename "$f")
  [ -e "$OPENCLAW_SDK_SHIM/plugin-sdk/$base" ] || \
    ln -sf "$f" "$OPENCLAW_SDK_SHIM/plugin-sdk/$base"
done
for plugdir in /app/docker/plugins/*/; do
  [ -d "$plugdir" ] || continue
  mkdir -p "${plugdir}node_modules"
  ln -sf "$OPENCLAW_SDK_SHIM" "${plugdir}node_modules/openclaw" 2>/dev/null || true
done

# Apply stop-hook-pipeline patch to pi-agent-core agent-loop.js
# (See docs/her/stop-hook-pipeline-architecture.md. Script is idempotent.)
if [ -x /app/docker/plugins/her-antitalker-poc/patch-agent-loop.sh ]; then
  /app/docker/plugins/her-antitalker-poc/patch-agent-loop.sh || \
    echo "WARN: patch-agent-loop.sh failed — stop-hook-pipeline will silently no-op"
fi

# Seed stop-hook-rules.yaml from image defaults if the runtime-path copy is
# missing (fresh container / volume). Once seeded, operator can edit the live
# file freely; the watcher will pick up changes. Never overwrites an existing
# file — all per-operator customization is preserved.
STOP_HOOK_RULES_DST="/data/.openclaw/workspace/.antitalker/stop-hook-rules.yaml"
STOP_HOOK_RULES_SRC="/app/docker/plugins/her-antitalker-poc/stop-hook-rules.yaml"
if [ ! -f "$STOP_HOOK_RULES_DST" ] && [ -f "$STOP_HOOK_RULES_SRC" ]; then
  mkdir -p "$(dirname "$STOP_HOOK_RULES_DST")"
  cp "$STOP_HOOK_RULES_SRC" "$STOP_HOOK_RULES_DST"
  echo "seeded $STOP_HOOK_RULES_DST from image defaults"
fi

# Start Gateway in foreground
echo "▶ Starting Gateway..."
cd /app
exec node dist/index.js gateway run --port 18789 --bind lan
