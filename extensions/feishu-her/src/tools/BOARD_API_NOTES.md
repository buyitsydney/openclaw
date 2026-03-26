# Feishu Board (画板) API Notes

## Capability Summary (17 working features)

- Create whiteboard (block_type=43 via docx API)
- 20 shape types (round_rect, diamond, ellipse, cylinder, etc.)
- 4 connector line types (straight, polyline, curve, right_angled_polyline)
- Text nodes with font size/weight/alignment/color
- Style: fill_color, border_style, border_color
- Mermaid diagrams (flowchart, sequence, class, ER, etc.)
- PlantUML diagrams (use case, sequence, class, activity)
- SVG custom graphics
- Group containers
- Section areas with titles
- Mind maps (multiple layouts)
- Batch creation up to 3000 nodes
- Negative coordinates and extreme dimensions
- Idempotent creation via client_token
- XSS safe (injected content properly escaped by Feishu)
- List all nodes on a whiteboard
- Get/set whiteboard theme

## Known Feishu API Limitations (not fixable on our side)

### Critical

| Issue         | Detail                             | Impact                                  |
| ------------- | ---------------------------------- | --------------------------------------- |
| No update API | Cannot modify nodes after creation | Must recreate entire board to fix typos |
| No delete API | Cannot remove individual nodes     | No undo for mistakes                    |

### Medium

| Issue                                            | Detail                                                          | Workaround                              |
| ------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------- |
| connector rejects text                           | Error 4005062 "caption arg error" when text is set on connector | Tool auto-strips text from connectors   |
| table not supported                              | block_type=table creation fails via Board API                   | Use docx table tools instead            |
| list_nodes no pagination                         | Large whiteboards may hit response size limits                  | Tool truncates to 100 nodes in response |
| Inconsistent error codes for missing whiteboards | list_nodes → 500, get_theme → 400                               | N/A                                     |

### Minor

| Issue                       | Detail                                          | Workaround                         |
| --------------------------- | ----------------------------------------------- | ---------------------------------- |
| sticky_note not supported   | Always returns 400 (requires user_id context)   | Removed from tool's node type list |
| Mermaid syntax errors → 500 | Server returns 500 instead of descriptive error | User must fix Mermaid syntax       |

## Tool Actions

| Action           | Description                                 | Requires                        |
| ---------------- | ------------------------------------------- | ------------------------------- |
| `create`         | Insert new whiteboard into a docx document  | `doc_token`                     |
| `create_nodes`   | Draw shapes, connectors, text on whiteboard | `whiteboard_id`, `nodes[]`      |
| `create_diagram` | Render Mermaid/PlantUML code on whiteboard  | `whiteboard_id`, `diagram_code` |
| `list_nodes`     | List all nodes (summarized, max 100)        | `whiteboard_id`                 |
| `get_theme`      | Get whiteboard theme                        | `whiteboard_id`                 |

## API Endpoints Used

- `POST /docx/v1/documents/{doc_id}/blocks/{doc_id}/children` — create board block (block_type=43)
- `POST /board/v1/whiteboards/{id}/nodes` — create nodes (50 req/s)
- `POST /board/v1/whiteboards/{id}/nodes/plantuml` — Mermaid/PlantUML (5 req/s)
- `GET /board/v1/whiteboards/{id}/nodes` — list nodes (10 req/s)
- `GET /board/v1/whiteboards/{id}/theme` — get theme (10 req/s)

## Required Permissions

- `board:whiteboard:node:create` — create nodes, update theme
- `board:whiteboard:node:read` — list nodes, get theme
- `docx:document:write_only` — insert board block into document

## Conclusion

The Board API is a good "one-shot drawing tool" — excellent for generating diagrams
from scratch, but not suitable for iterative editing workflows due to the lack of
update/delete APIs. Best use case: AI generates a complete diagram in one call.
