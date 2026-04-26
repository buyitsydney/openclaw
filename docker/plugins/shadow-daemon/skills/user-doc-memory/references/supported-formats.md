# 已验证的文件类型

daemon 不做扩展名过滤，markitdown 自己拒绝不支持的格式。以下经压测确认：

| 类型 | 扩展名 | 状态 | 备注 |
|------|--------|------|------|
| PDF | .pdf | ✅ | 需 markitdown[all]，大文件 80s+ |
| Word | .docx | ✅ | |
| Excel | .xlsx/.xls | ✅ | 转为 markdown 表格 |
| PowerPoint | .pptx | ✅ | 手工最小 PPTX 可能失败，真实 Office 文件正常 |
| HTML | .html | ✅ | |
| CSV | .csv | ✅ | |
| JSON | .json | ✅ | |
| XML | .xml | ✅ | |
| ZIP | .zip | ✅ | 自动递归解包 |
| EPUB | .epub | ✅ | |
| 图片 | .png/.jpg | ⚠️ | 需 LLM OCR 配置 |
| 音频 | .wav/.mp3 | ⚠️ | 需 whisper 配置 |
| RAR | .rar | ⚠️ | 需系统安装 unrar |

转换失败的文件生成 `status: failed` 占位 .md。用户问到不支持的类型时如实说明。
