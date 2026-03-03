#!/usr/bin/env bash
# 飞书建群 API 可行性测试脚本（无密版本）
# 用法:
#   ./scripts/test-feishu-create-chat.sh --user-id 1
#   ./scripts/test-feishu-create-chat.sh --user-id 1 --csv /path/to/users.csv
#
# 说明:
# - 不在脚本内存放任何密钥
# - 凭据仅从 users.csv 读取（id, ..., feishu_app_id, feishu_app_secret, feishu_owner_open_id）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CSV_PATH="$REPO_ROOT/docker/users.csv"
USER_ID=""
BASE="https://open.feishu.cn/open-apis"

usage() {
  cat <<'EOF'
用法:
  ./scripts/test-feishu-create-chat.sh --user-id <id> [--csv <path>]

参数:
  --user-id   必填。读取 users.csv 的哪一行（第一列 id）
  --csv       可选。users.csv 路径，默认 docker/users.csv
  -h, --help  显示帮助
EOF
}

mask() {
  local value="$1"
  local size=${#value}
  if (( size <= 8 )); then
    printf '%*s' "$size" '' | tr ' ' '*'
    return
  fi
  echo "${value:0:4}...${value: -4}"
}

json_get() {
  local key_path="$1"
  python3 -c '
import json
import sys

key_path = sys.argv[1]
raw = sys.stdin.read()
if not raw.strip():
    print("")
    sys.exit(0)

try:
    data = json.loads(raw)
except json.JSONDecodeError:
    print("")
    sys.exit(0)

cur = data
for part in key_path.split("."):
    if isinstance(cur, dict) and part in cur:
        cur = cur[part]
    else:
        print("")
        sys.exit(0)

if cur is None:
    print("")
elif isinstance(cur, (dict, list)):
    print(json.dumps(cur, ensure_ascii=False))
else:
    print(str(cur))
' "$key_path"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user-id)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --user-id 缺少参数"
        exit 1
      fi
      USER_ID="$2"
      shift 2
      ;;
    --csv)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --csv 缺少参数"
        exit 1
      fi
      CSV_PATH="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: 未知参数: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$USER_ID" ]]; then
  echo "ERROR: 必须提供 --user-id"
  usage
  exit 1
fi

if [[ ! -f "$CSV_PATH" ]]; then
  echo "ERROR: users.csv 不存在: $CSV_PATH"
  exit 1
fi

IFS=$'\t' read -r APP_ID APP_SECRET OWNER_OPEN_ID < <(
  python3 - "$CSV_PATH" "$USER_ID" <<'PY'
import csv
import sys

csv_path = sys.argv[1]
user_id = sys.argv[2]

with open(csv_path, "r", encoding="utf-8", newline="") as f:
    reader = csv.reader(f)
    for row in reader:
        if not row:
            continue
        if row[0].strip().startswith("#"):
            continue
        if row[0].strip() != user_id:
            continue
        if len(row) < 6:
            print(f"ERROR: users.csv id={user_id} 行列数不足（至少 6 列）", file=sys.stderr)
            sys.exit(2)

        app_id = row[3].strip()
        app_secret = row[4].strip()
        owner_open_id = row[5].strip().split("|")[0].strip()

        if not app_id:
            print(f"ERROR: users.csv id={user_id} 的 feishu_app_id 为空", file=sys.stderr)
            sys.exit(2)
        if not app_secret:
            print(f"ERROR: users.csv id={user_id} 的 feishu_app_secret 为空", file=sys.stderr)
            sys.exit(2)
        if not owner_open_id:
            print(f"ERROR: users.csv id={user_id} 的 feishu_owner_open_id 为空", file=sys.stderr)
            sys.exit(2)

        print(f"{app_id}\t{app_secret}\t{owner_open_id}")
        sys.exit(0)

print(f"ERROR: users.csv 中未找到 id={user_id}", file=sys.stderr)
sys.exit(2)
PY
)

echo "=== 飞书建群 API 可行性测试（无密） ==="
echo "user_id=$USER_ID csv=$CSV_PATH"
echo "app_id=$(mask "$APP_ID") owner_open_id=$(mask "$OWNER_OPEN_ID")"
echo ""

echo ">>> Step 1: 获取 tenant_access_token"
TOKEN_RESP="$(curl -sS -X POST "$BASE/auth/v3/tenant_access_token/internal" \
  -H "Content-Type: application/json" \
  -d "{\"app_id\":\"$APP_ID\",\"app_secret\":\"$APP_SECRET\"}")"

TOKEN="$(printf '%s' "$TOKEN_RESP" | json_get "tenant_access_token")"
TOKEN_CODE="$(printf '%s' "$TOKEN_RESP" | json_get "code")"
TOKEN_MSG="$(printf '%s' "$TOKEN_RESP" | json_get "msg")"
if [[ -z "$TOKEN" ]]; then
  echo "FAIL: 无法获取 tenant_access_token code=${TOKEN_CODE:-N/A} msg=${TOKEN_MSG:-N/A}"
  exit 1
fi
echo "OK: token = ${TOKEN:0:20}..."
echo ""

echo ">>> Step 2: 创建群聊（bot 作为群主）"
CREATE_RESP="$(curl -sS -X POST "$BASE/im/v1/chats?user_id_type=open_id" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"Her建群测试-可删除-$(date +%H%M%S)\",
    \"description\": \"API可行性测试群，验证后请删除\",
    \"chat_type\": \"private\",
    \"chat_mode\": \"group\"
  }")"

CREATE_CODE="$(printf '%s' "$CREATE_RESP" | json_get "code")"
CREATE_MSG="$(printf '%s' "$CREATE_RESP" | json_get "msg")"
if [[ "$CREATE_CODE" != "0" ]]; then
  echo "FAIL: 建群失败 code=$CREATE_CODE msg=$CREATE_MSG"
  exit 1
fi

CHAT_ID="$(printf '%s' "$CREATE_RESP" | json_get "data.chat_id")"
CHAT_NAME="$(printf '%s' "$CREATE_RESP" | json_get "data.name")"
if [[ -z "$CHAT_ID" ]]; then
  echo "FAIL: 建群返回缺少 chat_id"
  exit 1
fi
echo "OK: 建群成功"
echo "  chat_id = $CHAT_ID"
echo "  name = $CHAT_NAME"
echo ""

echo ">>> Step 3: 查看群详情（确认群主）"
INFO_RESP="$(curl -sS -X GET "$BASE/im/v1/chats/$CHAT_ID?user_id_type=open_id" \
  -H "Authorization: Bearer $TOKEN")"
INFO_CODE="$(printf '%s' "$INFO_RESP" | json_get "code")"
INFO_MSG="$(printf '%s' "$INFO_RESP" | json_get "msg")"
if [[ "$INFO_CODE" != "0" ]]; then
  echo "FAIL: 获取群详情失败 code=$INFO_CODE msg=$INFO_MSG"
  exit 1
fi
OWNER_ID="$(printf '%s' "$INFO_RESP" | json_get "data.owner_id")"
BOT_COUNT="$(printf '%s' "$INFO_RESP" | json_get "data.bot_count")"
echo "OK: 群详情获取成功"
echo "  owner_id = ${OWNER_ID:-bot(字段可能为空)}"
echo "  bot_count = ${BOT_COUNT:-N/A}"
echo ""

echo ">>> Step 4: 拉用户入群 (owner: $OWNER_OPEN_ID)"
ADD_RESP="$(curl -sS -X POST "$BASE/im/v1/chats/$CHAT_ID/members?member_id_type=open_id" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"id_list\":[\"$OWNER_OPEN_ID\"]}")"
ADD_CODE="$(printf '%s' "$ADD_RESP" | json_get "code")"
ADD_MSG="$(printf '%s' "$ADD_RESP" | json_get "msg")"
if [[ "$ADD_CODE" != "0" ]]; then
  echo "FAIL: 拉用户入群失败 code=$ADD_CODE msg=$ADD_MSG"
  exit 1
fi
echo "OK: 拉用户入群成功"
echo ""

echo ">>> Step 5: 在群里发送测试消息"
SEND_RESP="$(curl -sS -X POST "$BASE/im/v1/messages?receive_id_type=chat_id" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"receive_id\": \"$CHAT_ID\",
    \"msg_type\": \"text\",
    \"content\": \"{\\\"text\\\":\\\"建群测试成功！我是群主 bot。这条消息稍后会撤回。\\\"}\"
  }")"
SEND_CODE="$(printf '%s' "$SEND_RESP" | json_get "code")"
SEND_MSG="$(printf '%s' "$SEND_RESP" | json_get "msg")"
if [[ "$SEND_CODE" != "0" ]]; then
  echo "FAIL: 发送消息失败 code=$SEND_CODE msg=$SEND_MSG"
  exit 1
fi
MSG_ID="$(printf '%s' "$SEND_RESP" | json_get "data.message_id")"
if [[ -z "$MSG_ID" ]]; then
  echo "FAIL: 发送成功但返回缺少 message_id"
  exit 1
fi
echo "OK: 发送成功 message_id=$MSG_ID"
echo ""

echo ">>> Step 6: 撤回 bot 自己刚发的消息"
sleep 2
DEL_RESP="$(curl -sS -X DELETE "$BASE/im/v1/messages/$MSG_ID" \
  -H "Authorization: Bearer $TOKEN")"
DEL_CODE="$(printf '%s' "$DEL_RESP" | json_get "code")"
DEL_MSG="$(printf '%s' "$DEL_RESP" | json_get "msg")"
if [[ "$DEL_CODE" != "0" ]]; then
  echo "FAIL: 撤回消息失败 code=$DEL_CODE msg=$DEL_MSG"
  exit 1
fi
echo "OK: 撤回自己的消息成功"
echo ""

echo "========================================="
echo "测试完成（全部通过）"
echo "  建群:        PASS ($CHAT_ID)"
echo "  拉人:        PASS"
echo "  发消息:      PASS ($MSG_ID)"
echo "  撤回消息:    PASS"
echo ""
echo "清理提示："
echo "  若需删除测试群，可执行："
echo "  curl -X DELETE '$BASE/im/v1/chats/$CHAT_ID' -H 'Authorization: Bearer <TENANT_ACCESS_TOKEN>'"
echo "========================================="
