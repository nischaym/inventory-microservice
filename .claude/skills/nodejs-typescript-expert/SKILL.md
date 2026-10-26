---
name: nodejs-typescript-expert
description: Standardizes backend development by enforcing strict TypeScript type safety, Node.js runtime best practices, and modern package idioms. Use this skill when writing backend logic, setting up configurations, fixing compilation bugs, or structuring REST APIs.
---

# Node.js & TypeScript Standards

## 1. Type Safety & Compiler Constraints

- **Strict Mode**: Always enforce `"strict": true` in `tsconfig.json`.
- **No Unsafe Types**: Ban the use of `any` and unsafe type assertions (`as Type`). If a type is unknown at compile time, explicitly use `unknown` and implement type guards.
- **Data Validation**: Enforce runtime boundary validation for all incoming network payloads (HTTP requests, environment variables) using `Zod` or `Valibot`.
- **Discriminated Unions**: Prefer discriminated unions over optional flags (`?`) when modeling state or payload variants.

## 2. Node.js & Runtime Ecosystem

- **Runtime Target**: Target Node.js 22 LTS or newer. Prefer native Node.js APIs over heavy external dependencies where applicable (e.g., using the built-in `node:test` runner or `node:fs/promises`).
- **Module Resolution**: Use modern ESM (`"type": "module"` in `package.json`) and configure `tsconfig.json` with `"moduleResolution": "NodeNext"`.
- **Error Handling**: Use asynchronous error handling patterns, proper global boundary catches, and structured logging frameworks (like `Pino`) instead of raw `console.log`.

## 3. Workflow & Verification

- Before finishing a task, run type-checking (`tsc --noEmit`) to verify that no TypeScript compilation errors were introduced.
- Always match the active package manager found in the root lockfile (`pnpm`, `Bun`, `npm`, or `yarn`).
