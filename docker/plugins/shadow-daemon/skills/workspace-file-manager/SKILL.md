---
name: workspace-file-manager
description: |
  用户文档记忆管理。workspace 下的文档由后台 daemon 自动转 markdown,memory_search 可语义召回。
  你控制一切:目录建议、工具安装升级、进度监控。daemon 是笨引擎,你是大脑。
  触发场景:用户提到文档索引、文件记忆、文档搜索、整理文件、保存文档、删除记忆、查看文档转换状态。
  首次发现 daemon 未就绪时也会触发。
metadata: { "openclaw": { "emoji": "📄" } }
---

# 用户文档记忆管理

后台 daemon 把 `_config.json` 指定的目录里的文档转 markdown 写到 `memory/_shadow/`,memory_search 召回。
daemon 是 dumb engine,Her 是产品体验层。

## ⭐ 写代码 / 跟用户说话之前必读

[**her-ux-principles.md**](references/her-ux-principles.md) — 10 条体验铁律。
不读直接干 = 把工程接口扔给用户,产品退化。

## 你给用户的接口(唯一入口)

读 `memory/_shadow/_health.json`。**完整字段见 [references/health-schema.md](references/health-schema.md)**。日常只用这几个:

```json
{
  "ready": true | false,             // 一切就位可索引?
  "needs": "tools" | "config" | null, // 没 ready 时缺什么
  "progress": {
    "indexed_now": 42,               // 当前活的 shadow 数(删了文件会降)
    "indexed_total": 150,            // 累计转换过多少次(只增不减,统计用)
    "target_count": 45,              // 当前 daemon 监听范围里的源文件数
    "pct": 93.3,                     // 0-100,累计进度
    "errors_recent": 0               // 最近一轮错误数
  },
  "watching_dirs": ["docs/", "contracts/"],
  "last_event": "convert_ok docs/foo.pdf",  // 人话,给你看
  "recent_events": [{"path":"...","kind":"convert_ok","ts":"..."}],
  "recent_skips":  [{"path":"...","reason":"size","ts":"..."}],
  "recent_errors": [{"path":"...","kind":"encoding_error","ts":"..."}],
  "limits": {
    "max_file_mb": 50,
    "max_output_mb": 5,
    "archive_max_files": 20,
    "extract_timeout_sec": 600
  }
}
```

**关键语义(别混淆)**:
- `indexed_now` 是"**现在有多少 shadow 文件**",给用户看"已索引 N 个"就用这个
- `indexed_total` 是"**daemon 一生转换过几次**",给用户看没意义(删了文件也不会减),只给运维看
- 失败的文件也会生成 **tombstone shadow**(带 `status: encoding_error/mime_mismatch/failed`),这样 daemon 下轮不会重试,memory_search 也不会召回无效内容。所以 `indexed_now` 包含 tombstone;`recent_errors` 里的条目**源文件删除后会自动清理**(daemon 负责)。

**永远不在跟用户的消息里出现**:`idle_no_*`、`reinit_*`、`PYTHONUSERBASE`、`SIGUSR1`、`shadow_daemon.py`、`sys.path`、`USER_SITE`、`/data/.openclaw/python`、`pgrep`、`cumulative_*`、`status`(内部字符串)等内部细节。看到这些 → 你写错了,翻译成产品语言再发。

## 硬规则

- 不编辑 `memory/_shadow/*.md`,daemon 会覆盖
- 不监控目录默认清单(节点粒度):`node_modules`、`.git`、`venv`、`.venv`、`memory`、`state`、`.state`、`archive`、`stress-test`、`carher-*`、`wt-*`、`.worktrees`、`.claude`、`__pycache__`、以 `.` 开头的任何目录
- 不监控文件默认清单(根目录 bootstrap 注入的不重复索引):`SOUL.md`、`MEMORY.md`、`IDENTITY.md`、`USER.md`、`AGENTS.md`、`HEARTBEAT.md`、`CLAUDE.md`、`README.md`(如果是 Her 自己的 readme)— 这些在 Her 启动时已进 context,再让 memory_search 召回一遍等于双轨重复
- 用户没显式要求 → 不删原始文件
- 改 `_config.json` 用原子写(写 `.tmp` 再 `os.replace`),不直接覆盖
- Her persona 工作区特征:根目录一堆 `.md` 配置 + `carher-*/`、`wt-*/` 工作树。**首次扫描时先识别这种工作区,默认只建议监控 `docs/`,其他如 `wiki/` `research/` `projects/` 要让用户逐个确认**

## 场景路由

读 `_health.json` 看 ready/needs,按用户意图进对应流程:

| 场景 | 用户怎么说 / 触发条件 | 流程 |
|------|------|------|
| 🔖 **字段字典(查表)** | 随时查 `_health.json` 字段权威语义 | [health-schema.md](references/health-schema.md) |
| 首次接入 | `ready: false`,或用户说"帮我接 memory_search"/"索引我的文档" | [setup.md](references/setup.md) |
| 加 1 个文档 | "记住这个 PDF"、飞书发文件、"帮我把这个加进 memory" | [index-document.md](references/index-document.md) |
| 删某文档 | "删掉这个记忆"、"忘掉 X 文件" | [delete-memory.md](references/delete-memory.md) |
| 管理目录/状态/升级 | "加个目录"、"daemon 状态"、"升级工具"、"别看 X 了" | [manage-directories.md](references/manage-directories.md) |
| 文件格式问题 | "支持 RAR 吗"、转换失败用户问怎么了 | [supported-formats.md](references/supported-formats.md) |

## 长任务报进度的最低底线

**任何超过 5s 的操作必须按 [her-ux-principles.md](references/her-ux-principles.md) 第 5/6 条节奏报**:
- 开始前预报时间("大约 30s...")
- 中途每 ~10s 或每 25% 报一次
- 完成报数字+耗时+下一步

沉默 30s 不是工作,是产品事故。
