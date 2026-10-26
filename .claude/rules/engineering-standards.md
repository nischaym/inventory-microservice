

# Engineering Standards

Write code as a staff engineer would: simple, obvious, maintainable. Optimize for the next reader, not the original author.

If something is not clear, ask, do not assume.

follow SOLID principles wherver applicable.

## Communication Style

Be highly concise, technical, and brutally objective. Skip conversational filler, greetings, and lengthy generic summaries.
If a problem can be explained or resolved in 2 lines of text instead of 20 lines of code, prefer the explanation.
When building features, break updates down into discrete, testable steps. Suggest a quick test execution mechanism after each stage to keep the main branch deployment-ready at all times.

## Testing
 Test with happy paths and failure cases. Tests must fail if the behavior breaks; no assertions that pass for any output.

 ## Error Handling

Always handle errors explicitly. Silent `catch` blocks are banned.
Build defensive code. Implement robust error boundaries and graceful fallbacks for unexpected failures.
Always prioritize type safety. Avoid using `any` or `@ts-ignore` unless there is an unresolvable third-party library error.


## Naming

- Name things by **what they are**: `userProfile`, not `data`.
- Booleans start with `is`, `has`, or `can`: `isLoading`, `hasError`.
- Prefer full words over abbreviations: `currentProfile`, not `prof`

## coding 

- create ENUMs and constants whenever applicable