---
name: feishu-wiki
description: |
  Feishu knowledge-base navigation and wiki node management. Activate when user asks about knowledge spaces, wiki pages, node trees, moving or renaming wiki pages, resolving wiki links, or browsing personal/knowledge space structure. Triggers on 知识空间, wiki, space, node, 页面树, 移动页面, 重命名页面, resolve_url.
metadata: { "openclaw": { "emoji": "📚" } }
---

# Feishu Wiki Operations

Use this skill for space/node navigation and wiki-page management. Use `feishu-doc` when the task is editing the body content of a page.

## Mental Model

- Wiki is the tree-shaped knowledge space
- Drive is the file store
- If the user says "知识空间", "wiki", or usually "个人空间", assume wiki first

## Core Actions

- `feishu_wiki(action="spaces")` -> list spaces
- `feishu_wiki(action="nodes")` -> list top-level or child nodes
- `feishu_wiki(action="get")` -> inspect one node
- `feishu_wiki(action="create")` -> create a node
- `feishu_wiki(action="rename")` -> rename a node
- `feishu_wiki(action="move")` -> move a node
- `feishu_wiki(action="resolve_url")` -> get a real accessible link

## Node vs Document

- `node_token` identifies the wiki node
- `obj_token` identifies the underlying document object
- To read or edit page content, first call `feishu_wiki(action="get")`, then pass `obj_token` to `feishu_doc`

Do not confuse `node_token` with `doc_token`.

## Creation Rules

- Pass explicit `obj_type` when the page type matters
- Common types: `docx`, `sheet`, `bitable`
- Use `parent_node_token` when the user cares about location
- Wiki create is not a safe rollback path; do not promise API deletion afterward

## Moving and Renaming

- Use `rename` when only the title changes
- Use `move` when the parent or space changes
- Keep `space_id` / `target_space_id` / `target_parent_token` exact; do not guess them

## Sharing Links

- Always use `feishu_wiki(action="resolve_url")` for user-facing wiki links
- Never hand-build wiki URLs
- If the user wants the content changed rather than the link shared, switch to `feishu-doc`

## Output Rules

- Say whether you navigated spaces, inspected one node, moved a node, renamed a node, or resolved a URL
- If the body-content task was handed off to `feishu-doc`, say that explicitly
