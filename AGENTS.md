# AGENTS.md

Guidance for coding agents working in this repository.

## Normative style guide

Follow the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html).
The tooling mirrors [gts](https://github.com/google/gts): ESLint enforces the rules, Prettier
enforces formatting (single quotes, 80 columns, `{noSpaces}`, `x => x`).

## Hard rules

- Use **named exports only**. No `export default`.
- Use `const` by default; `let` only when reassigned. Never `var`.
- Use **single quotes**, 2-space indentation, semicolons, trailing commas.
- Keep lines at **80 columns**; let `npm run fix` wrap them.
- Use `unknown` (not `any`) when a type is genuinely unknown.
- Never use `@ts-ignore` or `@ts-nocheck`. `@ts-expect-error` only in tests, with a description.
- Use `import type` for type-only imports.
- Prefer `interface` over object-literal `type` aliases.
- Prefer function declarations for named functions; use arrow functions for callbacks.
- No `namespace`, no `require`, no `#private` fields (use `private`), no `new Array()`.
- Use `===`/`!==`, `readonly` where possible, and explicit `return` in every code path.
- Always give flow control statements (`if`, `else`, `for`, `while`, `do`) a braced body;
  never a bare single statement.
- Where the guide is silent, match the surrounding code.

## Commands

| Command | Purpose |
|---|---|
| `npm run check` | Type-check + lint + format check (definition of done) |
| `npm run fix` | Auto-fix lint and formatting |
| `npm run typecheck` | Type-check only (`tsc` 7) |
| `npm test` | Vitest |
| `npm run build` | Emit `dist/` |

Before finishing a task: `npm run check` and `npm test` must pass. Never edit `dist/`
by hand, and keep formatting-only changes separate from behavior changes.

## TypeScript setup (do not "simplify" this)

`typescript-eslint` does not support the TypeScript 7 API yet, so the project runs
the compilers side by side, per TypeScript's documented workaround:

- `@typescript/native` (aliased `typescript@7`) provides the `tsc` binary used by
  `build`/`typecheck`.
- `typescript` is aliased to `@typescript/typescript6` and provides the TS **6.0 API**
  that typescript-eslint imports.

Do not change these aliases until typescript-eslint supports TypeScript 7.1+.
Type-aware lint rules are intentionally disabled for now; `tsc --noEmit` is the type gate.

## Layout

- `src/bitcoin/` — Bitcoin Core RPC and node status
- `src/services/` — IBD monitor and progress sampling
- `src/storage/` — SQLite repositories
- `src/telegram/` — grammY bot and message formatting
- `src/cli/` — one-off commands (migrations)
- `test/unit/`, `test/integration/` — Vitest suites
- `config/config.example.yaml` — documented configuration shape
- `PLAN.md` — full implementation plan; `README.md` — operator docs
