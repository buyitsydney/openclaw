---
name: feishu-wiki
description: |
  Feishu knowledge base navigation. Activate when user mentions knowledge base, wiki, or wiki links.
---

# Feishu Wiki Tool

Single tool `feishu_wiki` for knowledge base operations.

## Mandatory Workflow (MUST FOLLOW)

For any wiki URL sync/edit task, AI must:

1. `feishu_wiki get` with wiki token from URL.
2. Use returned `obj_token` as `feishu_doc.doc_token`.
3. For large local files, call `feishu_doc write` with `source_file` (NOT inline `content`).
4. Verify with `feishu_doc list_blocks` on the same `obj_token`.

Do not report success without step 4.

## Token Extraction

From URL `https://xxx.feishu.cn/wiki/ABC123def` → `token` = `ABC123def`

## Actions

### List Knowledge Spaces

```json
{ "action": "spaces" }
```

Returns all accessible wiki spaces.

### List Nodes

```json
{ "action": "nodes", "space_id": "7xxx" }
```

With parent:

```json
{ "action": "nodes", "space_id": "7xxx", "parent_node_token": "wikcnXXX" }
```

### Get Node Details

```json
{ "action": "get", "token": "ABC123def" }
```

Returns: `node_token`, `obj_token`, `obj_type`, etc. Use `obj_token` with `feishu_doc` to read/write the document.

### Create Node

```json
{ "action": "create", "space_id": "7xxx", "title": "New Page" }
```

With type and parent:

```json
{
  "action": "create",
  "space_id": "7xxx",
  "title": "Sheet",
  "obj_type": "sheet",
  "parent_node_token": "wikcnXXX"
}
```

`obj_type`: `docx` (default), `sheet`, `bitable`, `mindnote`, `file`, `doc`, `slides`

### Move Node

```json
{ "action": "move", "space_id": "7xxx", "node_token": "wikcnXXX" }
```

To different location:

```json
{
  "action": "move",
  "space_id": "7xxx",
  "node_token": "wikcnXXX",
  "target_space_id": "7yyy",
  "target_parent_token": "wikcnYYY"
}
```

### Rename Node

```json
{ "action": "rename", "space_id": "7xxx", "node_token": "wikcnXXX", "title": "New Title" }
```

## Wiki-Doc Workflow

To edit a wiki page:

1. Get node: `{ "action": "get", "token": "wiki_token" }` → returns `obj_token`
2. Read doc: `feishu_doc { "action": "read", "doc_token": "obj_token" }`
3. Write doc (large file): `feishu_doc { "action": "write", "doc_token": "obj_token", "source_file": "/absolute/path/to/file.md" }`
4. Verify structure/tables: `feishu_doc { "action": "list_blocks", "doc_token": "obj_token" }`

## Configuration

```yaml
channels:
  feishu:
    tools:
      wiki: true # default: true
      doc: true # required - wiki content uses feishu_doc
```

**Dependency:** This tool requires `feishu_doc` to be enabled. Wiki pages are documents - use `feishu_wiki` to navigate, then `feishu_doc` to read/edit content.

## Permissions

Required: `wiki:wiki` or `wiki:wiki:readonly`
