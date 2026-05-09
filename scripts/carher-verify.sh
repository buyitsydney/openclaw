#!/usr/bin/env bash
# carher-verify.sh — CarHer 容器升级后自检
#
# 对指定 carher-N 容器跑一组 gate 检查,判断升级是否成功。
# 取代纯人工 grep 日志,可脚本化回滚触发。
#
# 用法:
#   scripts/carher-verify.sh --id=102
#   scripts/carher-verify.sh --container=carher-102
#   scripts/carher-verify.sh --id=102 --wait=60     # 最多等 60s
#
# Exit codes:
#   0  全部 gate 通过
#   1  参数错误
#   2  容器不存在或未运行
#   3  有 gate 失败(见输出)

set -uo pipefail

# 关闭 pipefail 只在 grep -q 扫描时 —— grep -q 匹配即退出,上游 docker logs 被 SIGPIPE(141)
# 关掉 pipefail 避免误报失败,但 -u 保留(未定义变量仍然报错)
set +o pipefail

CONTAINER=""
ID=""
WAIT_SECS=60
SINCE="5m"

usage() {
    cat <<EOF
用法: $0 (--id=N | --container=NAME) [--wait=SECS] [--since=DUR]

参数:
    --id=N           用户编号,组合为 carher-N
    --container=NAME 直接给容器名
    --wait=SECS      等 gateway ready 的最大秒数(默认 60)
    --since=DUR      只看最近多久的日志(默认 5m)

示例:
    $0 --id=102
    $0 --container=carher-102 --wait=90
EOF
    exit 1
}

for arg in "$@"; do
    case "$arg" in
        --id=*) ID="${arg#*=}" ;;
        --container=*) CONTAINER="${arg#*=}" ;;
        --wait=*) WAIT_SECS="${arg#*=}" ;;
        --since=*) SINCE="${arg#*=}" ;;
        -h|--help) usage ;;
        *) echo "未知参数: $arg" >&2; usage ;;
    esac
done

if [[ -n "$ID" && -z "$CONTAINER" ]]; then
    CONTAINER="carher-$ID"
fi

if [[ -z "$CONTAINER" ]]; then
    echo "必须提供 --id 或 --container" >&2
    usage
fi

# ============================================================
# 前置:容器存在且运行中
# ============================================================

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "❌ 容器 $CONTAINER 未运行"
    docker ps -a --filter "name=$CONTAINER" --format 'table {{.Names}}\t{{.Status}}'
    exit 2
fi

echo "=== CarHer 升级后自检: $CONTAINER ==="
echo ""

PASS=0
FAIL=0
WARN=0
FAILED_GATES=()

gate_pass() { echo "✅ $1"; PASS=$((PASS+1)); }
gate_fail() { echo "❌ $1"; FAIL=$((FAIL+1)); FAILED_GATES+=("$1"); }
gate_warn() { echo "⚠️  $1"; WARN=$((WARN+1)); }

# 全量日志 —— 用于查启动一次性事件(ready / websocket init 等)
logs_all() { docker logs "$CONTAINER" 2>&1; }
# 近期日志 —— 用于查错误/崩溃(avoid 老错误误伤)
logs() { docker logs "$CONTAINER" --since="$SINCE" 2>&1; }

# ============================================================
# Gate 1: 等 gateway ready(可能启动中)
# ============================================================

echo "--- Gate 1: gateway ready (最多等 ${WAIT_SECS}s) ---"
READY=false
elapsed=0
while [[ $elapsed -lt $WAIT_SECS ]]; do
    if logs_all | grep -qE '\[gateway\].*ready'; then
        READY=true
        break
    fi
    sleep 3
    elapsed=$((elapsed + 3))
    echo "  ...等待中 ${elapsed}s"
done

if $READY; then
    line=$(logs_all | grep -E '\[gateway\].*ready' | tail -1)
    gate_pass "gateway ready: $line"
else
    gate_fail "gateway 在 ${WAIT_SECS}s 内未 ready"
    # gateway 没起来后续检查都没意义
    echo ""
    echo "=== 结果: 早退 ==="
    echo "最近 30 行日志:"
    logs_all | tail -30
    exit 3
fi

# ============================================================
# Gate 2: plugin 数量符合预期(A+B 架构应为 7)
# ============================================================

echo ""
echo "--- Gate 2: plugin 数量 ---"
plugins_line=$(logs_all | grep -E '\[gateway\].*ready.*plugins' | tail -1)
if [[ -n "$plugins_line" ]]; then
    count=$(echo "$plugins_line" | grep -oE '[0-9]+ plugins' | grep -oE '[0-9]+' | head -1)
    if [[ "$count" -ge 7 ]]; then
        gate_pass "plugin count=$count (≥7)"
    else
        gate_fail "plugin count=$count (预期 ≥7,A+B 架构应含 a2a-gateway+acpx+device-pair+feishu-her+memory-wiki+phone-control+talk-voice)"
    fi
else
    gate_warn "未从 ready 行解析到 plugin count"
fi

# ============================================================
# Gate 3: feishu websocket 初始化
# ============================================================

echo ""
echo "--- Gate 3: feishu websocket initialized ---"
if logs_all | grep -qE 'feishu.*(WSClient connected|starting WebSocket connection)'; then
    gate_pass "feishu websocket initialized"
else
    gate_fail "feishu websocket 未初始化(检查 tenant_access_token / appId / botOpenId)"
fi

# ============================================================
# Gate 4: a2a-gateway peers 发现
# ============================================================

echo ""
echo "--- Gate 4: a2a-gateway peers ---"
# peers 是周期性事件,用 logs(近期)即可
peers_line=$(logs | grep -E 'a2a-gateway.*refreshRegistryPeers.*found' | tail -1)
if [[ -n "$peers_line" ]]; then
    peers=$(echo "$peers_line" | grep -oE 'found [0-9]+' | grep -oE '[0-9]+' | head -1)
    if [[ "$peers" -gt 0 ]]; then
        gate_pass "A2A peers=$peers"
    else
        gate_warn "A2A peers=0 (如果此容器是单机独跑可忽略;多机部署需查 Redis/REDIS_URL)"
    fi
else
    gate_warn "未找到 refreshRegistryPeers 日志(a2a-gateway 可能没启用)"
fi

# ============================================================
# Gate 5: acpx runtime backend ready
# ============================================================

echo ""
echo "--- Gate 5: acpx runtime ---"
if logs_all | grep -qE 'acpx runtime backend ready|embedded acpx'; then
    gate_pass "acpx runtime backend ready"
else
    gate_warn "acpx runtime 未 ready (如果此用户未开 CARHER_ACP_ENABLED 可忽略)"
fi

# ============================================================
# Gate 6: 无 plugin validation / schema 错误
# ============================================================

echo ""
echo "--- Gate 6: 无 plugin 契约错误 ---"
# 契约错误从启动期就会出现,用全量日志
if logs_all | grep -qiE 'plugin (validation|schema) (failed|error|mismatch)|manifest validation failed|additionalProperties not allowed'; then
    offenders=$(logs_all | grep -iE 'plugin (validation|schema) (failed|error|mismatch)|manifest validation failed|additionalProperties not allowed' | head -3)
    gate_fail "plugin 契约错误 —— 出现 drift"
    echo "$offenders" | sed 's/^/    /'
else
    gate_pass "无 plugin 契约错误"
fi

# ============================================================
# Gate 7: openclaw-lark channel-only 生效
# ============================================================

echo ""
echo "--- Gate 7: openclaw-lark channel-only ---"
if docker exec "$CONTAINER" node -e '
const fs = require("fs");
const p = "/data/.openclaw/extensions/node_modules/@larksuite/openclaw-lark/openclaw.plugin.json";
const m = JSON.parse(fs.readFileSync(p, "utf8"));
const tools = Array.isArray(m.contracts && m.contracts.tools) ? m.contracts.tools.length : -1;
const skills = Array.isArray(m.skills) ? m.skills.length : -1;
if (tools === 0 && skills === 0) process.exit(0);
console.error(`tools=${tools} skills=${skills}`);
process.exit(1);
' >/tmp/carher-verify-channel-only.$$ 2>&1; then
    gate_pass "openclaw-lark 已剥离为 channel-only"
else
    detail=$(cat /tmp/carher-verify-channel-only.$$ 2>/dev/null || true)
    gate_fail "openclaw-lark channel-only 未生效: $detail"
fi
rm -f /tmp/carher-verify-channel-only.$$ 2>/dev/null || true

# ============================================================
# Gate 8: CarHer runtime patch markers 完整
# ============================================================

echo ""
echo "--- Gate 8: CarHer runtime patch markers ---"
marker_report=$(docker exec "$CONTAINER" bash -lc '
set -u
dispatch=/data/.openclaw/extensions/node_modules/@larksuite/openclaw-lark/src/messaging/inbound/dispatch.js
fail=0
check() {
  local name="$1"
  local pattern="$2"
  local target="$3"
  if grep -q "$pattern" $target 2>/dev/null; then
    echo "$name=OK"
  else
    echo "$name=MISS"
    fail=1
  fi
}
check command-body CARHER_COMMAND_BODY_NORMALIZE_PATCH_V2_MARKER "$dispatch"
check history-fill CARHER_HISTORY_FILL_PATCH_MARKER "$dispatch"
check history-meta-dispatch CARHER_HISTORY_META_PATCH_MARKER "$dispatch"
check inbound-meta-dist CARHER_INBOUND_HISTORY_META_PATCH_MARKER "/app/dist/get-reply-*.js"
check session-decay CARHER_SESSION_DECAY_PATCH_MARKER "/app/dist/manager-*.js"
exit "$fail"
' 2>&1)
if [[ $? -eq 0 ]]; then
    gate_pass "runtime patch markers 完整"
else
    gate_fail "runtime patch markers 缺失"
fi
echo "$marker_report" | sed 's/^/    /'

# ============================================================
# Gate 9: a2a-gateway 的 ioredis native 模块存在
# ============================================================

echo ""
echo "--- Gate 9: a2a-gateway ioredis 依赖 ---"
if docker exec "$CONTAINER" test -f /app/docker/plugins/a2a-gateway/node_modules/ioredis/package.json 2>/dev/null; then
    gate_pass "a2a-gateway ioredis 安装完整"
else
    gate_warn "a2a-gateway ioredis 缺失(npm install 可能失败被忽略;peers 会为 0)"
fi

# ============================================================
# Gate 10: feishu-her node_modules 存在
# ============================================================

echo ""
echo "--- Gate 10: feishu-her 依赖 ---"
if docker exec "$CONTAINER" test -d /app/docker/plugins/feishu-her/node_modules/@larksuiteoapi 2>/dev/null; then
    gate_pass "feishu-her @larksuiteoapi 安装完整"
else
    gate_fail "feishu-her @larksuiteoapi 缺失 —— feishu 连接不了"
fi

# ============================================================
# Gate 11: 无严重 error / crash / uncaught exception
# ============================================================

echo ""
echo "--- Gate 11: 无严重运行时错误 ---"
errors=$(logs | grep -iE 'FATAL|uncaught ?exception|unhandledRejection|crash|TypeError.*is not a function' \
    | grep -viE 'expected|test|mock' \
    | head -5)
if [[ -z "$errors" ]]; then
    gate_pass "无严重运行时错误"
else
    gate_fail "发现严重错误"
    echo "$errors" | sed 's/^/    /'
fi

# ============================================================
# 汇总
# ============================================================

echo ""
echo "============================================================"
echo "=== 自检结果: $CONTAINER ==="
echo "  ✅ PASS: $PASS"
echo "  ❌ FAIL: $FAIL"
echo "  ⚠️  WARN: $WARN"
echo "============================================================"

if [[ $FAIL -gt 0 ]]; then
    echo ""
    echo "失败 gate:"
    for g in "${FAILED_GATES[@]}"; do
        echo "  - $g"
    done
    echo ""
    echo "建议立即回滚:"
    echo "  docker rm -f $CONTAINER"
    echo "  ./compose --id=<N> --image=carher-core:<旧 tag>"
    exit 3
fi

if [[ $WARN -gt 0 ]]; then
    echo ""
    echo "(有 warning,请人工判断是否关键)"
fi

exit 0
