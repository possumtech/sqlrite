# AGENTS.md

Instructions for AI agents. [SPEC.md](SPEC.md) is the complete behavior
contract — read it before writing code against or inside this library.

## Integrating SqlRite into an app

- Every database operation is a tagged block in a `.sql` file. Discover the
  API: grep `-- PREP:` / `-- EXEC:` / `-- TX:`. Discover schema: grep
  `-- INIT:`. Each tag `name` becomes `db.<name>` on the opened instance.
- Add an operation by adding a tagged block, never by writing SQL strings in
  JS. Regenerate exact method types afterward:
  `node node_modules/@possumtech/sqlrite/scripts/codegen.js` (wire the output
  via a tsconfig `paths` override — see SPEC.md#type-generation).
- Evolve schema by appending a `-- MIGRATE: <n>` block with the next integer
  version (grep `-- MIGRATE:` for the current max). Applied once per database,
  atomically, before `-- INIT`. Never edit an applied migration; put
  non-idempotent DDL (`ALTER TABLE`) here, never in `-- INIT`.
- Trust boundary: `-- PREP` binds parameters and is the only path for runtime
  or untrusted values. `-- EXEC` / `-- TX` string-interpolate — developer-
  authored SQL only. Routing user input through them is SQL injection.
- Transactions are declarative: one `-- TX` block, `BEGIN`/`COMMIT`/auto-
  `ROLLBACK`. There is no JS transaction API by design.
- Integers past 2^53 throw unless the tag carries the `bigint` flag.
- Async facade rejects with the worker's real Error (class, stack, cause).

## Working on this repository

- Paradigm invariants are in SPEC.md#paradigm--invariants. Violating them
  (query builders, JS transaction composition, PRAGMA passthrough, env
  config) is a break, not a refactor.
- Conventions: SPEC.md#conventions. Conventional commits scoped to an issue
  (`#0` when none). Tabs, double quotes, ESM, one class per file, `#private`
  fields.
- Gate before any commit: `npm run check` (biome + tsc + node --test,
  coverage thresholds 80/80/80). Unit tests live beside their source;
  integration tests in `test/integration/`.
