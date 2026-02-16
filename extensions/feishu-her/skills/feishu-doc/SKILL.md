---
name: feishu-doc
description: |
  Feishu document read/write operations. Activate when user mentions Feishu docs, cloud docs, or docx links.
---

# Feishu Document Tool

Single tool `feishu_doc` with action parameter for all document operations.

## Token Extraction

From URL `https://xxx.feishu.cn/docx/ABC123def` -> `doc_token` = `ABC123def`

## Editing Strategy (IMPORTANT)

When modifying an existing document, always prefer **incremental editing** over full replacement:

### Priority 1: find/replace (safest, preserves formatting)

For changing specific text (a number, a name, a date):

```json
{
  "action": "update_block",
  "doc_token": "ABC123def",
  "block_id": "doxcnXXX",
  "find": "2026",
  "replace_with": "2027"
}
```

This preserves all formatting (bold, links, italic) in the block. Workflow:

1. `list_blocks` to find the block containing the text
2. `update_block` with `find` + `replace_with` to do precise substitution

### Priority 2: update_block with content (single block rewrite)

For rewriting an entire paragraph:

```json
{
  "action": "update_block",
  "doc_token": "ABC123def",
  "block_id": "doxcnXXX",
  "content": "Completely new paragraph text"
}
```

Note: this replaces ALL text elements in the block, losing formatting (bold, links become plain text). Only use when the entire block content needs to change.

### Priority 3: append (add to end)

For adding new content at the end of a document:

```json
{ "action": "append", "doc_token": "ABC123def", "content": "New section content" }
```

### Priority 4: write (LAST RESORT - destructive)

For completely rewriting a document. **WARNING:** This deletes ALL existing content first. A backup is automatically saved to `~/.openclaw/feishu-doc-backups/` before deletion.

```json
{ "action": "write", "doc_token": "ABC123def", "content": "# Complete new content" }
```

**Image support in write/append:**

- HTTP/HTTPS URLs: `![photo](https://example.com/photo.jpg)` — downloaded and uploaded automatically
- Local file paths: `![photo](/path/to/photo.jpg)` — uploaded directly from disk (absolute, relative, or `file://` URLs)
- Relative paths resolve from `~/.openclaw/workspace/`
- Images are uploaded to Feishu Drive and patched into Image blocks automatically

**Limitations of write/append:**

- Markdown tables are supported (created as native Feishu tables with formatted cells)
- No API-based undo or version restore (local backup only)

**When write is appropriate:** Only when the user explicitly asks to replace/rewrite an entire document, or when the changes are so extensive that incremental editing would be impractical.

## Read Operations

### Read Document

```json
{ "action": "read", "doc_token": "ABC123def" }
```

Returns: title, plain text content, block statistics. Check `hint` field - if present, structured content (tables, images) exists that requires `list_blocks`.

### List Blocks

```json
{ "action": "list_blocks", "doc_token": "ABC123def" }
```

Returns full block data including tables, images. Use this to find block_ids for incremental editing.

### Get Single Block

```json
{ "action": "get_block", "doc_token": "ABC123def", "block_id": "doxcnXXX" }
```

### Create Document

```json
{ "action": "create", "title": "New Document" }
```

With folder and initial content (creates doc then writes content):

```json
{ "action": "create", "title": "New Document", "folder_token": "fldcnXXX", "content": "# Hello" }
```

### Delete Block

```json
{ "action": "delete_block", "doc_token": "ABC123def", "block_id": "doxcnXXX" }
```

## Reading Workflow

1. Start with `action: "read"` - get plain text + statistics
2. Check `block_types` in response for Table, Image, Code, etc.
3. If structured content exists, use `action: "list_blocks"` for full data

## Configuration

```yaml
channels:
  feishu:
    tools:
      doc: true # default: true
```

**Note:** `feishu_wiki` depends on this tool - wiki page content is read/written via `feishu_doc`.

## Permissions

Required: `docx:document`, `docx:document:readonly`, `docx:document.block:convert`, `drive:drive`
