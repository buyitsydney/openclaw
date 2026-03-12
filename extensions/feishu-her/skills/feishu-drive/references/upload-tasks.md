# Feishu Drive Upload Tasks

Use this file for the long-running `upload_file` state machine.

## Two-Stage SOP

1. Validate `folder_token`, `file_path`, and `file_name`
2. Check `MEMORY.md -> Drive Upload Tasks` for duplicate pending/running jobs
3. Return an immediate receipt with a stable `task_id`
4. Launch the real upload via subagent / `sessions_spawn`
5. Update task status to `running`, then `succeeded` or `failed`
6. Return the final URL or exact error

## Allowed Status Values

- `pending`
- `running`
- `succeeded`
- `failed`

Do not invent extra statuses.

## Minimum Task Fields

- `task_id`
- `folder_token`
- `file_name`
- `file_path`
- `status`
- `started_at`
- `last_update_at`
- `result_file_token`
- `result_url`
- `error`

## Hard Rules

- Do not start upload without a real `folder_token`
- Do not upload >30 MB files through chat media
- Do not silently retry to a different destination
- Do not answer with "maybe it worked" or other fuzzy fallback wording
