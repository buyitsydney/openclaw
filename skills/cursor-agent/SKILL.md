---
name: cursor-agent
description: "Run coding tasks via the Cursor CLI agent (cursor-agent). Use when the user asks to: write code, modify files, refactor, review PRs, run tests, debug, or any software engineering task that benefits from Cursor IDE's AI agent. Triggers on: cursor, 编程, 写代码, 改代码, 修代码, refactor, code review, PR review, 帮我改, 帮我写, coding task. Requires tmux for PTY."
metadata:
  {
    "openclaw":
      { "emoji": "🖥️", "os": ["darwin", "linux"], "requires": { "bins": ["tmux", "agent"] } },
  }
---

# Cursor CLI Agent

Run coding tasks on the local machine using the Cursor CLI (`agent`).
Cursor agent has full IDE capabilities: file read/write, shell commands, linting, type-checking, and multi-file refactoring.

## Prerequisites

- `agent` CLI installed (`~/.local/bin/agent`)
- Authenticated: `agent login` or `CURSOR_API_KEY` set
- `tmux` installed (required for PTY)

## Quick One-Shot Task

For tasks that complete in under 2 minutes:

```bash
# 1. Create (or reuse) a tmux session
tmux kill-session -t cursor-work 2>/dev/null || true
tmux new-session -d -s cursor-work

# 2. Run the task (non-interactive mode with --force to auto-apply)
tmux send-keys -t cursor-work "cd /path/to/project && agent -p 'YOUR TASK HERE' --force --trust --output-format text 2>&1 | tee /tmp/cursor-agent-output.txt" Enter

# 3. Wait for completion (adjust sleep based on task complexity)
sleep 30

# 4. Capture output
tmux capture-pane -t cursor-work -p -S -500
# Or read the tee'd file:
cat /tmp/cursor-agent-output.txt
```

## Long-Running Background Task

For tasks that take more than 2 minutes:

```bash
# 1. Create session
tmux new-session -d -s cursor-work

# 2. Start task
tmux send-keys -t cursor-work "cd /path/to/project && agent -p 'YOUR LONG TASK' --force --trust --output-format text 2>&1 | tee /tmp/cursor-agent-output.txt; echo '===CURSOR_DONE===' >> /tmp/cursor-agent-output.txt" Enter

# 3. Poll for completion (check periodically)
grep -q '===CURSOR_DONE===' /tmp/cursor-agent-output.txt 2>/dev/null && echo "DONE" || echo "RUNNING"

# 4. Read results when done
cat /tmp/cursor-agent-output.txt
```

## Output File Convention

Always tee output to `/tmp/cursor-agent-output.txt` so results can be read reliably even if tmux pane scrollback is limited.

## Default Project Directory

Unless the user specifies a project, use: `/Users/buyitian/Documents/work/openclaw`

## Task Prompt Template

When constructing the agent prompt, be specific and include:

1. What to do (concrete, actionable)
2. Which files to focus on (if known)
3. Constraints (don't modify X, keep Y compatible)

Example:

```bash
agent -p 'In src/memory/hybrid.ts, add a cache TTL parameter to the search function. Default to 300 seconds. Add a test in hybrid.test.ts.' --force --trust --output-format text
```

## Model Selection

The agent uses the user's default Cursor model. Override with `--model`:

```bash
agent -p 'task' --model claude-sonnet-4.6 --force --trust
```

## Reporting Results

After the task completes:

1. Read `/tmp/cursor-agent-output.txt`
2. Summarize what was done (files changed, tests added, etc.)
3. Report any errors or warnings
4. If the task modified files, mention which files were changed

## Error Handling

- **"Authentication required"**: User needs to run `agent login` in a terminal
- **Timeout/hang**: Kill with `tmux send-keys -t cursor-work C-c` then retry
- **"Raw mode not supported"**: Must use tmux (never call agent directly from bash without PTY)

## Rules

1. Always use tmux — agent needs a real PTY
2. Always use `-p` flag for non-interactive mode
3. Always use `--force --trust` to auto-apply changes and trust workspace
4. Always tee output to `/tmp/cursor-agent-output.txt`
5. Set reasonable timeouts — don't let tasks run forever
6. Report back clearly what was done and what changed
