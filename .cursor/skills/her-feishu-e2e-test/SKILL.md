---
name: her-feishu-e2e-test
description: Use this when testing CarHer/Her Feishu bot behavior end-to-end with real Lark groups, lark-cli, docker198/199/200, context/history injection, slash commands, knownBots, A2A, or interactive-card output. It defines the approved online test loop and evidence format for old-vs-new architecture parity work.
---

# Her Feishu E2E Test

This is the required workflow for real online tests of the new Her Feishu architecture. Use it before claiming a bot behavior is fixed.

## Scope

- Approved online test bots on S1: `carher-198`, `carher-199`, `carher-200`.
- Do not use `carher-75` / S3 docker75 for experiments unless the user explicitly re-authorizes it.
- User has authorized sending test messages in any Feishu group that contains docker198/199/200. Keep messages clearly marked and low-noise.
- Always use a unique marker: `HER_E2E_<yyyymmddHHMMSS>_<case>`.

## Preflight

1. Confirm lark-cli user auth:

   ```bash
   lark-cli auth status
   ```

   Required for group history and user-sent E2E prompts: `im:message:readonly`, `im:message.group_msg:get_as_user`, and when sending as the user, `im:message.send_as_user` / `im:message`.

2. Confirm bot runtime on S1. Prefer the local fleet credential helper; do
   not print passwords or copy them into notes:

   ```bash
   S1_PW=$(awk '/^10\.68\.13\.186/ {print $3; exit}' docker/servers.txt)
   sshpass -p "$S1_PW" ssh -o StrictHostKeyChecking=no cltx@10.68.13.186 \
     'cd /Data/CarHer && docker logs carher-200 --since 15m 2>&1 | grep -E "WSClient connected|gateway] ready|PATCHED|history-fill|command-body|reply-card default|BotRegistry"'
   ```

3. Keep evidence under `artifacts/her-e2e/<run-id>/` in the active worktree. Save raw lark-cli JSON, relevant docker log snippets, and a short `result.md`.

## Finding A Test Chat

Prefer a chat_id already visible in recent inbound logs for the test bot:

```bash
S1_PW=$(awk '/^10\.68\.13\.186/ {print $3; exit}' docker/servers.txt)
sshpass -p "$S1_PW" ssh -o StrictHostKeyChecking=no cltx@10.68.13.186 \
  'docker logs carher-200 --since 6h 2>&1 | grep -E "oc_[0-9a-f]+|chatId|chat_id" | tail -80'
```

If a known chat_id is available, list recent messages with user identity:

```bash
lark-cli im +chat-messages-list --as user --chat-id oc_xxx --page-size 30 --sort desc --format json
```

Use `--format json`; table output may truncate content.

## Sending Test Messages

Send as the authorized user, not as a bot, unless the case explicitly requires bot identity:

```bash
lark-cli im +messages-send --as user --chat-id oc_xxx --text 'HER_E2E_20260509T230000_new_tail /new <at user_id="cli_or_ou_xxx">bot name</at>'
```

For @ mention tests, use the Feishu text mention syntax documented by lark-im:

```text
<at user_id="...">display name</at>
```

If exact mention payload is uncertain, send the message manually in the Feishu UI and then use lark-cli to fetch the raw message JSON as the ground truth.

## Required Evidence Loop

For every test case:

1. Send or identify the trigger message and record `message_id`, `chat_id`, `marker`, and timestamp.
2. Fetch real group history:

   ```bash
   lark-cli im +chat-messages-list --as user --chat-id oc_xxx --page-size 50 --sort desc --format json > artifacts/her-e2e/<run-id>/<case>.lark.json
   ```

3. Fetch bot logs:

   ```bash
   S1_PW=$(awk '/^10\.68\.13\.186/ {print $3; exit}' docker/servers.txt)
   sshpass -p "$S1_PW" ssh -o StrictHostKeyChecking=no cltx@10.68.13.186 \
     'docker logs carher-200 --since 10m 2>&1' > artifacts/her-e2e/<run-id>/<case>.carher-200.log
   ```

4. Compare three views:
   - User-visible group messages from lark-cli.
   - Bot logs and system-command/history-fill markers.
   - Bot model-view context evidence when the bot can self-report it.

5. Write the verdict:
   - `PASS` only when behavior and evidence match the expected result.
   - `FAIL` when any view disagrees.
   - `INCONCLUSIVE` only when the platform or permission prevents seeing the necessary data; include the exact blocker.

## Core Regression Cases

Run these before full rollout:

| Case | Trigger | Expected evidence |
| --- | --- | --- |
| group-new-head | `@bot /new` | log has `detected system command` and `system command dispatched (delivered=true)`; no `dispatching to agent`; user sees `✅ New session started.` |
| group-new-tail | `/new @bot` | same as above |
| group-new-multi | `/new @bot1 @bot2` | each addressed bot handles system command directly; no LLM `noreply` |
| group-status | `/status @bot` | one system status response; no double reply |
| history-card | recent history includes `msg_type=interactive` | injected context has readable card text, not `请升级至最新版本客户端，以查看内容`, not raw card JSON |
| known-bots | group contains multiple Her app senders | model-visible sender labels include names like `弋天的her (cli_...)`, not bare `cli_...` only |
| reply-chain | trigger is a reply/thread message | context includes `message_id`, `message_type`, and `reply_to_id` when lark-cli exposes them |
| card-output | normal Her answer | user-visible reply is an interactive card unless a documented fallback applies |
| a2a-route | S1 test bot asks for an S3 bot capability | A2A logs show registry lookup and LAN endpoint route when peer is remote |

## Pass Criteria For History 1:1

The model-visible `InboundHistory` does not need to be byte-for-byte identical to raw Lark JSON, but it must be content-equivalent for fields that affect reasoning:

- `message_id` preserved.
- `message_type` preserved.
- `reply_to_id` / thread relation preserved when present.
- user senders rendered as readable names plus ids when available.
- app senders resolved through Bot Registry / knownBots.
- interactive cards rendered to readable markdown/text equivalent.
- no client fallback placeholder such as `请升级至最新版本客户端，以查看内容`.
- no opaque raw card JSON unless no converter can decode it and the failure is recorded.

## Server Log Checks

Patch markers that must appear after container start:

```bash
docker logs carher-200 2>&1 | grep -E "stripBotMentions|command-body normalize|channel-only|contracts.tools \(30\)|shadow-daemon|history-fill|inbound-history metadata|reply-card default|patch-agent-loop|session-decay|PATCHED"
```

For `/new` and `/status` command tests, look for:

```text
detected system command
system command dispatched (delivered=true)
```

and ensure the same trigger does not proceed to the LLM dispatch path.

## Output

Every E2E run must leave a short summary:

```markdown
# <run-id>

- Bot(s):
- Chat:
- Cases:
- Result:
- Evidence files:
- Remaining risk:
```

Never mark a fleet-wide behavior as fixed from logs alone. A passing run needs both real Lark message evidence and server-side evidence.
