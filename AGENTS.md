# SqlRite — Working Plan

Status doc for in-flight hardening work. Delete sections as they land.

## Context

SqlRite is a zero-dependency, SQL-first wrapper over `node:sqlite` (Node >=25).
Three facades share one core:

- `SqlRiteCore.js` — static utils: file scan, tag parse, templating, PRAGMA/option setup, custom fns.
- `SqlRiteSync.js` — sync facade over `DatabaseSync`.
- `SqlRite.js` + `SqlWorker.js` — async facade; DB lives in a Worker thread, promise-keyed message protocol.
- `scripts/codegen.js` — emits `SqlRite.d.ts` for the dynamic methods.

Tags: `-- INIT:` (auto-run DDL/pragma), `-- EXEC:` (string-templated exec), `-- PREP:` (prepared stmt → `.all/.get/.run`).

## Findings driving this work

1. **`PRAGMA dml_strict` is fiction** — not a real SQLite pragma; silently ignored (verified: reads back `undefined`, same as an invented pragma). The behavior it claimed (reject double-quoted-string misfeature) is **already on by default** in `node:sqlite` via `enableDoubleQuotedStringLiterals: false`. Verified on Node 25.8.1.
2. **Foreign keys** have a first-class constructor option `enableForeignKeyConstraints: true` (cleaner than post-hoc `PRAGMA foreign_keys = ON`).
3. **`readBigInts` option + `stmt.setReadBigInts(true)`** both exist — clean fix for issue #6 (INTEGER capped at 2^53). Per-statement form matches the issue's preferred per-`PREP` opt-in.
4. **EXEC docs are wrong**: labeled "Transaction" (it wraps nothing); headline example interpolates an identifier through value-escaping → invalid SQL. EXEC templating only fills *value* positions, and does so by unsafe string interpolation.
5. Async/worker model **cannot accept a JS callback** for transactions (can't postMessage a closure) — rules out better-sqlite3-style `db.transaction(fn)`.

## Plan

### Phase 0 — Decisions (SETTLED)
- [x] D1: **Hardened connection posture via passthrough.** A frozen `SqlRiteCore.#HARDENED` ({ enableForeignKeyConstraints:true, enableDoubleQuotedStringLiterals:false, defensive:true }) spread *under* user options. `SqlRiteCore.openDb(options)` constructs the DB once; all sites call it. Verified: `DatabaseSync` tolerates unknown keys (dir/functions/params pass through), throws on bad option types (fail-hard), user options override HARDENED. No allowlist maintained — only the three deviations.
- [x] D2: **EXEC = reframe docs only** (no identifier marker this round). Drop the false "Transaction" label + broken identifier example. State trusted-SQL-only contract; PREP is the only value-parameterized path.
- [x] D3: Transaction primitive — **RESOLVED: declarative `-- TX:`.** `-- EXEC` made transactional (BEGIN/COMMIT/ROLLBACK around a templated body). Composition stays in the `.sql` file — no JS batch/call-list API. Templated like EXEC (trusted input); returns write metadata, not rows. The earlier batch-API `transaction(calls)` was removed.
- [ ] D4: BigInt / issue #6 — **DEFERRED** pending explicit go/no-go (shape: per-PREP marker vs per-instance option). README states current 2^53 read behavior accurately meanwhile.

### Phase 1 — Hardened posture (do now)
- [ ] Add `SqlRiteCore.#HARDENED` + `SqlRiteCore.openDb(options)`.
- [ ] Remove `PRAGMA dml_strict = ON;` from `initDb`; `initDb` keeps only WAL, synchronous=NORMAL, regexp(), uuid(). Drop the post-hoc `PRAGMA foreign_keys` (now a constructor option).
- [ ] Route all three construction sites (`SqlRiteSync` ctor, `SqlRiteSync.open`, `SqlWorker`) through `openDb`.
- [ ] Tests: `WHERE x = "literal"` throws "no such column"; FK still enforced; `UPDATE sqlite_schema` blocked under defensive; user override (`defensive:false`/DQS) honored.

### Phase 2 — EXEC reframe (docs, folded into README)

### Phase 3 — Docs consolidation
- [ ] Merge README.md + LLMS.md into one accurate, terse, LLM-oriented README.md. No marketing. Delete LLMS.md + its references.

### Phase 4 — Verify
- [ ] `npm run check` (lint + test) green; coverage >=80/80/80.

### Phase 5 — Transactions (D3, DONE)
- [x] Declarative `-- TX:` tag — templated multi-statement body run via `db.exec()` wrapped in BEGIN/COMMIT, ROLLBACK+rethrow on error. Sync + async (one worker round-trip). Generated as a method like EXEC. The whole transaction is one SQL block; no JS composition.
- [x] Removed the injected batch API `transaction(calls)` (method, `TRANSACTION` worker type, `#protected` reservation, codegen `SqlRiteTxCall`) — it expressed transaction composition in JS, off-paradigm. Superseded by `-- TX:`.
- [x] EXEC, TX, and `PREP .run()` return write metadata `{ changes, lastInsertRowid }` via `SqlRiteCore.prepareMeta`/`result` (a read of `last_insert_rowid()`/`changes()`). The per-statement `bigint` flag is the single switch for *all* integer output: flagged → both fields `BigInt` (lossless past 2^53); unflagged → `number`, and a rowid past 2^53 throws rather than rounding (same no-silent-loss contract as columns). Two cached meta statements per connection (`setReadBigInts` on/off), selected per chunk flag. Codegen emits `SqlRiteResult`/`SqlRiteBigIntResult` (+ prepared-statement variants) per flag.

### Phase 6 — BigInt / issue #6 (D4, DONE)
- [x] Per-PREP `bigint` flag → `stmt.setReadBigInts(true)`. Parser captures trailing flags (also fixes latent trailing-text-leaks-into-SQL bug). Sync + async (BigInt survives structured clone). `readBigInts` passes through for connection-wide default.
- [ ] Close issue #6 (after user review / merge).

### Phase 7 — Checked-JS typecheck (DONE)
- [x] JSDoc typedefs (`SqlRiteOptions`, `Chunk`, `Chunks`) + field/param annotations. No TS source — stays zero-build (Node forbids type-stripping under node_modules, so a published lib can't ship .ts).
- [x] `tsconfig.json`: `checkJs` + `strict`, `noImplicitAny: false` (keep strictNullChecks, skip per-callback annotation). `typecheck` script folded into `check`.
- [x] Surfaced + fixed two real bugs: `openDb` undefined-path contract; unnarrowed `seen.get()` in `parseSql`.

### Phase 8 — Release prep (DONE)
- [x] `package.json`: version `4.0.0` (major — `defensive:true` default can break callers); `files` allowlist (ships runtime + codegen only).
- [x] `npm run check` green — lint + typecheck + 40 tests, coverage 97.49 / 89.66 / 94.44.
- [x] `npm pack --dry-run` verified: LICENSE, README, 4 runtime JS, package.json, scripts/codegen.js.

## Conventions
- Conventional commits (`feat:`, `fix:`, `docs:`, `build:`...). One class per file, `#private` fields, ESM, double quotes, tabs.
- Tests: `node --test`, native asserts, specific error matchers. Unit alongside; integration in `test/integration/`.
