# 索引单个文档

> ⚠️ 写之前必读 [her-ux-principles.md](her-ux-principles.md)。

## 用户场景

用户说"帮我记住这个文件"/"把这份合同/文档加进 memory"/"我刚发的 PDF 帮我索引"。

## Step 1 — 自动定位文件(能扫的不问)

按优先级查:
1. 用户消息里直接给的路径 → 确认存在
2. 飞书刚发来的附件 → `ls /data/.openclaw/workspace/media/inbound/ -t | head` 找最新
3. 用户描述的文件名(模糊匹配) → `find . -iname '*<keyword>*' -mtime -1`(近 24h)

找到 1 个 → 直接用。找到多个 → 列出来让用户选。找到 0 个 → "我没找到,能再发一次或贴个完整路径吗?"

## Step 2 — 自动决定放哪(能扫的不问)

读 `_config.json` 看监控目录:

| 情况 | Her 怎么做 |
|---|---|
| 有 `docs/` 监控,文件是文档 | 默认放 `docs/`,直接告诉用户(不问) |
| 有多个监控目录(docs/ contracts/) | 看文件类型/名字猜:合同 → contracts/,其他 → docs/。**报建议给用户批准** |
| 文件已在监控目录里 | 不用 mv,直接报"已经在监控范围,daemon 几秒内就索引到" |
| 没有合适监控目录 | "我建议放到 docs/(daemon 会自动监控),要这样吗?或你指定路径?" |

## Step 3 — 移动 + 报进度

```
📁 我把 `<filename>` 放到 docs/ 下(就在你工作空间里,daemon 会自动转换)。大概 5-15s 完成。
```

执行 `mv` / `cp`。daemon 自动检测到新文件并转换。

## Step 4 — 实时盯转换 + 报完成

每 5s 读 `_health.json`,看 `recent_events` 里有没有这个文件的 `convert_ok`(daemon 暴露的字段名以实际为准):

```
🔄 转换中...
✓ 索引完毕(8s)。现在 memory_search "<文件名>" 能直接命中了。
```

如果 `recent_errors` 出现该文件 → 翻译错误为人话:
- `mime_mismatch`:"❌ 这文件扩展名跟内容不符(假 PDF?),换一个文件试试"
- `archive_too_many_files`:"❌ 这是个大压缩包,我只索引了文件名,内容请展开后单个发"
- `encoding_error`:"❌ 文本文件不是 UTF-8 编码,需要先转 utf8"
- `output_too_large`:"❌ 内容超过 5MB 上限,我只能存摘要"
- `timeout`:"⏱ 太大了 daemon 没在 10min 内转完,要我用更长的超时再试吗?"

## 不要做的事

- ❌ 反问"文件叫什么名字?"(用户刚发过/已在路径里 → 自己找)
- ❌ 反问"放哪个目录?"(已有监控目录 → 自己定 + 报告)
- ❌ 沉默等 daemon 跑完
- ❌ 错误码原文给用户看
