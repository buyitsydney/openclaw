---
name: feishu-perm
description: |
  Feishu sharing and permission boundaries for documents, files, and collaborators. Activate when user asks about collaborators, reader/editor/full access, sharing links, permission errors, or whether a document/file can be shared or granted to someone. Triggers on 权限, 分享, collaborator, reader, editor, full_access, share_url, permission denied.
metadata: { "openclaw": { "emoji": "🔐" } }
---

# Feishu Permission and Sharing Boundary

Use this skill when the user is asking about access control or document/file sharing.

## Current Plugin Reality

This `feishu-her` plugin does not expose a dedicated `feishu_perm` tool like upstream.

Do not invent collaborator-management actions that do not exist.

## What Is Supported

- Share real user-facing links returned by tools such as:
  - `feishu_wiki(action="resolve_url")`
  - `feishu_sheet(action="get_share_url")`
  - create/upload results that already return a `share_url`
- Surface Feishu permission errors and grant URLs clearly when a tool returns them
- Use group-member or task-member tools for chat/task membership, which is different from Drive/doc collaborator permissions

## What Is Not Supported Here

- Listing doc/file/folder collaborators
- Adding collaborators to docs/files/folders
- Removing collaborators from docs/files/folders
- Toggling `view` / `edit` / `full_access` on docs/files/folders

If the user explicitly asks for one of those operations, say that this plugin does not currently expose that capability. Do not fake success.

## Sharing Rules

- Always share the real `share_url` returned by the relevant tool
- Never hand-build Feishu sharing URLs
- If the tool returns a permission/grant error, surface the grant URL so the operator can authorize the app

## Output Rules

- Be explicit about whether you shared an existing URL, hit an unsupported permission-management request, or surfaced a permission error
- Keep the distinction clear between:
  - chat membership
  - task membership
  - document/file collaborators
