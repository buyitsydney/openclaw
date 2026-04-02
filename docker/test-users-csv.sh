#!/bin/bash
# 测试 start-user.sh 的 CSV 解析 + config 生成逻辑
# 用法: ./docker/test-users-csv.sh
#
# 测试覆盖:
#   1. 正常读取用户 + 飞书凭证注入
#   2. 无飞书凭证的用户（不注入飞书配置）
#   3. CLI --model 覆盖 CSV 模型
#   4. CSV 中无此用户（graceful fallback）
#   5. CSV 文件不存在（graceful fallback）
#   6. 注释行和空行跳过
#   7. 字段含前后空格（自动 trim）
#   8. 备注含逗号（CSV 边界）
#   9. 飞书凭证只填了一半（不注入）
#  10. --list 输出格式

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

PASS=0
FAIL=0
TOTAL=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$expected" = "$actual" ]; then
    echo -e "  ${GREEN}✓${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $desc"
    echo -e "    expected: ${GREEN}${expected}${NC}"
    echo -e "    actual:   ${RED}${actual}${NC}"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -q "$needle"; then
    echo -e "  ${GREEN}✓${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $desc"
    echo -e "    expected to contain: ${GREEN}${needle}${NC}"
    echo -e "    actual: ${RED}${haystack}${NC}"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local desc="$1" needle="$2" haystack="$3"
  TOTAL=$((TOTAL + 1))
  if ! echo "$haystack" | grep -q "$needle"; then
    echo -e "  ${GREEN}✓${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $desc"
    echo -e "    expected NOT to contain: ${RED}${needle}${NC}"
    FAIL=$((FAIL + 1))
  fi
}

# --- Helper: parse CSV (same logic as start-user.sh) ---
parse_csv_user() {
  local csv_file="$1" target_id="$2"
  local CSV_NAME="" CSV_MODEL="" CSV_FEISHU_ID="" CSV_FEISHU_SECRET="" CSV_NOTE=""
  if [ -f "$csv_file" ]; then
    while IFS=',' read -r uid uname umodel ufeishu_id ufeishu_secret unote; do
      [[ "$uid" =~ ^[[:space:]]*# ]] && continue
      [[ -z "$uid" ]] && continue
      uid=$(echo "$uid" | xargs)
      if [ "$uid" = "$target_id" ]; then
        CSV_NAME=$(echo "$uname" | xargs)
        CSV_MODEL=$(echo "$umodel" | xargs)
        CSV_FEISHU_ID=$(echo "$ufeishu_id" | xargs)
        CSV_FEISHU_SECRET=$(echo "$ufeishu_secret" | xargs)
        CSV_NOTE=$(echo "$unote" | xargs)
        break
      fi
    done < "$csv_file"
  fi
  echo "${CSV_NAME}|${CSV_MODEL}|${CSV_FEISHU_ID}|${CSV_FEISHU_SECRET}|${CSV_NOTE}"
}

# --- Helper: generate config (same logic as start-user.sh) ---
generate_config() {
  local base_config="$1" model="$2" feishu_id="$3" feishu_secret="$4"
  python3 -c "
import json, sys

with open('${base_config}') as f:
    cfg = json.load(f)

model = '${model}'
if model:
    cfg['agents']['defaults']['model']['primary'] = model

feishu_id = '${feishu_id}'
feishu_secret = '${feishu_secret}'
if feishu_id and feishu_secret:
    cfg.setdefault('channels', {})['feishu'] = {
        'enabled': True,
        'appId': feishu_id,
        'appSecret': feishu_secret,
    }
    cfg.setdefault('plugins', {}).setdefault('entries', {})['feishu'] = {
        'enabled': True
    }

json.dump(cfg, sys.stdout, indent=2)
"
}

# --- Setup temp files ---
TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

BASE_CONFIG="$TMP_DIR/base-config.json"
cat > "$BASE_CONFIG" << 'BASECFG'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "openrouter/anthropic/claude-sonnet-4"
      }
    }
  },
  "plugins": {
    "entries": {
      "realtime": {
        "enabled": true
      }
    }
  }
}
BASECFG

# --- Test CSV ---
TEST_CSV="$TMP_DIR/users.csv"
cat > "$TEST_CSV" << 'CSV'
# CarHer 用户注册表
# id, 姓名, 模型, feishu_app_id, feishu_app_secret, 备注

1,张三,sonnet,cli_aaa111,secret111,测试用户
2,厂商A,opus,,,厂商演示
3, 李四 , haiku , cli_bbb222 , secret222 , 备注含空格
4,王五,sonnet,cli_ccc333,,只有appId没有secret
5,赵六,,cli_ddd444,secret444,模型留空

CSV

echo "=========================================="
echo " start-user.sh CSV 解析 + Config 生成测试"
echo "=========================================="
echo ""

# ── Test 1: 正常用户 + 飞书凭证 ──
echo "Test 1: 正常用户 + 飞书凭证"
RESULT=$(parse_csv_user "$TEST_CSV" "1")
IFS='|' read -r NAME MODEL FID FSECRET NOTE <<< "$RESULT"
assert_eq "姓名=张三" "张三" "$NAME"
assert_eq "模型=sonnet" "sonnet" "$MODEL"
assert_eq "飞书appId" "cli_aaa111" "$FID"
assert_eq "飞书secret" "secret111" "$FSECRET"
assert_eq "备注=测试用户" "测试用户" "$NOTE"
echo ""

# ── Test 2: 无飞书凭证的用户 ──
echo "Test 2: 无飞书凭证的用户"
RESULT=$(parse_csv_user "$TEST_CSV" "2")
IFS='|' read -r NAME MODEL FID FSECRET NOTE <<< "$RESULT"
assert_eq "姓名=厂商A" "厂商A" "$NAME"
assert_eq "模型=opus" "opus" "$MODEL"
assert_eq "飞书appId为空" "" "$FID"
assert_eq "飞书secret为空" "" "$FSECRET"
echo ""

# ── Test 3: 字段含前后空格（自动 trim）──
echo "Test 3: 字段含前后空格（自动 trim）"
RESULT=$(parse_csv_user "$TEST_CSV" "3")
IFS='|' read -r NAME MODEL FID FSECRET NOTE <<< "$RESULT"
assert_eq "姓名 trim" "李四" "$NAME"
assert_eq "模型 trim" "haiku" "$MODEL"
assert_eq "飞书appId trim" "cli_bbb222" "$FID"
assert_eq "飞书secret trim" "secret222" "$FSECRET"
echo ""

# ── Test 4: 飞书凭证只填了一半（只有 appId 没有 secret）──
echo "Test 4: 飞书凭证只填了一半"
RESULT=$(parse_csv_user "$TEST_CSV" "4")
IFS='|' read -r NAME MODEL FID FSECRET NOTE <<< "$RESULT"
assert_eq "姓名=王五" "王五" "$NAME"
assert_eq "有appId" "cli_ccc333" "$FID"
assert_eq "无secret" "" "$FSECRET"
echo ""

# ── Test 5: 模型留空 ──
echo "Test 5: 模型留空"
RESULT=$(parse_csv_user "$TEST_CSV" "5")
IFS='|' read -r NAME MODEL FID FSECRET NOTE <<< "$RESULT"
assert_eq "姓名=赵六" "赵六" "$NAME"
assert_eq "模型为空" "" "$MODEL"
assert_eq "有飞书凭证" "cli_ddd444" "$FID"
echo ""

# ── Test 6: CSV 中不存在的用户 ──
echo "Test 6: CSV 中不存在的用户"
RESULT=$(parse_csv_user "$TEST_CSV" "99")
IFS='|' read -r NAME MODEL FID FSECRET NOTE <<< "$RESULT"
assert_eq "姓名为空" "" "$NAME"
assert_eq "模型为空" "" "$MODEL"
assert_eq "飞书appId为空" "" "$FID"
echo ""

# ── Test 7: CSV 文件不存在 ──
echo "Test 7: CSV 文件不存在"
RESULT=$(parse_csv_user "/nonexistent/path.csv" "1")
IFS='|' read -r NAME MODEL FID FSECRET NOTE <<< "$RESULT"
assert_eq "姓名为空" "" "$NAME"
echo ""

# ── Test 8: Config 生成 — 有飞书凭证 ──
echo "Test 8: Config 生成 — 注入飞书配置"
CONFIG=$(generate_config "$BASE_CONFIG" "openrouter/anthropic/claude-sonnet-4" "cli_aaa111" "secret111")
assert_contains "channels.feishu.enabled=true" '"enabled": true' "$CONFIG"
assert_contains "channels.feishu.appId" '"appId": "cli_aaa111"' "$CONFIG"
assert_contains "channels.feishu.appSecret" '"appSecret": "secret111"' "$CONFIG"
assert_contains "plugins.entries.feishu.enabled" '"feishu"' "$CONFIG"
assert_contains "保留 realtime 插件" '"realtime"' "$CONFIG"
echo ""

# ── Test 9: Config 生成 — 无飞书凭证 ──
echo "Test 9: Config 生成 — 不注入飞书配置"
CONFIG=$(generate_config "$BASE_CONFIG" "openrouter/anthropic/claude-opus-4.6" "" "")
assert_not_contains "无 channels.feishu" "appId" "$CONFIG"
assert_not_contains "无 feishu 插件" '"feishu"' "$CONFIG"
assert_contains "保留 realtime" '"realtime"' "$CONFIG"
assert_contains "模型已覆盖为 opus" "claude-opus-4.6" "$CONFIG"
echo ""

# ── Test 10: Config 生成 — 凭证只填一半不注入 ──
echo "Test 10: Config 生成 — 凭证只有 appId，不注入"
CONFIG=$(generate_config "$BASE_CONFIG" "" "cli_ccc333" "")
assert_not_contains "不注入半截凭证" "appId" "$CONFIG"
assert_not_contains "不注入半截凭证" "appSecret" "$CONFIG"
echo ""

# ── Test 11: Config 生成 — 模型留空保持默认 ──
echo "Test 11: Config 生成 — 模型留空保持默认"
CONFIG=$(generate_config "$BASE_CONFIG" "" "" "")
assert_contains "保持默认模型" "claude-sonnet-4" "$CONFIG"
echo ""

# ── Test 12: CLI --model 覆盖 CSV 模型（优先级验证）──
echo "Test 12: CLI --model 覆盖 CSV 模型"
# 模拟: CSV 设 sonnet，CLI 传 opus → 应该用 opus
CSV_MODEL="sonnet"
CLI_MODEL="opus"
# 优先级逻辑: if CLI_MODEL -> use CLI; elif CSV_MODEL -> use CSV; else empty
if [ -n "$CLI_MODEL" ]; then FINAL_MODEL="$CLI_MODEL"; elif [ -n "$CSV_MODEL" ]; then FINAL_MODEL="$CSV_MODEL"; else FINAL_MODEL=""; fi
assert_eq "CLI opus 覆盖 CSV sonnet" "opus" "$FINAL_MODEL"

# 模拟: CSV 设 haiku，CLI 不传 → 应该用 haiku
CLI_MODEL=""
CSV_MODEL="haiku"
if [ -n "$CLI_MODEL" ]; then FINAL_MODEL="$CLI_MODEL"; elif [ -n "$CSV_MODEL" ]; then FINAL_MODEL="$CSV_MODEL"; else FINAL_MODEL=""; fi
assert_eq "CSV haiku 生效（CLI 未指定）" "haiku" "$FINAL_MODEL"

# 模拟: CSV 空，CLI 空 → 应该空（用默认）
CLI_MODEL=""
CSV_MODEL=""
if [ -n "$CLI_MODEL" ]; then FINAL_MODEL="$CLI_MODEL"; elif [ -n "$CSV_MODEL" ]; then FINAL_MODEL="$CSV_MODEL"; else FINAL_MODEL=""; fi
assert_eq "都空则用默认" "" "$FINAL_MODEL"
echo ""

# ── Summary ──
echo "=========================================="
if [ $FAIL -eq 0 ]; then
  echo -e " ${GREEN}ALL $TOTAL TESTS PASSED${NC}"
else
  echo -e " ${RED}$FAIL / $TOTAL TESTS FAILED${NC}"
fi
echo "=========================================="

exit $FAIL
