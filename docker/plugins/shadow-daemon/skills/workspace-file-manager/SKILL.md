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

## 你给用户的接口(简化版)

只用 `memory/_shadow/_health.json` 这一个文件读 daemon 状态:

```json
{
  "ready": true | false,        // 一切就位可索引?
  "needs": "tools" | "config",  // 没 ready 时,缺什么
  "progress": {
    "converted": 42,            // 已索引文档数
    "pending": 3,               // 排队中
    "errors_recent": 0          // 最近一轮错误
  },
  "watching_dirs": ["docs/", "contracts/"],
  "last_event": "convert_ok docs/foo.pdf",   // 给 Her 当人话感知
  "last_event_ts": "2026-04-27T..."
}
```

**永远不在跟用户的消息里出现**:`idle_no_*`、`reinit_*`、`PYTHONUSERBASE`、`SIGUSR1`、`shadow_daemon.py`、`sys.path`、`USER_SITE`、`/data/.openclaw/python`、`pgrep` 等内部细节。
看到这些 → 你写错了,翻译成产品语言再发。

## 硬规则

- 不编辑 `memory/_shadow/*.md`,daemon 会覆盖
- 不监控:`node_modules`、`.git`、`venv`、`memory`、`state`、隐藏目录
- 用户没显式要求 → 不删原始文件
- 改 `_config.json` 用原子写(写 `.tmp` 再 `os.replace`),不直接覆盖

## 场景路由

读 `_health.json` 看 ready/needs,按用户意图进对应流程:

| 场景 | 用户怎么说 / 触发条件 | 流程 |
|------|------|------|
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
