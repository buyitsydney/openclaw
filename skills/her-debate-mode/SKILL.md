---
name: her-debate-mode
description: Trigger deterministic dual-model routing for Her. Auto-detect mode (挑刺/辩论/合作), default 挑刺, default 2 rounds, enforce Feishu-visible progress, and output 结论/TODO/风险.
metadata: { "openclaw": { "emoji": "⚔️" } }
---

# her-debate-mode

Deterministic dual-model orchestration for Her (挑刺 / 辩论 / 合作).

## Trigger

Use this skill when user provides a concrete task/topic and asks for any of:

- 挑刺/审查/找漏洞/评审
- 辩论/debate/对辩
- 合作/共创/collab
- or asks for multi-round cross-model discussion without naming mode explicitly

If no concrete topic is present, do not guess. Ask user to resend with topic in this format:

`<模式可选>：<任务内容>，<N>个来回`

## Deterministic Mode Routing

1. If user explicitly sets mode (`模式=挑刺/辩论/合作`), obey explicit mode.
2. Else classify by keyword with fixed priority:
   - `挑刺` keywords: `挑刺`, `审查`, `找漏洞`, `批判`, `critic`
   - `辩论` keywords: `辩论`, `对辩`, `debate`
   - `合作` keywords: `合作`, `共创`, `协作`, `collab`
3. If multiple keyword groups are matched, use fixed priority: `挑刺 > 辩论 > 合作`.
4. If none matched, default to `挑刺`.

## Rounds

- Parse explicit round count `N` from text (`N个来回`, `N轮`, `N rounds`).
- If missing, default `N = 2`.
- Integer only. Valid range: `1 <= N <= 10`.
- Out of range => return direct correction request.

## Hard Rules

- No fallback behavior.
- No random strategy changes.
- One execution = one deterministic pipeline.
- Keep Opus as main controller forever; Codex is the only child session.
- Use `openrouter/openai/gpt-5.3-codex` as child model.
- `挑刺` mode must NOT provide alternative solutions. Only identify problems, evidence, and risk.
- Final summary must contain exactly three sections: `结论` / `TODO` / `风险`.

## Feishu Visibility (Mandatory)

The process must be visible in chat. Do not run silently.

1. Before first round, send one kickoff line:
   - `【模式:<mode>｜轮次:<N>】任务已启动`
2. After each round, send one progress block:
   - `【第 i/N 轮】`
   - `Codex状态: OK | TIMEOUT | ERROR:<reason>`
   - `Opus处理: 已完成`
   - `当前结论快照: <one-line>`
3. Before final summary, send one process recap line:
   - `【流程总览】R1=...; R2=...; ...`
4. Keep progress concise and human-readable for Feishu chat.

## Execution Pipeline

1. Resolve mode (`挑刺/辩论/合作`) and round count `N`.
2. Extract task/topic from the user message.
3. Call `sessions_spawn` exactly once:
   - `runtime: "subagent"`
   - `model: "openrouter/openai/gpt-5.3-codex"`
   - `label: "dual-codex"`
   - `mode: "run"`
   - `task`: initialize Codex with strict announce behavior:
     - If it receives `Agent-to-agent announce step.`, it must reply exactly `ANNOUNCE_SKIP`.
4. Run `N` rounds with `sessions_send` against the same child session.
   - Use `timeoutSeconds: 90` for each round.
   - Build round prompts by mode:
     - `辩论`: ask Codex to present/defend position; Opus gives counter-arguments for next round.
     - `合作`: ask Codex to co-build and refine the same solution; Opus integrates and sends focused refinement requests.
     - `挑刺`: ask Codex only for flaws/risk/evidence/trigger conditions. No alternatives allowed.
   - If round status is `timeout` or `error`, record it as deterministic marker:
     - `R{i}=TIMEOUT` or `R{i}=ERROR:<reason>`
     - Continue to next round (do not abort, do not switch model, do not fallback).
   - If round is `ok`, record `R{i}=OK` and save concise round findings.
   - After each round, emit mandatory Feishu progress block.
5. Finalize:
   - Synthesize all rounds.
   - In `挑刺` mode, keep summary focused on issues/risk/verification actions; do not provide alternative design plans.
   - Output only:
     - `结论`
     - `TODO` (numbered actionable items)
     - `风险` (clear risk list)

## Output Contract

Do not prepend/append extra sections.
Do not include tool-call details in final summary.
Do not output raw inter-session announce contents.
Keep each per-round message concise to reduce timeout risk.
