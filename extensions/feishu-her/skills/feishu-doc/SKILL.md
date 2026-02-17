---
name: feishu-doc
description: |
  Feishu document read/write operations. Activate when user mentions Feishu docs, cloud docs, or docx links.
---

# Feishu Document Tool

Single tool `feishu_doc` with action parameter for all document operations.

## Mandatory SOP (MUST FOLLOW)

When user asks to sync local markdown to Feishu/Wiki doc, AI MUST execute this exact sequence:

1. Resolve destination doc token (if user provides wiki URL, use `feishu_wiki get` first and take `obj_token`).
2. Run `feishu_doc` write with `source_file` (NOT inline `content`) using the exact local file path.
3. Immediately run `feishu_doc` `list_blocks` on the same doc token to verify block/table structure.
4. Optionally run `feishu_doc` `read` only for plain text sanity check (never use `read` alone to validate tables).
5. Report verification result with concrete metrics: `first-level blocks`, `table count`, `empty cells`.

Hard rules:

- For content longer than ~20 lines, `source_file` is REQUIRED.
- Do not send large markdown via `content` (causes LLM token bloat and timeout risk).
- Do not claim "0 diff" without `list_blocks`-based verification.
- Verification must be on the SAME destination doc token the user asked for.

## Regression Proof Protocol (MUST FOLLOW)

For any bugfix/regression testcase in `feishu_doc`, AI must use deterministic A/B proof:

1. Run tests on latest code (baseline).
2. Switch only implementation file(s) to known old SHA.
3. Run the exact same tests again (test files unchanged).
4. Confirm old version fails with behavioral assertions.
5. Restore latest implementation and re-run; confirm pass.

Do NOT claim regression proof via static inspection (symbol names, grep, etc.).
Proof requires runtime assertions and old-fail/new-pass evidence.

Reference workflow skill: `.cursor/skills/feishu-regression-proof/SKILL.md`

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

For adding new content at the end of a document. Use `source_file` for large content:

```json
{ "action": "append", "doc_token": "ABC123def", "source_file": "/path/to/content.md" }
```

For short inline content:

```json
{ "action": "append", "doc_token": "ABC123def", "content": "New section content" }
```

### Required sync example (local file -> same destination)

```json
{
  "action": "write",
  "doc_token": "JvwcdDtXXoCwePxZ73uckVXsnBo",
  "source_file": "/absolute/path/to/file.md"
}
```

Then verify:

```json
{ "action": "list_blocks", "doc_token": "JvwcdDtXXoCwePxZ73uckVXsnBo" }
```

### Priority 4: write (LAST RESORT - destructive)

For completely rewriting a document. **WARNING:** This deletes ALL existing content first. A backup is automatically saved to `~/.openclaw/feishu-doc-backups/` before deletion.

**CRITICAL: Use `source_file` instead of `content` for any document longer than ~20 lines!**

The `source_file` parameter lets the tool read content directly from disk, avoiding the need to output the entire document as a tool argument (which would waste 30K+ output tokens and risk network timeouts for large files).

```json
{ "action": "write", "doc_token": "ABC123def", "source_file": "/path/to/document.md" }
```

Only use inline `content` for very short content (a few paragraphs):

```json
{ "action": "write", "doc_token": "ABC123def", "content": "# Short content" }
```

**Image support in write/append:**

- HTTP/HTTPS URLs: `![photo](https://example.com/photo.jpg)` — downloaded and uploaded automatically
- Local file paths: `![photo](/path/to/photo.jpg)` — uploaded directly from disk (absolute, relative, or `file://` URLs)
- Relative paths resolve from `~/.openclaw/workspace/`
- Images are uploaded to Feishu Drive and patched into Image blocks automatically

**Large document strategy:**

The Feishu API has different limits for different block types:

- **Text, headings, lists, quotes, dividers**: No practical per-request limit (500+ blocks tested OK via descendant API)
- **Tables**: Initial creation is capped at 9x9 but tables are **automatically expanded** to any size via row/column insertion. Cell content is filled in bulk via `batch_update` (~150 cells per API call). A 673-line document with 12 tables and 210 cells writes in ~18 seconds.

If a write/append fails, the error message will explain the cause (e.g., unsupported block types). Use the backup at `~/.openclaw/feishu-doc-backups/` to restore if `write` fails mid-operation.

**Dollar signs:** `$` followed by digits (e.g., `$500`) is automatically escaped to prevent Feishu from rendering it as LaTeX.

**Limitations:**

- Markdown tables are supported (created as native Feishu tables with formatted cells, any size)
- No API-based undo or version restore (local backup only)
- Large documents with many tables may take 15-30 seconds (table row/column expansion is sequential)

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

With folder and initial content (creates doc then writes content). Use `source_file` for large files:

```json
{
  "action": "create",
  "title": "New Document",
  "folder_token": "fldcnXXX",
  "source_file": "/path/to/doc.md"
}
```

For short inline content:

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

## E2E Execution (Feishu Her)

- Dedicated command: `pnpm test:e2e:feishu-her`
- Purpose: heavy anti-regression e2e checks for `feishu-her` doc tool.
- Policy: keep this command outside default fast CI lanes; run in dedicated/manual flow.

**IMPORTANT: Verifying writes**

After `write`/`append`, do NOT use `read` (rawContent) to verify table content. The `rawContent` API strips all table structure and shows tables as empty newlines. To verify table content, use `list_blocks` instead. Heading count and order from `read` are reliable for non-table content.

If user asks "0 diff", AI must:

1. verify table integrity via `list_blocks` (table count, empty cells),
2. verify major heading order,
3. only then report success.

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
