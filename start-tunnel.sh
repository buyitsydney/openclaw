#!/bin/bash
# Cloudflared 隧道管理 — Docker 容器方式（macOS / Ubuntu 通用）
#
# 用法:
#   ./start-tunnel.sh              # 启动隧道（如已运行则显示状态）
#   ./start-tunnel.sh --restart    # 重启隧道
#   ./start-tunnel.sh --down       # 停止隧道
#   ./start-tunnel.sh --logs       # 查看隧道日志
#   ./start-tunnel.sh --status     # 查看隧道状态
#
# 隧道配置: ~/.cloudflared/config.yml（ingress 规则定义域名 → 端口映射）
# 容器使用 --restart unless-stopped，Docker 重启后自动恢复

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

CONTAINER_NAME="cloudflared"
CONFIG_DIR="$HOME/.cloudflared"

ACTION="start"
for arg in "$@"; do
  case "$arg" in
    --restart) ACTION="restart" ;;
    --down|--stop) ACTION="down" ;;
    --logs) ACTION="logs" ;;
    --status) ACTION="status" ;;
    -h|--help)
      echo "用法: ./start-tunnel.sh [--restart] [--down] [--logs] [--status]"
      echo ""
      echo "  (无参数)     启动隧道（如已运行则显示状态）"
      echo "  --restart    重启隧道"
      echo "  --down       停止隧道"
      echo "  --logs       查看隧道日志"
      echo "  --status     查看隧道状态"
      echo ""
      echo "配置文件: ~/.cloudflared/config.yml"
      echo "macOS 和 Ubuntu 命令完全相同。"
      exit 0
      ;;
    *) echo "未知参数: $arg (使用 --help 查看帮助)"; exit 1 ;;
  esac
done

# --- Logs ---
if [ "$ACTION" = "logs" ]; then
  exec docker logs -f "$CONTAINER_NAME" 2>&1
fi

# --- Status ---
show_status() {
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
    local uptime=$(docker ps --filter "name=^${CONTAINER_NAME}$" --format '{{.Status}}')
    echo -e "${GREEN}✓ cloudflared 隧道运行中${NC} ($uptime)"
    return 0
  elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${YELLOW}⚠ cloudflared 容器已停止${NC}"
    return 1
  else
    echo -e "${RED}✗ cloudflared 容器不存在${NC}"
    return 1
  fi
}

if [ "$ACTION" = "status" ]; then
  show_status
  exit 0
fi

# --- Down ---
if [ "$ACTION" = "down" ]; then
  echo -e "${YELLOW}停止 cloudflared 隧道...${NC}"
  docker rm -f "$CONTAINER_NAME" 2>/dev/null && echo -e "${GREEN}✓ 已停止${NC}" || echo "隧道未运行"
  exit 0
fi

# --- Restart ---
if [ "$ACTION" = "restart" ]; then
  echo -e "${YELLOW}重启 cloudflared 隧道...${NC}"
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  # Fall through to start
fi

# --- Start ---
# 如果已在运行，只显示状态
if [ "$ACTION" = "start" ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
  show_status
  echo ""
  echo -e "  重启: ${YELLOW}./start-tunnel.sh --restart${NC}"
  echo -e "  日志: ${YELLOW}./start-tunnel.sh --logs${NC}"
  exit 0
fi

# 检查配置文件
if [ ! -f "${CONFIG_DIR}/config.yml" ]; then
  echo -e "${RED}✗ 未找到隧道配置: ${CONFIG_DIR}/config.yml${NC}"
  echo "  请先运行: cloudflared tunnel login && cloudflared tunnel create carher"
  exit 1
fi

# 检查凭证文件
CRED_FILE=$(grep -o '[a-f0-9-]*\.json' "${CONFIG_DIR}/config.yml" | head -1)
if [ -n "$CRED_FILE" ] && [ ! -f "${CONFIG_DIR}/${CRED_FILE}" ]; then
  echo -e "${RED}✗ 隧道凭证文件缺失: ${CONFIG_DIR}/${CRED_FILE}${NC}"
  exit 1
fi

echo -e "${YELLOW}启动 cloudflared 隧道 (Docker)...${NC}"

# config.yml 中使用 localhost 指向宿主机端口，但 Docker 容器内的
# localhost 指向容器自身。生成一份替换版本，将 localhost 改为
# host.docker.internal（Docker 提供的宿主机别名）。
DOCKER_CONFIG="/tmp/cloudflared-docker-config.yml"
sed 's|localhost|host.docker.internal|g' "${CONFIG_DIR}/config.yml" > "$DOCKER_CONFIG"

docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --add-host=host.docker.internal:host-gateway \
  -v "${CONFIG_DIR}:${CONFIG_DIR}:ro" \
  -v "${DOCKER_CONFIG}:/run/cloudflared-config.yml:ro" \
  cloudflare/cloudflared:latest \
  tunnel --config /run/cloudflared-config.yml run carher

# 等待隧道建立
sleep 2
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo -e "${GREEN}✓ cloudflared 隧道已启动${NC}"
else
  echo -e "${RED}✗ 隧道启动失败${NC}"
  echo -e "  查看日志: ${YELLOW}./start-tunnel.sh --logs${NC}"
  exit 1
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  cloudflared 隧道已启动（Docker，自动保活）${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  管理:"
echo -e "    ${YELLOW}./start-tunnel.sh --status${NC}    查看状态"
echo -e "    ${YELLOW}./start-tunnel.sh --logs${NC}      查看日志"
echo -e "    ${YELLOW}./start-tunnel.sh --restart${NC}   重启"
echo -e "    ${YELLOW}./start-tunnel.sh --down${NC}      停止"
echo ""
echo -e "  容器使用 --restart unless-stopped，Docker 重启后自动恢复"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
