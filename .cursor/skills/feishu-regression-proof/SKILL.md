---
name: feishu-regression-proof
description: Enforces deterministic anti-regression validation for Feishu Her changes. Use when adding tests, discussing regression confidence, preventing rollback, or when the user asks for old-version-fail and latest-version-pass proof.
---

# Feishu Regression Proof

## Purpose

Use this workflow to prove tests are real and can catch regressions:

1. Old implementation must fail.
2. Latest implementation must pass.
3. Test files must stay unchanged across both runs.

No fallback logic. No "looks good" by static inspection only.

## Mandatory Validation Protocol

### 1) Freeze test files first

- Add or update test files.
- Run formatter/lint if needed.
- Do not edit tests after entering validation loop.

### 2) Baseline on latest code

- Run target test commands on current code.
- Record pass/fail and key output lines.

### 3) Switch only implementation under test to old revision

- Use `git restore --source <old_sha> -- <impl_file>` for the target implementation file(s).
- Do not change test files.
- Run the exact same test commands.
- Confirm failure logs show behavioral mismatch (not trivial syntax/import issues).

### 4) Restore latest implementation and re-run

- Restore implementation from `HEAD`.
- Run the same test commands again.
- Confirm pass.

### 5) Report with hard evidence

- Include:
  - command list
  - old-version failing assertions
  - latest-version passing summary
  - explicit statement that test files were unchanged during A/B run

## What counts as valid proof

- Dynamic behavior assertions (counts, state transitions, output content, pagination results, etc.).
- Same test command and same test code for both old/new runs.
- Failure reason maps to known regression symptom.

## What does NOT count

- Static checks only (function names, grep hits, type-only checks).
- Editing tests between old/new runs.
- Weak assertions that pass in both old and new code.

## Recommended command pattern

```bash
# latest (baseline)
pnpm vitest run "extensions/feishu-her/src/tools/docx.test.ts"
pnpm test:e2e:feishu-her

# old implementation (tests unchanged)
git restore --source <old_sha> -- "extensions/feishu-her/src/tools/docx.ts"
pnpm vitest run "extensions/feishu-her/src/tools/docx.test.ts"
pnpm test:e2e:feishu-her

# back to latest
git restore --source HEAD -- "extensions/feishu-her/src/tools/docx.ts"
pnpm vitest run "extensions/feishu-her/src/tools/docx.test.ts"
pnpm test:e2e:feishu-her
```

## CI placement guidance

- Keep expensive Feishu e2e tests as dedicated commands (non-default CI lane).
- Default CI should run fast deterministic checks.
- Run Feishu e2e in dedicated/manual/nightly or opt-in workflow.
