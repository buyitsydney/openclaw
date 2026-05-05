# ACP (Claude Code) 开启指南

## 概述

ACP 让 Her 能调度 Claude Code 子进程执行代码任务（读写文件、跑脚本、搜索等）。通过 acpx 插件桥接，按需开启，不影响未开启的容器。

## 架构

```
Her (main session) → ACP plugin → acpx → Claude Code CLI → 执行任务 → 结果回传
```

- **acpx**：ACP 运行时，管理 Claude Code session 生命周期
- **Claude Code**：Anthropic 官方 CLI，在容器内执行代码任务
- **litellm 代理**：转发 API 请求到网宿 Anthropic API

## 开启步骤

### 1. server.env 添加 API 凭证（每台服务器一次）

```bash
# 追加到 /Data/CarHer/docker/server.env
ANTHROPIC_BASE_URL=https://litellm.carher.net
ANTHROPIC_AUTH_TOKEN=sk-5VnGHyR9WLzbLpvCgdFZEw
```

compose 会自动 `source server.env` 读取这些变量。

### 2. 启动容器时传 CARHER_ACP_ENABLED=1

```bash
# 从 worktree 启动（灰度）
cd /tmp/skills-two-layer
CARHER_ACP_ENABLED=1 CARHER_MEMORY_LIMIT=4g \
./compose --id=N --image=carher:acp-test

# 如果同时需要 A2A outbound（通常只有 docker-13）
CARHER_ACP_ENABLED=1 CARHER_MEMORY_LIMIT=8g A2A_OUTBOUND=1 \
./compose --id=13 --image=carher:acp-test
```

### 3. 验证

```bash
# 检查 ACP 就绪
docker logs carher-N --since=30s | grep "acpx.*ready"

# 检查 Claude Code 版本
docker exec carher-N claude --version

# 检查 settings.json
docker exec carher-N cat /data/.claude/settings.json

# 检查 credentials.json
docker exec carher-N cat /data/.claude/.credentials.json
```

## 不开启 ACP 的容器

不传 `CARHER_ACP_ENABLED` 即可，entrypoint 里所有 ACP 逻辑都在 `if CARHER_ACP_ENABLED=1` 条件内，零影响。

```bash
# 普通容器（无 ACP）
./compose --id=N --image=carher:acp-test
```

## entrypoint 自动完成的事

当 `CARHER_ACP_ENABLED=1` 时，entrypoint 自动：

1. 安装 Claude Code CLI（`npm install -g @anthropic-ai/claude-code`）
2. 安装 acpx（版本检查，不匹配则重装）
3. 生成 claude wrapper（注入 API 凭证）
4. 生成 `/data/.claude/settings.json`（权限配置）
5. 生成 `/data/.claude/.credentials.json`（API 认证）
6. 修复 dist-runtime SKILL.md symlink 问题
7. 清理 stale acpx session

所有安装到 `/data/.openclaw/local/`（persistent volume），容器重启不丢失。

## settings.json 说明

```json
{
  "model": "anthropic.claude-opus-4-6",
  "sandbox": { "enabled": false },
  "permissions": {
    "defaultMode": "acceptEdits",
    "allow": [
      "Bash(*)",
      "Read(*)",
      "Write(*)",
      "Edit(*)",
      "Glob(*)",
      "Grep(*)",
      "WebSearch(*)",
      "WebFetch(*)"
    ]
  }
}
```

- `sandbox.enabled: false`：Docker 容器内没有 bubblewrap，必须关闭沙箱，否则 exec 报 `exec host not allowed (requested sandbox)`
- `defaultMode: acceptEdits`：自动批准文件编辑和常用命令
- `Bash(*)`：`(*)` 通配符表示允许所有参数

## 已知问题

### WebFetch 401

Claude Code 的 WebFetch 工具内部硬编码调用 `claude-haiku-4-5-20251001`（带日期后缀），但 litellm 代理只认 `anthropic.claude-haiku-4-5`（不带日期后缀）。

**修复**：在 litellm 配置里加模型别名映射 `claude-haiku-4-5-20251001` -> `anthropic.claude-haiku-4-5`。

**临时绕过**：Claude Code 可用 `curl`/`wget` 替代 WebFetch。

### ACP 进程泄漏

Her 可能同时启动多个 acpx session。\_watchdog.md 里有铁律"一次最多1个acpx进程"，但 Her 不一定遵守。监控：

```bash
docker exec carher-N ps aux | grep -E "acpx|claude" | grep -v grep
```

### 内存建议

- 无 ACP：2G 够用
- 有 ACP：建议 4G-8G（每个 Claude Code 进程约 200M）

## 回滚

```bash
# 回到无 ACP 的 carher:local
cd /Data/CarHer && ./compose --id=N
```

## 当前灰度状态

| Bot                | 服务器   | ACP  | Image                                   |
| ------------------ | -------- | ---- | --------------------------------------- |
| docker-13 (卜弋天) | S1       | 开启 | carher:acp-test                         |
| docker-14 (刘国现) | S3       | 开启 | carher:acp-test                         |
| 其他所有           | S1/S2/S3 | 关闭 | carher:local 或 carher:skills-two-layer |
