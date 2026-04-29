---
name: bug-fix-discipline
description: |
  Mandatory 5-step TDD workflow for ALL bug fixes: reproduce → fix → retest → only then grayscale.
  Activates whenever the user reports a bug, a regression, a compatibility issue, or asks "fix it".
  Violating this workflow wastes online time, causes cascading failures on live grayscale, and the
  user has ZERO tolerance for it. Online deployment is FORBIDDEN without local tests green.
---

# Bug Fix Discipline (铁律 — 违反者死)

## 5-Step Rule — NO EXCEPTIONS

Every bug fix MUST follow this exact order. Skipping any step, or reordering, is a violation.

### Step 0 — Baseline green

Run the existing test suite. Verify it's all green BEFORE touching anything. Establishes a trusted
baseline — if something breaks during your fix, you know it was your change, not pre-existing drift.

```
cd <test-dir> && <test-cmd>    # expect: N passed
```

If baseline is red, STOP. Fix the pre-existing failures first or explicitly confirm with user
that you're proceeding with a known-red baseline.

### Step 1 — Write FAILING tests for each reported bug

Enumerate every claimed bug, every boundary, every stress scenario. Write tests that will FAIL
against current (unfixed) code. The test failures ARE the bug reproductions.

This step is the MOST important. If you cannot write a failing test, you don't understand the bug.

Examples of coverage to enumerate:

- boundary: empty input, huge input, Unicode, bidi, symlinks, zip bombs, OOM, OOD
- concurrency: create-during-delete, rapid bursts, per-path race
- recovery: daemon killed mid-op, container restarted, network flaky
- state transitions: idle → ready, config appear/disappear, deps install/uninstall lifecycle

### Step 2 — Run the new tests → confirm FAIL

Expected: every new test FAILS. This PROVES the bugs exist in current code. If a test passes
unexpectedly, your understanding of the bug is wrong — re-read the user's report, instrument more.

If ANY new test passes here, you cannot move to Step 3. Go back, re-investigate.

### Step 3 — Fix the code

ONLY now touch production code. Write the minimal change that makes the failing tests pass.
Do NOT add unrelated cleanup, "improvements", or refactors in the same commit.

### Step 4 — Run ALL tests → confirm GREEN

Run the FULL suite (old + new). Every test must pass. Partial green is NOT acceptable.

If a previously-passing test now fails, you caused a regression. Revert, narrow your fix, try again.

Run multiple times (at least 3) if tests are timing-sensitive — flaky green is not green.

### Step 5 — Only now may you propose grayscale

Summarize: bugs reproduced (test names), fix (commit hash or diff summary), all tests green
(N passed, 0 failed).

Then ASK before deploying. User may want to review the diff. Deployment without Step 5 = violation.

## What you must NEVER do

- ❌ "I'll fix it then verify on the live system" — zero value, online time is expensive
- ❌ "The test passed so the fix works" — passed what? Baseline? Or the reproducing test?
- ❌ "Let me first patch the skill/doc to work around it" — patching humans around a bug is a hack,
  not a fix
- ❌ Skip writing a test because "it's obvious" — obvious fixes regress too; a test is the
  memory that prevents future regressions
- ❌ Deploy a "quick test" image to grayscale to see if it works — online is not a test env

## Violation consequences

The user has explicitly stated: NO online deployment without all of the above. Violating this
burns user trust and real money (container rebuilds, S1→S3 image transfers, user downtime).
Past violations in this project cost multiple hours each.

## How this differs from normal TDD

Standard TDD has "red → green → refactor". This is RED → GREEN for bug fix specifically, with:

- Step 0 pinning baseline (so fix attribution is clean)
- Step 2 requiring ALL new tests fail (proves every claimed bug is real, not just the easy one)
- Step 4 requiring ALL old tests still pass (no regressions)
- Step 5 gating online work on local green

## Checklist (copy into chat before proposing a fix)

```
[ ] Step 0: baseline suite green — ran X tests, all passed
[ ] Step 1: wrote N failing tests covering bugs A, B, C
[ ] Step 2: ran new tests → N failed as expected (bug reproduction confirmed)
[ ] Step 3: code change in <files>, diff ~X lines
[ ] Step 4: full suite ran → X+N passed, 0 failed
[ ] Step 5: ready to propose grayscale, awaiting user approval
```

Agent may not claim a fix is "ready" without filling this checklist.
