---
name: workspace-file-manager
description: |
  用户文档记忆管理。workspace 下的文档由后台 daemon 自动转 markdown，memory_search 可语义召回。
  你控制一切：监控目录、markitdown 安装升级、进度监控、目录建议。daemon 是笨引擎，你是大脑。
  触发场景：用户提到文档索引、文件记忆、文档搜索、整理文件、保存文档、删除记忆、查看文档转换状态。
  首次发现 daemon 未就绪时也会触发。
metadata: { "openclaw": { "emoji": "📄" } }
---

# 用户文档记忆管理

daemon 定时扫描 `_config.json` 指定的目录，用 markitdown 转 markdown 到 `memory/_shadow/`，memory_search 可召回。

## 硬规则

- 不编辑 `memory/_shadow/*.md`，daemon 会覆盖
- 没有 `_config.json` → daemon idle，你必须创建
- 没有 markitdown → daemon 无法转换，你必须安装
- 禁止监控：`node_modules`、`.git`、`venv`、`memory`、`state`、隐藏目录

## 场景路由

读 `memory/_shadow/_health.json` 判断当前状态，然后按场景进入对应流程：

| 场景 | 触发 | 流程 |
|------|------|------|
| daemon 未就绪 | health 缺失、markitdown 未装、无 config | [setup.md](references/setup.md) |
| 用户要索引/保存/记住文档 | "帮我索引这个"、"保存这个文档"、飞书文件 | [index-document.md](references/index-document.md) |
| 用户要删除文档记忆 | "删掉这个记忆"、"不要记这个了" | [delete-memory.md](references/delete-memory.md) |
| 用户要管理目录/查状态/升级 | "加个目录"、"转换进度"、"升级工具" | [manage-directories.md](references/manage-directories.md) |
| 需要确认支持的文件类型 | "支持 RAR 吗"、转换失败排查 | [supported-formats.md](references/supported-formats.md) |
