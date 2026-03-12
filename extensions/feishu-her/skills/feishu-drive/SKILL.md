---
name: feishu-drive
description: |
  Feishu drive folders, root directory, file moves, online file creation, and large-file uploads. Activate when user asks about cloud drive, root folders, folder tokens, shared folder links, uploads, moving files, deleting files, or creating folders/files in Drive. Triggers on 云盘, drive, 根目录, 文件夹, folder_token, shared folder, upload_file, 大文件上传.
metadata: { "openclaw": { "emoji": "🗂️" } }
---

# Feishu Drive Operations

Use this skill for Drive folders, uploads, and user-visible file storage. Do not use it for wiki tree navigation.

## Drive vs Wiki

- Wiki is the document tree / knowledge space
- Drive is the file store
- If the user asks about root folders, uploads, files, or folder links, use Drive

## Root and Folder Rules

- Root must use `feishu_drive(action="list_root")`
- Do not use `folder_token=0`
- Do not use `folder_token=root`
- Non-root reads and writes require a real `folder_token`

## User-Visible Access

- Treat readable Drive content as visible because the current user can see it
- Do not explain success as "tenant permission"
- If the user cannot see it, treat it as unavailable

## Core Actions

- `list_root`
- `list_folder`
- `create_folder`
- `create_online`
- `move`
- `delete`
- `upload_file`

## Shared Folder Memory

When the user gives a Drive folder link or `folder_token`:

1. Parse the real `folder_token`
2. Write/update `MEMORY.md -> Drive Shares`
3. Reuse that token for later Drive operations

Do not rely on stale memory when the user explicitly asks about the current root directory. For root questions, call `list_root` again.

## Upload Boundary

- Chat attachments through `message(..., media=...)` are for files up to 30 MB
- Larger files must use `feishu_drive(action="upload_file")`
- `upload_file` is a long-running flow; run it via subagent / `sessions_spawn`
- Do not fall back from Drive upload to a chat attachment or another destination

## Output Rules

- State whether you listed root, listed one folder, created a folder, moved a file, deleted a file, or started/completed an upload
- If an upload is asynchronous, say that clearly and give the task id
- If you need the task-state format or the two-stage upload SOP, read `references/upload-tasks.md`
