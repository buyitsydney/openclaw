---
name: feishu-drive
description: |
  飞书云盘文件夹、根目录、文件移动、在线文件创建、大文件上传。当用户问及云盘、根文件夹、folder_token、共享文件夹链接、上传、移动/删除文件、或创建文件夹/文件时使用。
metadata: { "openclaw": { "emoji": "🗂️" } }
---

# 飞书云盘操作

用于云盘文件夹、上传、以及用户可见的文件存储。不用于 Wiki 树状导航。

## 云盘 vs Wiki

- Wiki 是文档树/知识空间
- 云盘是文件存储
- 用户问根文件夹、上传、文件、文件夹链接时，用云盘

## 根目录和文件夹规则

- 根目录必须用 `feishu_drive(action="list_root")`
- 不要用 `folder_token=0`
- 不要用 `folder_token=root`
- 非根读写需要真实 `folder_token`

## 用户可见性

- 云盘中可读内容视为用户可见（因为当前用户能看到）
- 不要把成功解释为"租户权限"
- 如果用户确实看不到，视为不可用

## 核心操作

- `list_root`
- `list_folder`
- `create_folder`
- `create_online`
- `move`
- `delete`
- `upload_file`

## 读取云盘文件内容

云盘中的普通文件（.txt / .log / .csv / .pdf / .gz 等）可通过 `feishu_doc` 读取：

```
feishu_doc(action="read", doc_type="file", doc_token="<file_token>")
```

- `file_token` 从 `list_folder` / `list_root` 结果中获取
- PDF 会直接提取正文返回
- 其他文件类型下载到本地后返回保存路径，agent 可用 `exec` 按需读取（cat / head / tail / grep / zcat 等）
- **不要用 `web_fetch` 访问飞书文件链接**——需要鉴权，必定失败

## 共享文件夹记忆

用户给出云盘文件夹链接或 `folder_token` 时：

1. 解析真实 `folder_token`
2. 写入/更新 `MEMORY.md -> Drive Shares`
3. 后续云盘操作复用该 token

用户明确问当前根目录时不要依赖过期记忆，重新调用 `list_root`。

## 上传边界

- 聊天附件 `message(..., media=...)` 限 30 MB 以内
- 更大的文件必须用 `feishu_drive(action="upload_file")`
- `upload_file` 是长时间流程，通过 subagent / `sessions_spawn` 执行
- 不得从云盘上传回退到聊天附件或其他目标

## 输出规则

- 说明你是列出了根目录、列出了某个文件夹、创建了文件夹、移动了文件、删除了文件、还是启动/完成了上传
- 如果上传是异步的，明确说明并给出 task id
- 如需两阶段上传 SOP 或任务状态格式，读 `references/upload-tasks.md`
