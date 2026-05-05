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
if [ ! -d "$LARK_PKG" ] || [ "${CARHER_FORCE_PLUGIN_INSTALL:-}" = "1" ]; then
  echo "▶ Installing @larksuite/openclaw-lark@${LARK_WANT}..."
  npm install --prefix "$PLUGIN_DIR" "@larksuite/openclaw-lark@${LARK_WANT}" --omit=dev 2>&1 | tail -3
  echo "  ✓ openclaw-lark installed"
else
  echo "  ✓ openclaw-lark already installed"
fi

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
    const cur = JSON.stringify(m.contracts?.tools ?? []);
    const want = JSON.stringify(TOOLS);
    if (cur !== want) {
      m.contracts = { ...m.contracts, tools: TOOLS };
      fs.writeFileSync('$FEISHU_HER_MANIFEST', JSON.stringify(m, null, 2));
      console.log('    ✓ contracts.tools updated (' + TOOLS.length + ' tools)');
    } else {
      console.log('    ✓ contracts.tools already correct (' + TOOLS.length + ' tools)');
    }
  "
fi
# ── end feishu-her 0503 compat ───────────────────────────────────

# ── a2a-gateway 0503 compat: declare activation + contracts.tools ─
A2A_MANIFEST="/app/docker/plugins/a2a-gateway/openclaw.plugin.json"
if [ -f "$A2A_MANIFEST" ]; then
  echo "  ▶ Ensuring a2a-gateway manifest has contracts.tools..."
  node -e "
    const fs = require('fs');
    const m = JSON.parse(fs.readFileSync('$A2A_MANIFEST', 'utf8'));
    let changed = false;
    if (!m.activation) { m.activation = { onStartup: true }; changed = true; }
    const want = ['a2a_send', 'a2a_send_file'];
    if (JSON.stringify(m.contracts?.tools) !== JSON.stringify(want)) {
      m.contracts = { ...m.contracts, tools: want };
      changed = true;
    }
    if (changed) {
      fs.writeFileSync('$A2A_MANIFEST', JSON.stringify(m, null, 2));
      console.log('    ✓ a2a-gateway manifest patched (activation + contracts.tools)');
    } else {
      console.log('    ✓ a2a-gateway manifest already correct');
    }
  "
fi
# ── end a2a-gateway 0503 compat ──────────────────────────────────

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

# Start Gateway in foreground
echo "▶ Starting Gateway..."
cd /app
exec node dist/index.js gateway run --port 18789 --bind lan
