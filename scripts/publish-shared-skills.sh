#!/bin/bash
#
# 全员 skills 管理：查看本地 + 推送到服务器
#
# 全员 skills 存放在 ~/.openclaw/skills/，通过 bind mount 同步到所有 Docker 容器。
# 本脚本把 Mac 本地的全员 skills 推送到所有服务器，保持一致。
# 不需要重建容器，推送后用户 /new 即可加载新 skill。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SKILLS_DIR="${HOME}/.openclaw/skills"
SERVERS_FILE="${REPO_ROOT}/docker/servers.txt"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

usage() {
  cat <<EOF
全员 Skills 管理

用法:
  ./scripts/publish-shared-skills.sh list      列出本地全员 skills
  ./scripts/publish-shared-skills.sh push      推送到所有服务器（rsync --delete）
  ./scripts/publish-shared-skills.sh diff      对比本地和服务器的差异
  ./scripts/publish-shared-skills.sh push-one <skill>  只推送单个 skill
  ./scripts/publish-shared-skills.sh diff-one <skill>  只对比单个 skill

本地目录: ~/.openclaw/skills/
EOF
}

require_sshpass() {
  if ! command -v sshpass &>/dev/null; then
    echo -e "${RED}✗ 需要 sshpass: brew install hudochenkov/sshpass/sshpass${NC}"
    exit 1
  fi
}

validate_skill_name() {
  local skill_name="$1"
  if [[ ! "$skill_name" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo -e "${RED}✗ skill 名称非法: ${skill_name}${NC}"
    exit 1
  fi
}

require_servers_file() {
  if [ ! -f "$SERVERS_FILE" ]; then
    echo -e "${RED}✗ 服务器配置不存在: ${SERVERS_FILE}${NC}"
    exit 1
  fi
}

skill_summary_line() {
  local dir="$1"
  local name="$2"
  if [ ! -f "${dir}/SKILL.md" ]; then
    echo "  ${name} (missing)"
    return
  fi
  local lines
  lines=$(wc -l < "${dir}/SKILL.md" | tr -d ' ')
  echo "  ${name} (${lines} lines)"
}

list_skills() {
  local dir="$1"
  if [ ! -d "$dir" ]; then
    echo -e "${YELLOW}目录不存在: ${dir}${NC}"
    return
  fi
  for d in "$dir"/*/; do
    [ -f "${d}SKILL.md" ] || continue
    local name=$(basename "$d")
    local lines=$(wc -l < "${d}SKILL.md" | tr -d ' ')
    echo "  ${name} (${lines} lines)"
  done
}

push_to_servers() {
  require_servers_file
  require_sshpass

  local total=0 ok=0

  while IFS=$' \t' read -r ip user pass _rest; do
    [[ "$ip" =~ ^#.*$ || -z "$ip" ]] && continue
    total=$((total + 1))
    echo -e "${CYAN}→ ${ip}${NC}"

    sshpass -p "$pass" ssh -o StrictHostKeyChecking=no "${user}@${ip}" \
      "mkdir -p ~/.openclaw/skills" 2>/dev/null

    if sshpass -p "$pass" rsync -az --delete \
      -e "ssh -o StrictHostKeyChecking=no" \
      "${SKILLS_DIR}/" "${user}@${ip}:~/.openclaw/skills/" 2>/dev/null; then
      ok=$((ok + 1))
      local remote
      remote=$(sshpass -p "$pass" ssh -o StrictHostKeyChecking=no "${user}@${ip}" \
        "ls ~/.openclaw/skills/ 2>/dev/null" | tr '\n' ' ')
      echo -e "${GREEN}  ✓ ${remote}${NC}"
    else
      echo -e "${RED}  ✗ rsync 失败${NC}"
    fi
  done < "$SERVERS_FILE"

  echo ""
  echo -e "${GREEN}完成: ${ok}/${total} 台服务器${NC}"
}

push_one_to_servers() {
  local skill_name="$1"
  validate_skill_name "$skill_name"
  require_servers_file
  require_sshpass

  local local_dir="${SKILLS_DIR}/${skill_name}"
  if [ ! -f "${local_dir}/SKILL.md" ]; then
    echo -e "${RED}✗ 本地 skill 不存在: ${local_dir}${NC}"
    exit 1
  fi

  local total=0 ok=0

  while IFS=$' \t' read -r ip user pass _rest; do
    [[ "$ip" =~ ^#.*$ || -z "$ip" ]] && continue
    total=$((total + 1))
    echo -e "${CYAN}→ ${ip}:${skill_name}${NC}"

    sshpass -p "$pass" ssh -o StrictHostKeyChecking=no "${user}@${ip}" \
      "mkdir -p ~/.openclaw/skills/${skill_name}" 2>/dev/null

    if sshpass -p "$pass" rsync -az --delete \
      -e "ssh -o StrictHostKeyChecking=no" \
      "${local_dir}/" "${user}@${ip}:~/.openclaw/skills/${skill_name}/" 2>/dev/null; then
      ok=$((ok + 1))
      local remote
      remote=$(sshpass -p "$pass" ssh -o StrictHostKeyChecking=no "${user}@${ip}" \
        "if [ -f ~/.openclaw/skills/${skill_name}/SKILL.md ]; then wc -l < ~/.openclaw/skills/${skill_name}/SKILL.md | tr -d ' '; else echo missing; fi")
      echo -e "${GREEN}  ✓ ${skill_name} (${remote} lines)${NC}"
    else
      echo -e "${RED}  ✗ rsync 失败${NC}"
    fi
  done < "$SERVERS_FILE"

  echo ""
  echo -e "${GREEN}完成: ${ok}/${total} 台服务器${NC}"
}

diff_with_servers() {
  require_servers_file
  require_sshpass

  echo -e "${CYAN}本地:${NC}"
  list_skills "$SKILLS_DIR"
  echo ""

  while IFS=$' \t' read -r ip user pass _rest; do
    [[ "$ip" =~ ^#.*$ || -z "$ip" ]] && continue
    echo -e "${CYAN}${ip}:${NC}"
    local remote_list
    remote_list=$(sshpass -p "$pass" ssh -o StrictHostKeyChecking=no "${user}@${ip}" \
      "for d in ~/.openclaw/skills/*/; do [ -f \"\${d}SKILL.md\" ] && echo \"  \$(basename \$d) (\$(wc -l < \"\${d}SKILL.md\" | tr -d ' ') lines)\"; done" 2>/dev/null)
    if [ -z "$remote_list" ]; then
      echo -e "  ${YELLOW}(空)${NC}"
    else
      echo "$remote_list"
    fi
  done < "$SERVERS_FILE"
}

diff_one_with_servers() {
  local skill_name="$1"
  validate_skill_name "$skill_name"
  require_servers_file
  require_sshpass

  echo -e "${CYAN}本地:${NC}"
  skill_summary_line "${SKILLS_DIR}/${skill_name}" "$skill_name"
  echo ""

  while IFS=$' \t' read -r ip user pass _rest; do
    [[ "$ip" =~ ^#.*$ || -z "$ip" ]] && continue
    echo -e "${CYAN}${ip}:${NC}"
    local remote_line
    remote_line=$(sshpass -p "$pass" ssh -o StrictHostKeyChecking=no "${user}@${ip}" \
      "if [ -f ~/.openclaw/skills/${skill_name}/SKILL.md ]; then echo '  ${skill_name} ('\$(wc -l < ~/.openclaw/skills/${skill_name}/SKILL.md | tr -d ' ')' lines)'; else echo '  ${skill_name} (missing)'; fi" 2>/dev/null)
    if [ -z "$remote_line" ]; then
      echo -e "  ${YELLOW}(无法读取)${NC}"
    else
      echo "$remote_line"
    fi
  done < "$SERVERS_FILE"
}

mkdir -p "$SKILLS_DIR"

COMMAND="${1:-}"

case "$COMMAND" in
  list)
    echo -e "${CYAN}本地全员 skills:${NC}"
    list_skills "$SKILLS_DIR"
    ;;
  push)
    echo -e "${CYAN}推送本地全员 skills 到所有服务器${NC}"
    echo ""
    echo -e "本地:"
    list_skills "$SKILLS_DIR"
    echo ""
    push_to_servers
    ;;
  diff)
    diff_with_servers
    ;;
  push-one)
    echo -e "${CYAN}推送单个全员 skill 到所有服务器: ${2:-}${NC}"
    push_one_to_servers "${2:-}"
    ;;
  diff-one)
    diff_one_with_servers "${2:-}"
    ;;
  *)
    usage
    exit 1
    ;;
esac
