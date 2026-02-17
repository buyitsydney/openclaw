---
name: test-case-authoring
description: Write and validate deterministic test cases for bug fixes and regressions. Use when adding tests, discussing test strategy, or proving old-version-fail and latest-version-pass behavior. For e2e, enforce 100% real user scenario validation.
---

# Test Case Authoring Rules

## Core Goal

Tests must prove real behavior and prevent rollback.

## Mandatory E2E Rule (HIGHEST PRIORITY)

Any `e2e` test case MUST use a 100% real user scenario.

Hard requirements:

1. Real source data path (same format as user operation).
2. Real destination system (no mock/stub for destination behavior).
3. Real operation path (same tool/command path users actually use).
4. Real output verification on the exact target that was written.

If the above cannot be satisfied, do not call it e2e. Mark it as integration/simulation test.

## Anti-Rollback Proof Protocol

When a test is for regression proof, this loop is mandatory:

1. Run tests on latest code (baseline).
2. Switch implementation to known old SHA.
3. Re-run exact same tests with test files unchanged.
4. Confirm old code fails with behavioral assertions.
5. Restore latest implementation and re-run; confirm pass.

No static-only proof is allowed (no symbol-name, grep-only, or compile-only claims).

## Deterministic Test Authoring Checklist

- Assert behavior outcomes, not internals.
- Include failure message that points to user-visible symptom.
- Keep test input fixed and reproducible.
- Keep verification metrics explicit (counts/order/content integrity).
- Separate fast unit/integration tests from expensive e2e runs.

## Naming and Execution

- Fast checks: `*.test.ts`
- Real end-to-end: `*.e2e.test.ts`
- Expensive e2e should have a dedicated command (not default fast CI path).

## Feishu Doc Specific Guidance

For Feishu doc write regressions:

- Source: local markdown snapshot copy (never mutate original source file).
- Destination: dedicated cloud test folder/doc only (never production doc).
- Verify using destination document block data (`list_blocks`) on the exact written doc.
- Record run report/log path for audit.
