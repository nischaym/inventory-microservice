---
name: code-review
description: Review code the way a staff engineer would - correctness, design, failure modes, tests, and maintainability - and report prioritized, evidence-backed findings. Use when the user asks for a code review, a staff-level review, "review this", or feedback on a file, directory, diff, or PR before merging.
---

# Staff Engineer Code Review

The goal is to catch what matters, not to produce many comments.

This skill only reviews. Do not edit code unless the user asks for fixes after the review.

## 1. Establish scope

1. Determine the target from the arguments: a path, a glob, a diff, a branch, or a PR. With no argument:
   - If what to review is unclear, ask the user
2. Read the project's standards before judging anything: `CLAUDE.md`, `.claude/rules/*`, Use the spec MD as the spec file, And the definition of the milestone you are reviewing, if you're reviewing a specific milestone. Findings must be measured against these, not personal taste.
3. Read every file in scope fully. For each change, also read its callers, the interfaces or ports it implements, and its tests. A diff alone is not enough context.
4. Find the build, type-check, and test commands (`package.json` scripts, Makefile, README). Run the type-check and the tests that cover the scope. Record the actual result.

## 2. Review checklist

Work through these in order. Earlier categories outrank later ones.

### Correctness
- Does the code do what the spec or request says? Check each requirement, not just the happy path.
- Edge cases: empty input, duplicates, boundaries, off-by-one, time zones and dates, large input, concurrent calls, retries and re-runs (idempotency).
- State and data: partial writes, missing transactions, ordering assumptions, lost updates.
- Async: unawaited promises, unhandled rejections, race conditions, resource leaks (handles, connections, timers).

### Failure modes and error handling
- Every error path is handled explicitly. Silent `catch`, swallowed errors, and catch-and-log-and-continue on critical paths are findings.
- Errors carry enough context to debug; they do not leak internals or secrets to clients.
- Input is validated at trust boundaries (HTTP, env, files, external feeds), not deep inside the domain.
- Graceful degradation: what happens when a dependency is slow, down, or returns garbage?

### Security
- Injection (SQL, shell, path traversal), unsafe deserialization, missing authz checks, secrets in code or logs, unbounded input sizes.

### Design and architecture
- Responsibilities are in the right layer (domain vs application vs infrastructure vs HTTP). Domain logic has no I/O or framework imports.
- SOLID where it earns its keep: single responsibility, dependencies on abstractions at boundaries, no interfaces with a single trivial implementation "for later".
- Coupling: would a likely future change (new endpoint, new storage, new field) touch one place or ten?
- Over-engineering is a finding just like under-engineering. Flag speculative abstraction, unused configurability, and indirection that does not pay for itself.

### Tests
- Behaviour that changed has tests; failure cases are tested, not just happy paths.
- Tests would fail if the behaviour broke. Flag assertions that pass for any output, over-mocking that tests the mock, and tests coupled to implementation details.
- Tests are deterministic: no real clock, randomness, network, or ordering dependence without control.

### Readability and maintainability
- Names say what things are (`userProfile`, not `data`); booleans use `is`/`has`/`can`; no cryptic abbreviations.
- Magic values become enums or named constants.
- Type safety: no `any`, unchecked `as` casts, or `@ts-ignore` without a stated, unavoidable reason.
- Functions are small enough to read in one pass; control flow is flat; comments explain *why*, not *what*.
- Dead code, duplicated logic, and inconsistency with surrounding idioms.

### Operability and performance
- Logs are structured, at the right level, and useful during an incident. Nothing sensitive is logged.
- Obvious performance problems only: N+1 queries, unbounded loops or memory over input size, blocking the event loop, missing indexes for new queries. Do not micro-optimise.

## 3. Verify before reporting

For every candidate finding:
- Point to the exact `file:line` and quote or describe the code.
- State a concrete failure scenario: the input or state, and the wrong result. If you cannot construct one, it is a suggestion at most, or drop it.
- Check that the concern is not already handled elsewhere (a caller, middleware, schema, or test). Re-read before claiming.
- Do not report style preferences that the project's standards do not mention and that do not hurt readability.

## 4. Severity

| Severity   | Meaning                                                                 | Merge? |
|------------|-------------------------------------------------------------------------|--------|
| `BLOCKER`  | Bug, data loss, security hole, or spec violation that will hit users.   | No     |
| `MAJOR`    | Likely bug under realistic conditions, missing error handling, missing tests for changed behaviour, design that will cause real pain soon. | Fix first, or ticket with an owner |
| `MINOR`    | Maintainability, naming, small duplication, weak test.                 | Yes, fix soon |
| `NIT`      | Optional polish. Keep these few.                                        | Yes    |

When unsure between two levels, pick the lower one and say why.

## 5. Report format

Keep it concise and technical. No praise padding, no restating the code.

```
## Verdict
APPROVE | APPROVE WITH CHANGES | REQUEST CHANGES — one sentence on why.

## Checks run
- typecheck: <command> → pass/fail
- tests: <command> → N passed, M failed

## Findings
### [BLOCKER] <short title>
`path/to/file.ts:42`
Problem: <what is wrong>
Scenario: <input/state → wrong outcome>
Fix: <the smallest change that fixes it; a short snippet only if clearer than prose>

### [MAJOR] ...

## Design notes
<0–3 bullets on structural concerns or trade-offs that are not line-level bugs. Omit if none.>

## What's solid
<0–3 bullets, only if useful to the author, e.g. a pattern worth keeping.>
```

Order findings by severity, then by impact. If there are no findings, say so plainly and state what you checked.

## Rules

- Never claim tests or the build pass without running them in this session. If you could not run them, say so.
- If a requirement or intent is ambiguous, list it as a question for the author instead of guessing.
- One finding per root cause; reference other affected lines inside it rather than repeating.
- After the report, offer to apply fixes. Apply them only on the user's go-ahead, then re-run the type-check and tests.
