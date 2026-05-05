#!/bin/bash
# 生成 cloudflared 隧道配置 — 预配置所有用户 ingress 规则
#
# 用法:
#   ./scripts/generate-tunnel-config.sh              # 生成 200 用户配置（默认）
#   ./scripts/generate-tunnel-config.sh --max=50     # 自定义最大用户数
#   ./scripts/generate-tunnel-config.sh --dry-run    # 预览不写入
#
# 生成后需重启隧道生效: ./start-tunnel.sh --restart
# DNS 前置条件: 在 Cloudflare DNS 添加一条通配符记录
#   *.carher.net  CNAME  <tunnel-id>.cfargotunnel.com
#
# 之后无论新增多少用户，DNS 和 cloudflared 都不需要再改。

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

CONFIG_DIR="$HOME/.cloudflared"
CONFIG_FILE="${CONFIG_DIR}/config.yml"
MAX_USERS=200
DRY_RUN=""

for arg in "$@"; do
  case "$arg" in
    --max=*) MAX_USERS="${arg#--max=}" ;;
    --dry-run) DRY_RUN="yes" ;;
    -h|--help)
      echo "用法: ./scripts/generate-tunnel-config.sh [--max=N] [--dry-run]"
      echo ""
      echo "  --max=N     最大用户数（默认 200）"
      echo "  --dry-run   预览不写入"
      echo ""
      echo "生成后重启隧道生效: ./start-tunnel.sh --restart"
      exit 0
      ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

# 验证现有配置（获取 tunnel 名和凭证路径）
if [ ! -f "$CONFIG_FILE" ]; then
  echo -e "${RED}✗ 未找到 ${CONFIG_FILE}${NC}"
  echo "  请先运行: cloudflared tunnel login && cloudflared tunnel create carher"
  exit 1
fi

TUNNEL_NAME=$(grep "^tunnel:" "$CONFIG_FILE" | awk '{print $2}')
CRED_FILE=$(grep "^credentials-file:" "$CONFIG_FILE" | awk '{print $2}')

if [ -z "$TUNNEL_NAME" ] || [ -z "$CRED_FILE" ]; then
  echo -e "${RED}✗ 无法从 ${CONFIG_FILE} 读取 tunnel / credentials-file${NC}"
  exit 1
fi

# 端口规则（和 compose 一致）：
#   base = 29000 + (N-1) * 10
#   FE = base+3, RT = base+2, WS = base+4, OAUTH = base+5
generate_config() {
  cat << EOF
tunnel: ${TUNNEL_NAME}
credentials-file: ${CRED_FILE}
ingress:
  # 个人 Her (RT 端口不暴露，语音通过 FE 代理)
  - hostname: carher.carher.net
    service: http://localhost:8000
  - hostname: proxy.carher.net
    service: http://localhost:8080
  # 厂商别名 (user 2) — vendor.carher.net 指向 FE 代理（RT 内部转发，不直接暴露）
  - hostname: vendor-fe.carher.net
    service: http://localhost:29013
  - hostname: vendor.carher.net
    service: http://localhost:29013
  - hostname: vendor-proxy.carher.net
    service: http://localhost:29014
  - hostname: vendor-auth.carher.net
    service: http://localhost:29015
EOF

  for i in $(seq 1 "$MAX_USERS"); do
    BASE=$((29000 + (i - 1) * 10))
    PORT_FE=$((BASE + 3))
    PORT_WS=$((BASE + 4))
    PORT_OAUTH=$((BASE + 5))
    echo "  - hostname: u${i}-fe.carher.net"
    echo "    service: http://localhost:${PORT_FE}"
    echo "  - hostname: u${i}-proxy.carher.net"
    echo "    service: http://localhost:${PORT_WS}"
    echo "  - hostname: u${i}-auth.carher.net"
    echo "    service: http://localhost:${PORT_OAUTH}"
  done

  cat << EOF
  - service: http_status:404
EOF
}

TOTAL_RULES=$((2 + 4 + MAX_USERS * 3 + 1))

if [ -n "$DRY_RUN" ]; then
  echo -e "${YELLOW}预览模式（不写入文件）${NC}"
  echo "────────────────────────────────────────────"
  generate_config
  echo "────────────────────────────────────────────"
  echo ""
  echo -e "${GREEN}总计: ${TOTAL_RULES} 条 ingress 规则${NC}"
  echo "  个人 Her: 2 条 (FE + Gemini proxy; RT 通过 FE 代理)"
  echo "  厂商别名: 4 条 (FE + vendor.carher.net→FE + Gemini proxy + OAuth)"
  echo "  用户容器: ${MAX_USERS} × 3 = $((MAX_USERS * 3)) 条 (FE + proxy + OAuth)"
  echo "  兜底:     1 条"
else
  # 备份
  cp "$CONFIG_FILE" "${CONFIG_FILE}.bak"
  echo -e "${GREEN}✓ 已备份: ${CONFIG_FILE}.bak${NC}"

  # 写入
  generate_config > "$CONFIG_FILE"
  echo -e "${GREEN}✓ 已生成: ${CONFIG_FILE}${NC}"
  echo ""
  echo -e "  总计: ${GREEN}${TOTAL_RULES}${NC} 条 ingress 规则"
  echo "  个人 Her: 2 条 (FE + Gemini proxy; RT 通过 FE 代理)"
  echo "  厂商别名: 4 条 (FE + vendor.carher.net→FE + Gemini proxy + OAuth)"
  echo "  用户容器: ${MAX_USERS} × 3 = $((MAX_USERS * 3)) 条 (FE + proxy + OAuth)"
  echo "  兜底:     1 条"
  echo ""
  echo -e "${YELLOW}重启隧道生效:${NC} ./start-tunnel.sh --restart"
  echo ""
  echo -e "${YELLOW}DNS 前置条件:${NC} 在 Cloudflare DNS 添加通配符记录:"
  echo "  *.carher.net  CNAME  ${TUNNEL_NAME}.cfargotunnel.com"
fi
