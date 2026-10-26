# AI DEVELOPMENT

## The AI tools and models you used

- Claude Code,  Opus 5.5 / sonnet 4.6
- Cursor - grok

## How you structured your work with AI: planning, implementation, and testing

- Asked AI to create the engineering-standards.mdc file first. -- 10 mins
- AI to review the given inventory-service-excercise.md, create a spec file with a given format. Ask   when any gaps found --> ask the user --> create a spec file --> critique the create spec file --> repeat the process --> review + creation 30 mins
- Each milestone (M0–M5, spec §11) was built with a test-first skill (tdd-implementation-loop): write the tests, confirm they fail for the right reason, write the minimum code, then run the typecheck and the full suite. The skill stops and asks me after 3 failed fixes on the same error, and before changing the spec or weakening a test.

## How you reviewed and verified AI-generated work

- After each milestone I tested it by manually (either ran the npm run test when no app code, or run the bruno client to test the API)
- Review code manually
- Use code review skill to check what needs to be fixed automatically and notify me when something needs my judgement/input


## One example of AI output you corrected, rejected, or substantially changed, and why 

- During design phase, node:sqlite was pointed out as experimental and a not extendable file system solution was proposed
- Had to prompt the AI to create driver file in such a way that we can swap it to any other DB later
- FEED_HASH_VERSION was never used, so DB just got 1 by default

## The actual time you spent
- Overall 3 hours 
  - 30 mins until spec
  - ~2 hours for code
  - 30 mins for documentation


## Any limitations introduced by the timebox

  - Milestones were bigger chuncks than typical stories
  - Would have reviewed code a bit more in detail, skipped some validations where tests were robust
  - Any typos in the readME.md or this document
  - adding a github actions