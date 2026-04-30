---
name: openclaw-logs
description: OpenClaw gateway log file locations, levels, and querying. Use when investigating issues, debugging memory/search/feishu/agent behavior, checking logs, or when the user mentions log, debug, 日志, or asks "what happened".
---

# OpenClaw Logs

## 铁律：先看文件，不要猜

遇到任何问题，**第一步永远是读日志文件**，不是猜测、不是问用户、不是看终端。

## 日志文件

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

- 格式：JSON，每行一条
- **文件级别：DEBUG**（默认就是，不需要任何配置修改）
- 终端级别：INFO（默认，除非 `--verbose`）
- 滚动：按日期，自动清理 24h 前的旧文件
- 代码：`src/logging/logger.ts` → `defaultRollingPathForToday()`，路径 = `resolvePreferredOpenClawTmpDir()` = `/tmp/openclaw/`

## 查询命令

```bash
# 今天的日志
LOG="/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"

# 实时跟踪
tail -f "$LOG"

# 按子系统过滤（memory / feishu / agent 等）
rg '"subsystem":"memory"' "$LOG"

# 按日志级别
rg '"logLevelName":"DEBUG"' "$LOG"

# 统计各级别数量
python3 -c "
import json, collections
counts = collections.Counter()
with open('$LOG') as f:
    for line in f:
        try:
            obj = json.loads(line)
            counts[obj['_meta']['logLevelName']] += 1
        except: pass
for k,v in counts.most_common(): print(f'{k:10s} {v}')
"

# 搜索 memory search 相关
rg 'memory.*search|memory.*sync|memory.*embed' "$LOG"

# 搜索特定关键词（如用户名、消息内容）
rg '杨哥|高老庄' "$LOG"
```

## 日志结构

每行 JSON 包含：

| 字段                 | 说明                                        |
| -------------------- | ------------------------------------------- |
| `0`                  | subsystem 标签，如 `{"subsystem":"memory"}` |
| `1`                  | 结构化数据（对象或字符串）                  |
| `2`                  | 人类可读消息                                |
| `_meta.logLevelName` | `DEBUG` / `INFO` / `WARN` / `ERROR`         |
| `_meta.date`         | ISO 时间戳                                  |
| `time`               | 同上（冗余）                                |

## 常见子系统标签

| subsystem                 | 内容                                     |
| ------------------------- | ---------------------------------------- |
| `memory`                  | memory search、sync、embedding、indexing |
| `gateway/channels/feishu` | 飞书消息收发                             |
| `agent`                   | agent 调用、tool use                     |
| `gateway`                 | HTTP/WS 请求                             |

## 配置（通常不需要改）

`openclaw.json` 或 `shared-config.json5` 中：

```json5
logging: {
  level: "debug",        // 文件级别（默认已是 debug）
  consoleLevel: "info",  // 终端级别（默认 info）
  file: "/tmp/openclaw/openclaw-2026-02-19.log",  // 自动生成，通常不需要手动设
  consoleStyle: "pretty", // pretty | compact | json
}
```

## Docker 容器日志

Docker 用户容器的日志通过 `docker logs` 查看：

```bash
cd deploy/carher-101 && docker compose logs -f carher   # 跟踪容器日志
docker logs carher-101 --tail 50                        # 最近 50 行
```

容器内的文件日志在 Docker volume 内，路径同上 `/tmp/openclaw/openclaw-YYYY-MM-DD.log`，可通过 `docker exec` 访问：

```bash
docker exec carher-101 rg 'memory' /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log
```
