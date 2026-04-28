# 支持的文件类型(Her 可索引清单)

> ⚠️ 写之前必读 [her-ux-principles.md](her-ux-principles.md)。

用户问"我这种文件你能记吗?"或文件转换失败时,Her 用这张表回答(产品语言,不要扔表格原文给用户)。

| 类型 | 扩展名 | 状态 | 给用户的话 |
|------|--------|------|--------|
| PDF | .pdf | ✅ | "PDF 没问题(大文件可能要 1 分钟左右)" |
| Word | .docx | ✅ | "Word 文档没问题" |
| Excel | .xlsx/.xls | ✅ | "Excel 表格我会转成 markdown 表格存,文字内容能搜到" |
| PowerPoint | .pptx | ✅ | "PPT 文字内容能记,排版样式不存" |
| HTML | .html | ✅ | "网页保存的 HTML 没问题" |
| CSV/JSON/XML | .csv/.json/.xml | ✅ | "结构化文本没问题" |
| ZIP | .zip(见 `limits.archive_max_files`) | ✅ | "压缩包自动展开,但超过 N 个文件的我只记文件名清单。N 读 `_health.json` → `limits.archive_max_files`" |
| EPUB | .epub | ✅ | "电子书没问题" |
| MD/TXT | .md/.txt | ✅ | "纯文本/Markdown 直接存(必须 UTF-8 编码)" |
| RAR | .rar | ⚠️ | "暂不支持(容器没装 unrar),压缩为 zip 我能处理" |

## 失败时给用户的人话

读 `_health.json` 的 `recent_errors[].kind`,翻译:

| kind | 给用户的话 |
|---|---|
| `mime_mismatch` | "文件扩展名跟内容不匹配(比如名字叫 .pdf 但实际是文本),换一个文件试试" |
| `archive_too_many_files` | "压缩包里超过 20 个文件,只索引了清单。展开后单独发我能逐个记" |
| `encoding_error` | "文本文件不是 UTF-8 编码,需要先转一下编码" |
| `output_too_large` | "内容超过上限(见 `limits.max_output_mb`),我只能记摘要" |
| `oom` | "文件太大或太复杂把转换工具吃爆了,要更长超时再试吗?" |
| `timeout` | "10 分钟没转完,通常是大 PDF/扫描件。要再给它更长时间试吗?" |
| `crashed` / `failed` | "转换出错,可能这个文件损坏。换一个或修一下看?" |

## 不要做的事

- ❌ 把这张表原样丢给用户(用户不需要看到 ⚠️ 怎么开"OCR 配置")
- ❌ 用 kind 字符串原文回复("文件 mime_mismatch")
- ❌ 内部 `convert_failed rc=137` 这种工程信息
