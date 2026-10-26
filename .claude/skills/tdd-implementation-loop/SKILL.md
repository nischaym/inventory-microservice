---
name: tdd-implementation-loop
description: Implement features test-first in a loop (write tests, write code, build, test, repeat). Stop and ask the user when stuck or when a decision is needed.
---

# Test-First Implementation Loop

Use this when implementing a feature, milestone, or module from a spec or request. Work in small slices (one requirement, use case, or endpoint at a time), not the whole thing at once.

## Before starting

1. Read the spec or request. Identify the slice to implement and its requirement IDs, if any.
2. Find the project's build and test commands (for example `package.json` scripts, a Makefile, or a README). Match the package manager from the lockfile. Do not guess commands.
3. If the slice depends on an undecided design choice, ask the user first (see Decisions).

## The loop

1. **Write the tests first.** Derive them from the requirements and edge cases in the spec, not from code that does not exist yet. Cover the happy path, boundaries, and failure modes. Name each test after the behavior or requirement it checks.
2. **Confirm the tests fail for the right reason.** Run them before writing code. A test that passes with no implementation is wrong; fix the test. A failure from a typo or missing import is not the right reason.
3. **Write the minimum app code** that satisfies those tests. No extra features or speculative abstraction.
4. **Run the build, then the tests.** Use the type-check or compile step and the full test suite, not only the new tests. Read the actual output.
5. **If anything fails, fix and go back to step 4.** Fix the code. Change a test only when the test itself is demonstrably wrong against the spec, and say so when you do.
6. **When all green,** refactor if needed, re-run build and tests, then move to the next slice (step 1).

## Stop and ask the user when

- **Stuck in a loop:** the same failure (same test or same error) survives 3 consecutive fix attempts, OR 5 total iterations on one slice pass without fewer failures than before, OR you notice you are reverting and re-applying the same change. Stop. Report: what you are implementing, the failing test and exact error, what you tried, and your best hypothesis. Ask for input. Do not keep trying variations.
- **A decision is needed:** the spec is silent, ambiguous, or contradicts itself, or there are real trade-offs (library choice, error semantics, data model, behavior on an edge case). Use AskUserQuestion with concrete options and a recommendation. Do not silently pick one.
- **The fix would require changing the spec, a public API, or deleting or weakening tests.** Ask first.

## Rules

- Never mark a slice done while the build or any test is failing.
- Never skip, disable, or loosen a test to get green.
- Do not claim tests pass without having run them in this session.
- Keep each slice small enough that one failure points to one cause.
- Commit only when asked; when asked, commit at green points.

## Reporting

After each slice, give a short status: slice implemented, tests added, build and test result (counts), and anything deferred or needing a decision. After the final slice, summarize what is done and what remains.
