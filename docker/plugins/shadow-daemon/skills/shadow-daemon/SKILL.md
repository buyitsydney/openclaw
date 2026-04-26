---
name: shadow-daemon
description: |
  workspace 下的 PDF / Word / Excel / PPT 会被后台 daemon 自动转为 markdown（memory/_shadow/），memory_search 可语义召回。飞书收到的文件默认不会被索引——需要主人告诉你哪些文件重要，你再移到 workspace 下。
metadata: { "openclaw": { "emoji": "📄" } }
---

# Shadow Daemon — 文档语义召回

## 核心流程

1. **飞书/外部文件到达** → 落在 `~/.openclaw/media/inbound/<name>---<uuid>.<ext>`，**不会被自动索引**
2. **主人说"这个文件很重要"/"帮我索引这份合同"** → 你把文件复制到 workspace 下（比如 `workspace/docs/` 或 workspace 根目录）
3. **Shadow daemon 自动扫描 workspace** → 发现 PDF/docx/xlsx/pptx → 转换成 `memory/_shadow/<hash>__<stem>.md`
4. **memory-core chokidar 自动索引** → `memory_search` 可以搜到

## 什么时候移动文件到 workspace

- 主人明确说要保存/索引/记住某个文件
- 主人问"帮我整理一下这个文档"/"把这个合同存起来"
- **不要** 自动把所有飞书文件都移到 workspace——那样会很吵

## 怎么移动

```bash
cp ~/.openclaw/media/inbound/<文件名> /data/.openclaw/workspace/docs/<文件名>
```

如果 `workspace/docs/` 不存在就先 `mkdir -p`。

## 怎么搜索文档内容

```
memory_search(query="合同违约金条款", maxResults=5)
```

命中后用 `read` 打开 `memory/_shadow/<hash>__<stem>.md` 看全文。

## 支持的文件类型

daemon 使用黑名单模式：除了已知的纯文本/代码/二进制格式外，所有文件都会尝试转换。已确认支持：
- **文档**：PDF、Word (.docx)、Excel (.xlsx/.xls)、PowerPoint (.pptx)
- **网页/数据**：HTML、CSV、JSON、XML
- **归档**：ZIP（自动递归解包）、EPUB（电子书）
- **媒体**（需配置 LLM/whisper）：图片 OCR、音频转文字
- 其他 markitdown 支持的格式自动跟进

## 安全规则

- daemon **不跟随 symlink**——workspace 里的符号链接会被跳过
- daemon **不处理隐藏文件**——以 `.` 开头的文件会被跳过

## 硬规则

- 不要直接改 `memory/_shadow/` 下的 .md 镜像，daemon 会覆盖
- 不要猜文件内容。先 `memory_search`，没命中再告诉主人等一会（daemon 转换中）
- 如果主人没说要索引，飞书文件就留在 media/inbound/ 不动
- daemon 扫描间隔由 config 的 `intervalSec` 控制（默认 300 秒）
- `_health.json` 可以查看 daemon 运行状态（originals/converted/errors/最后扫描时间）
- `_progress.json` 记录扫描进度，大量文件时支持跨 cycle 断点续传
