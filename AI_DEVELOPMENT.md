# AI Development Report

## Tools and models

- Claude Code,  Opus 5.5 / Sonnet 4.6
- Cursor - Grok

## Workflow

- Standards: had AI draft engineering-standards.md (coding conventions) before any code.
- Spec: AI read inventory-service-exercise.md and drafted spec.md in the required format. It asked me about gaps, I answered, then AI critiqued its own draft. We repeated this until no open questions remained.
- Each milestone (M0–M5, spec §11) was built with a test-first skill (tdd-implementation-loop): write the tests, confirm they fail for the right reason, write the minimum code, then run the typecheck and the full suite. The skill stops and asks me after 3 failed fixes on the same error, or before changing the spec or weakening a test.

## Review and verification

- After each milestone I verified it myself: ran npm test for milestones with no API surface, and exercised the API with Bruno using docs/openapi.json.
- Review code manually, focused on validation, error handling and the DB driver boundary.
- ran /code-review skill after each milestone; one of the trend identified was ENUMS were not created, so had to prompt the AI to update the string literals with the ENUMs and update the standards.md rule


## Example of corrected AI output

- During design phase, node:sqlite was pointed out as experimental and a JSON file system based solution was proposed. JSON file system works, but less extendable so
- Had to prompt the AI to create driver file in such a way that we can swap it to any other DB later, initially the DB was tightly coupled during
- FEED_HASH_VERSION was never used, so DB just got 1 by default. This would create the hash to not match if either of the CONST or value in DB changed
- changed VIN validation, added D-10, and flipped unknown-key handling (A-2) from strict to ignored.

## Time spent
Total: ~3 hours. 
- Standards and spec: ~40 min. 
- Implementation: ~2 h. 
- Docs: ~30 min.
- final review ~10 mins


## Timebox limitations

  - Milestones were larger than typical stories, so each review covered more than ideal.
  - Code review was lighter than I'd like; I relied on the test suite where coverage was strong.
  - Docs apart from spec.md were proofread only lightly; minor typos may remain.
  - No CI pipeline (e.g. GitHub Actions) was added; tests run locally via npm test.
