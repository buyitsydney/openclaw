---
name: her-feishu-e2e-test
description: Use this when testing CarHer/Her Feishu bot behavior end-to-end with real Lark groups, lark-cli, docker198/199/200, context/history injection, slash commands, knownBots, A2A, interactive-card output, Hermes parity, or OpenClaw/Hermes dual hot-switch. It defines the approved online test loop, product-line-specific gates, and evidence format for old-vs-new architecture parity work.
---

# Her Feishu E2E Test

This is the required workflow for real online tests of the new Her Feishu architecture. Use it before claiming a bot behavior is fixed.

## Product-line authority

Choose the test lane before touching containers:

| Product line      | Local source of truth                                 | S1 source of truth     | Test targets                                               |
| ----------------- | ----------------------------------------------------- | ---------------------- | ---------------------------------------------------------- |
| `carher-openclaw` | `/Users/buyitian/Documents/work/openclaw`             | `/Data/CarHer`         | pure OpenClaw `carher-*`; S1 control `carher-198`          |
| `carher-hermes`   | `/Users/buyitian/Documents/work/hermestest` `dev`     | `/Data/hermestest`     | pure Hermes `hermestest-199`                               |
| `carher-runtime`  | `/Users/buyitian/Documents/work/carher-runtime` `dev` | `/Data/carher-runtime` | runtime canary `hermestest-200`; future `carher-runtime-*` |

Do **not** start new CICD/deploy work from `/Users/buyitian/Documents/work/hermestest-dual-engine`. That worktree is historical evidence for `feat/dual-engine` at `38abd1f`; the current authoritative Hermes/Dual source is `hermestest dev` at/after `d20ad65`, which includes the dual lark-cli token-store sync fix.

Do **not** treat OpenClaw `carher/feat/dual-engine-poc` as the full delivery. It is an OpenClaw-side PoC archive: useful for `carher-engine-swap`, `apply-history-fill-dm.sh`, and docs, but not the Hermes/Dual image, S1 compose, or final parity scripts.

## Scope

- Approved online test bots:
  - S1 control: `carher-198`.
- S1 Hermes/Runtime: `hermestest-199`, `hermestest-200`. Legacy dual baseline: `hermestest-13`.
  - S3 Dual: `hermestest-14`, `hermestest-75`.
- The user explicitly authorized S3 docker14/75 dual gray testing on 2026-05-11. Future destructive changes still require rollback discipline, but normal E2E messages in Her 产品测试群 are allowed for regression.
- Keep messages clearly marked and low-noise.
- Always use a unique marker: `HER_E2E_<yyyymmddHHMMSS>_<case>`.
- **Mac local variant**: `carher-101..104` on the host Mac also have lark-cli authorized as the user (`卜弋天`, `ou_a7afacbb81237891a181832ac7a76294`). Use them as the user-proxy when testing local PoCs (e.g. `hermestest-103/104` at `~/Documents/work/hermestest/`).

## Mac Local PoC Variant — using carher-101 as user proxy

You can drive the entire E2E loop without ever asking the human to type in
Feishu, by using any local `carher-N` container's lark-cli auth as the
sender. This is the "last mile" that closes the test loop on your side.

```bash
# 1. Pick any local carher container that's running and has lark-cli auth.
# carher-101 typically has auth as 卜弋天 (verify with `lark-cli auth list`).
docker start carher-101  # if stopped
docker exec carher-101 lark-cli auth list
# expect: { "userName":"卜弋天", "tokenStatus":"needs_refresh"|"valid", ... }
# tokenStatus=needs_refresh is fine — auto-refreshes on first request.

# 2. Find the chat_id from the bot under test (e.g. hermestest-103).
docker exec hermestest-103 tail -100 /opt/data/logs/gateway.log \
  | grep -oE "oc_[0-9a-f]+" | sort -u
# DM with bot: typically 1 chat_id; group: another chat_id.

# 3. Send AS 卜弋天 (user identity, not bot identity).
docker exec carher-101 lark-cli im +messages-send \
  --as user \
  --chat-id "oc_xxxx" \
  --text "test prompt here"

# 4. Wait for the bot to reply (Hermes typically 4-30s, carher 6-90s with
#    tool calls). Use Monitor with an until-loop on the gateway.log:
until docker exec hermestest-103 tail -30 /opt/data/logs/gateway.log \
        2>/dev/null | grep -q "<chat_id>.*time=.*api_calls"; do sleep 3; done

# 5. Read back the reply via lark-cli.
docker exec carher-101 lark-cli im +chat-messages-list \
  --as user --chat-id "oc_xxxx" --sort desc --page-size 5
```

For DM specifically, the chat_id between you and a given bot is stable —
record it the first time and reuse it across runs.

The same loop works for the S1 fleet: you can run the user-proxy lark-cli
on any S1 carher container (12, 13, 14, 75, 198, 199, 200) and direct it
at any bot's chat_id you've ever interacted with.

### Dual-engine local 103/104 gate

For Hermes/OpenClaw hot-switch work:

- `hermestest-103` is the dual-engine candidate (`hermestest:dual`).
- `carher-104` is the local pure-OpenClaw control.
- `carher-101` remains the lark-cli user-token driver.
- Test group: `oc_d37eb39f87a3363e490658d47b2315c7`.
- tester3 bot mention id: `ou_9179cb60fcbdd851cd88d4d88a02d66b`;
  app id: `cli_a94a51d8873bdbb6`.
- tester4 bot mention id: `ou_13061e520c10feb6ac43219e8a18a9b9`;
  app id: `cli_a94e4cee07e69bc2`.
- tester3 DM chat: `oc_58e9be8f83f3595f7a83f24cebea5684`.

Run the full hot-switch gate from the current authority, `~/Documents/work/hermestest`:

```bash
cd ~/Documents/work/hermestest
bash parity/dual_swap_e2e.sh
```

`~/Documents/work/hermestest-dual-engine` is only a historical worktree for
reproducing commit `38abd1f`; do not use it for new deploy/CICD decisions.

Required PASS evidence:

- group OpenClaw baseline says current engine is OpenClaw in one card;
- group `/hermes` writes marker and sends one switch card;
- Hermes group reply remembers the immediately preceding OpenClaw turn;
- DM Hermes reply works;
- DM `/openclaw` writes marker and sends one switch card;
- OpenClaw DM reply after the switch correctly reads Feishu history and says
  the previous DM engine was Hermes / Opus;
- `/openclaw` no-op does not fall through to the LLM;
- second `/hermes` returns to Hermes and preserves group continuity.

Do not claim dual-engine DM continuity from logs alone. Inspect the OpenClaw
session snapshot if needed and verify that the model-visible context contains
`Chat history since last reply` with the previous DM markers. The 2026-05-10
fix proved that "history-fill done 49" is insufficient by itself: the patch
must also enable DM injection in `dispatch-builders.js` and `dispatch.js`
through `CARHER_HISTORY_FILL_DM_INJECT_PATCH_MARKER`.

Local-only trap: the 103 OpenClaw workspace must be initialized. If
`/data/.openclaw/workspace/BOOTSTRAP.md` exists, OpenClaw may obey bootstrap
instructions and say the DM is a new workspace even though Feishu history was
correctly injected. Production Her workspaces are initialized, so remove the
local bootstrap file or initialize `IDENTITY.md` / `USER.md` / `SOUL.md` before
using 103 as a parity signal.

### Dual-engine S1 198/199/200 gate

Use this gate when validating the cloud hot-switch candidate:

- `carher-198` is the pure OpenClaw control.
- `hermestest-199` is the mature Hermes control.
- `hermestest-200` is the `carher-runtime` canary replacing `carher-200`.
- Test group: `oc_fd0624fa2a9cb343cc9371be5c527686`.
- 198 bot mention id: `ou_b115c0942d35446311232f584e697d2c`.
- 199 bot mention id: `ou_57078c733f9584da21aa37d4373b4969`.
- 200 bot mention id: `ou_c2bc759110aa5bc80b2edea2ede864e9`.
- 200 DM chat: `oc_f5065ccf48849859a8fe7d04f42db6e6`.

Run the cloud hot-switch matrix on S1 from the runtime repository:

```bash
cd /Data/carher-runtime
bash e2e/s1_runtime_200_e2e.sh
bash e2e/s1_feature_e2e.sh
bash e2e/s1_command_matrix_e2e.sh
```

Required PASS evidence:

- 198 returns `OPENCLAW198_OK` in one interactive card.
- 199 returns `HERMES199_OK` in one interactive card.
- 200 OpenClaw mode returns `OPENCLAW200_OK`.
- `/hermes @研究3` switches `/data/.engine/active` from `openclaw` to `hermes`.
- 200 Hermes mode returns `HERMES200_OK` and can describe the immediately
  preceding OpenClaw -> Hermes switch card from Feishu history.
- 200 Hermes DM returns `HERMES200_DM_OK`.
- `/openclaw` switches back to `openclaw`.
- 200 OpenClaw DM reads the prior Hermes DM marker and returns
  `OPENCLAW200_DM_OK`.

Latest known green runtime dev run after git-archive replay + rebuild + compose recreate:
`s1-dual-200-20260511T094344`.

For cloud feature parity, also run a feature matrix that covers:

- 199 native table card rendering: raw card contains a `table` element.
- 199 Knowledge QA through lark-cli user token.
- 199 -> 200 A2A.
- 199 `/gpt` and `/opus` model switches.
- 200 Hermes Knowledge QA through lark-cli user token.

Latest known green feature run after git-archive replay + rebuild + compose recreate:
`s1-feature-20260511T094908`.

Latest known green command matrix run:
`s1-command-matrix-20260511T095943`.

S1 replay source of truth for these runs:

- Local `hermestest` `dev` HEAD:
  `1224dbb CarHer dual: keep Feishu secrets out of compose`.
- S1 `/Data/hermestest/.carher-dual-source-ref`:
  `1224dbbace9d90f31f7ff156364ee4e958a86123` (Hermes engine source; later `dev` change is doc-only).
- S1 `/Data/carher-runtime/.carher-runtime-source-ref`:
  `742ff12` / local full SHA `742ff122e346db4d32fc60179794dc02b47365b9`.
- Rebuilt `hermestest:dev`:
  `sha256:f3729711a3c7137dd87607a25977eb3a517ecfc0ce0b33fae8b085cca3396e2e`.
- Rebuilt `hermestest:dual` for 200:
  `sha256:24ad6668aebac4f6760db36d7282dbba8dbf27a88f38a3fb59e1677a05db4369`.
- Rebuilt `carher-runtime:dev` for 200:
  `sha256:e9d17af6e22e7afe6727fd539289cc9e512595fde255ddc2566004c1ecc66cb8`.
- Final 200 safe state after feature E2E:
  `/data/.engine/active=openclaw`.

Do not use `hermestest-dual-engine` or `hermestest` as the deployment source
for new runtime work. Runtime code, supervisor, switch glue, compose, rollback,
and E2E live in `carher-runtime dev`. Engine UX patches stay in
`carher-openclaw` and `carher-hermes`.

Do not claim 199/200 parity by only inspecting live containers. The required
release proof is: local git commit/tag/bundle -> `git archive HEAD` to S1 ->
S1 build -> compose recreate -> this E2E matrix.

Dual-engine lark-cli trap: 200 has two homes. OpenClaw uses `HOME=/data`;
Hermes uses `HOME=/opt/data`. A valid OpenClaw token does not prove Hermes
tools work. Feishu refresh tokens rotate, so a copied Hermes token store can
become stale after OpenClaw refreshes the user token. Verify both:

```bash
docker exec hermestest-200 sh -lc 'env -u HERMES_HOME -u HERMES_DATA_DIR HOME=/data lark-cli auth status'
docker exec hermestest-200 sh -lc 'HOME=/opt/data HERMES_HOME=/opt/data HERMES_DATA_DIR=/opt/data lark-cli auth status'
```

If the Hermes command shows the user but says no token, copy the encrypted token
store as a pair; the `*_ou_*.enc` file and `master.key` must come from the same
directory:

```bash
docker exec hermestest-200 sh -lc 'rm -rf /opt/data/.local/share/lark-cli && mkdir -p /opt/data/.local/share && cp -a /data/.local/share/lark-cli /opt/data/.local/share/lark-cli'
```

The current dual entrypoint does this automatically when Hermes has no
`*_ou_*.enc` user-token file, and it now compares token-store mtimes so the
newer OpenClaw or Hermes store refreshes the older side after refresh-token
rotation. If a heartbeat sees `needs_refresh`, run `auth status --verify` on
the active/fresher side first; if the inactive side becomes `no_token`, replace
its whole `.local/share/lark-cli` directory from the valid side and rerun
verify.

Busy-mode parity: OpenClaw's default behavior is `steer`, not `queue`. Hermes
parity configs must set `display.busy_input_mode: steer` and should keep
busy-ack cards disabled for one-card group UX.

### Dual-engine S1/S3 13/14/75 gate

Use this gate when validating the 2026-05-11 dual gray baseline:

- `hermestest-13` = S1 dual baseline, owner 卜弋天, default `openclaw`.
- `hermestest-14` = S3 dual baseline, owner 刘国现, default `openclaw`.
- `hermestest-75` = S3 dual baseline, owner 林森, default `openclaw`.
- Test group: Her 产品测试群 `oc_d62389662e7fb4405477265912c00951`.
- Group mention ids:
  - `弋天的her`: `ou_9edec5b24a9d5399a68feb118d3a03bc`
  - `国现的her`: `ou_3f04c45ab940dfd5f64dfff240d85951`
  - `林森的her`: `ou_31044043927cc567e65d71b8d1e947df`

Required PASS evidence before claiming parity:

- `docker ps` shows 13/14/75 as `hermestest-*` with `healthy`.
- `/data/.engine/active` is `openclaw` as the safe final state.
- Image id matches the frozen baseline unless intentionally changed:
  `sha256:dce47696b6d96f54de54942199ff5bfd7f2e5b2613198e9a88c8b103c61fb448`.
- `/hermes` and `/openclaw` work for each bot's owner allowlist; non-owner rejection is expected.
- Hermes replies can read the immediately preceding OpenClaw switch card.
- OpenClaw replies can read the immediately preceding Hermes switch card.
- `/new` works in all group command shapes:
  - `@bot /new`
  - `/new @bot`
  - `/new @bot1 @bot2`
- Group history injection recovers a fresh anchor from the prior message.
- knownBots renders app senders as `弋天的her` / `国现的her` / `林森的her`, not raw `cli_*`.
- Interactive card/file history is visible; no `"请升级至最新版本客户端，以查看内容"` fallback in model-visible history.
- Knowledge QA through lark-cli user token returns a `KQA*_OK` marker.
- ACP/acpx, daemon/gateway probe, memory index/reset-index, and one ordinary Feishu read operation return OK markers.
- A2A true call is verified from logs, not only from prose. Latest S3 proof:
  14 called 75 and 75 log contained `A2A75_INBOUND_OK HER_S3_A2A_KNOWN_20260511T062809Z`,
  with `task.started`, `task.finished`, and JSON-RPC 200.

Rollback for 13/14/75 is always: stop `/Data/hermestest/deploy/carher-N/compose.dual.yaml`,
then start the original `/Data/CarHer/deploy/carher-N` compose. Do not delete volumes.

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

   Do **not** compress this into
   `S1_PW=$(awk ...) sshpass -p "$S1_PW" ssh ...`. The `$S1_PW` argument is
   expanded before the same-line temporary assignment is visible, so `sshpass`
   can receive an empty/stale password and falsely fail with
   `Permission denied`. Use two lines, a semicolon, or the `s1` helper from the
   `docker-fleet` skill.

3. Keep evidence under `artifacts/her-e2e/<run-id>/` in the active worktree. Save raw lark-cli JSON, relevant docker log snippets, and a short `result.md`.

## Finding A Test Chat

Prefer a chat_id already visible in recent inbound logs for the test bot:

```bash
S1_PW=$(awk '/^10\.68\.13\.186/ {print $3; exit}' docker/servers.txt)
sshpass -p "$S1_PW" ssh -o StrictHostKeyChecking=no cltx@10.68.13.186 \
  'docker logs carher-200 --since 6h 2>&1 | grep -E "oc_[0-9a-f]+|chatId|chat_id" | tail -80'
```

Again, keep the password assignment separated from the `sshpass` command; do
not put `S1_PW=$(...) sshpass -p "$S1_PW"` on one line.

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

For bot mentions, do not guess from `cli_xxx`. First resolve the bot's group
member `bot_id` through the real chat:

```bash
lark-cli im chat.members bots --as user \
  --params '{"chat_id":"oc_xxx"}' \
  --format json
```

Then use the returned `bot_id` (usually `ou_...`) in the `<at user_id="...">`
tag. If you use `cli_xxx`, lark-cli may send `<at user_id="">name</at>`,
which is only text and will not trigger the bot.

If exact mention payload is still uncertain, send the message manually in the Feishu UI and then use lark-cli to fetch the raw message JSON as the ground truth.

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

| Case            | Trigger                                         | Expected evidence                                                                                                                                  |
| --------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| group-new-head  | `@bot /new`                                     | log has `detected system command` and `system command dispatched (delivered=true)`; no `dispatching to agent`; user sees `✅ New session started.` |
| group-new-tail  | `/new @bot`                                     | same as above                                                                                                                                      |
| group-new-multi | `/new @bot1 @bot2`                              | each addressed bot handles system command directly; no LLM `noreply`                                                                               |
| group-status    | `/status @bot`                                  | one system status response; no double reply                                                                                                        |
| history-card    | recent history includes `msg_type=interactive`  | injected context has readable card text, not `请升级至最新版本客户端，以查看内容`, not raw card JSON                                               |
| known-bots      | group contains multiple Her app senders         | model-visible sender labels include names like `弋天的her (cli_...)`, not bare `cli_...` only                                                      |
| reply-chain     | trigger is a reply/thread message               | context includes `message_id`, `message_type`, and `reply_to_id` when lark-cli exposes them                                                        |
| card-output     | normal Her answer                               | user-visible reply is an interactive card unless a documented fallback applies                                                                     |
| card-coalesce   | prompt asks for 5-8 short numbered points       | one bot turn should produce one interactive card, not many `post`/card fragments                                                                   |
| tool-coalesce   | prompt asks bot to inspect something with tools | tool/progress/final output should remain in one card when the channel supports it; any fallback fragments must be explained by logs                |
| footer-status   | normal Her answer                               | final card footer is one compact grey line: elapsed, short model alias, group mode, context ratio, and `🧹N` only when compactions > 0             |
| cron-card       | one-shot cron with `--message ... --announce`   | cron/direct outbound final text is `msg_type=interactive`, not old `post`; explicit card JSON must still pass through without double wrapping      |
| self-send       | bot sends a proactive/follow-up style message   | bot-originated outbound path is interactive/card-shaped or explicitly documented as a safe fallback                                                |
| a2a-route       | S1 test bot asks for an S3 bot capability       | A2A logs show registry lookup and LAN endpoint route when peer is remote                                                                           |

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

## Validated Baseline

2026-05-10 run `20260510T_footer_final` on docker200 / `研究3` in chat `oc_394c3ebe4ca009aba9b5662cce366810` is the current reference:

- `footer_v4_ready`: one `interactive` reply; lark-cli rendered `<card> footer-v4-ready-ok --- 耗时 11.5s · opus4.7 · 👥群@ · 70.7k/1.0m (7%) </card>`.
- `coalesce_long`: six-point answer produced exactly one `interactive` bot message after the trigger.
- `tool_coalesce`: logs showed `tools=[exec]`; final user-visible output was still exactly one `interactive` card.
- `/status @bot`: exactly one system status reply; no double reply.
- `/new @bot` and `@bot /new`: exactly one `✅ New session started.` each; logs showed `detected system command` and `system command dispatched (delivered=true)`.
- `history_card_context`: without tools, bot read a previous interactive card from injected context and rendered `研究3 (cli_a96f044b4ef95cc0)`, not a bare `cli_...`.
- `cron_card_after`: one-shot cron announce previously produced `msg_type=post`; after R-11 the same path produced `msg_type=interactive` with `<card> cron-card-after-ok </card>`.

## Server Log Checks

Patch markers that must appear after container start:

```bash
docker logs carher-200 2>&1 | grep -E "stripBotMentions|command-body normalize|channel-only|contracts.tools \(30\)|shadow-daemon|history-fill|inbound-history metadata|reply-card default|outbound-card default|footer-status|patch-agent-loop|session-decay|PATCHED"
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
