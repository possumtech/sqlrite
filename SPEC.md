# SqlRite — Specification & Reference

The behavior contract and full reference for SqlRite: the paradigm invariants,
exhaustive tag and option semantics, security limits, and the rationale behind
the shape. [README.md](README.md) is the quickstart; this is the authoritative
detail.

## Architecture

Zero-dependency, SQL-first wrapper over `node:sqlite` (Node `>=26`). Three facades
share one core:

- `SqlRiteCore.js` — static utilities: file scan, tag parse, templating,
  PRAGMA/option setup, custom-function registration, write-metadata reads.
- `SqlRiteSync.js` — sync facade over `DatabaseSync`.
- `SqlRite.js` + `SqlWorker.js` — async facade; the DB lives in a Worker thread
  behind a promise-keyed message protocol.
- `scripts/codegen.js` — emits `SqlRite.d.ts` for the generated methods.

## Paradigm & invariants

These are the contracts that define SqlRite. Changing code in ways that violate
them is a paradigm break, not a refactor.

- **SQL-first.** All database behavior is declared in `.sql` tags. Logic that
  belongs in SQL does not migrate into JS — there is no query builder, no batch
  API, no JS transaction composition.
- **One trust boundary.** `-- PREP` binds parameters and is the *only* path for
  runtime or untrusted values. `-- EXEC` and `-- TX` string-interpolate and are
  for developer-authored SQL only.
- **Fail-hard, no silent loss.** Bad option types throw at construction; integers
  past `2^53` throw rather than rounding; invalid tuning values throw at open.
  Contract violations surface — they are not absorbed by fallbacks.
- **Curated, not pass-everything.** The hardened posture and tuning knobs are a
  small, opinionated set, not a generic PRAGMA/option passthrough. Every default
  is overridable; the surface stays deliberately narrow.

## Tags

A block runs from its tag line to the next tag (or end of file). Empty blocks are
skipped. `-- INIT` names are not deduplicated; duplicate `EXEC`/`PREP`/`TX` names
emit a warning and the last definition wins. Within a directory set, files are
scanned recursively and ordered by basename numerically (`001-*.sql` before
`002-*.sql`) into one execution plan.

### -- INIT (schema & pragmas)

Runs once when the DB opens. Use idempotent DDL (`CREATE TABLE IF NOT EXISTS`)
and `PRAGMA`s. Supports `$var` templating from the `params` option (same rules as
`-- EXEC`).

```sql
-- INIT: configure
PRAGMA cache_size = $cacheSize;
```
```javascript
await SqlRite.open({ dir: "sql", params: { cacheSize: 5000 } });
```

### -- PREP (prepared statements)

The only parameterized path for runtime values. Each `-- PREP` method exposes
three modes:

| Mode | For | Returns (sync / async) |
| :-- | :-- | :-- |
| `.run(params)` | `INSERT`/`UPDATE`/`DELETE` | `{ changes, lastInsertRowid }` |
| `.get(params)` | single row | row object or `undefined` |
| `.all(params)` | multiple rows | array of row objects |

- Bind with named parameters (`$name`, `:name`, `@name`). The JS interface takes
  an object; a leading `$`/`:`/`@` on keys is stripped, so `{ name }` binds
  `$name`.
- Object and array parameter values are `JSON.stringify`-ed on input. Output is
  **not** parsed — call `JSON.parse()` yourself.
- `.run()` returns `{ changes, lastInsertRowid }`, as do `-- EXEC` and `-- TX`.
  Both fields are `number` by default, `BigInt` with the [`bigint`](#bigint-flag)
  flag; without it, a `lastInsertRowid` past `2^53` throws rather than rounding.

### -- EXEC (trusted SQL)

`db.exec()` of the block (one or more statements) after `$var` templating. For
developer-authored SQL with constant or developer-supplied inputs — DDL,
`PRAGMA`s, maintenance. It is **not** a parameterized path: string values are
single-quote escaped, numbers/booleans/`null` are inlined, and identifiers are
not handled. Never pass untrusted input through `-- EXEC`; use `-- PREP` for
runtime values.

```sql
-- EXEC: insertKv
INSERT INTO kv (key, val) VALUES ($key, $val);
```
```javascript
sql.insertKv({ key: "role", val: "admin" }); // val is escaped, not bound
// returns { changes, lastInsertRowid } — number, or BigInt with the `bigint` flag
```

### -- TX (transactions)

`-- EXEC` made transactional: the templated multi-statement body runs wrapped in
`BEGIN` / `COMMIT`, and any error triggers `ROLLBACK` before the error is
rethrown (async: rejects). The whole transaction lives in one SQL block — there
is no JS composition step; in the async facade it is one Worker round-trip.

```sql
-- TX: transfer
UPDATE acct SET bal = bal - $amt WHERE id = $from;
UPDATE acct SET bal = bal + $amt WHERE id = $to;
```
```javascript
sql.transfer({ from, to, amt }); // both statements commit, or neither does
```

Templating is identical to `-- EXEC` — values are string-interpolated, **not**
bound — so the same trusted-input contract applies. A `-- TX` method returns the
write metadata `{ changes, lastInsertRowid }` (`number`, or `BigInt` with the
[`bigint`](#bigint-flag) flag). Because the body runs via `db.exec()`, it cannot
return result rows: keep intra-transaction data flow in SQL
(`last_insert_rowid()`, subqueries) and read committed results with a separate
`-- PREP` afterward.

### bigint flag

Integers are read as JS `number` by default; a value above `2^53 − 1` throws on
read rather than losing precision. Append the `bigint` flag to a tag to read that
statement's integers as `BigInt`:

```sql
-- PREP: feeBalance bigint
SELECT SUM(amount) AS total FROM ledger WHERE account = $account;
```

The flag is the single switch for *all* of a statement's integer output, scoped
to that one statement: result columns for `-- PREP`, and the
`{ changes, lastInsertRowid }` write metadata returned by `-- PREP` `.run()`,
`-- EXEC`, and `-- TX`. Flagged → every integer comes back `BigInt`; unflagged →
`number`, and anything past `2^53` throws. A flagged value is a `BigInt`
(`typeof === "bigint"`): arithmetic cannot mix `BigInt` and `number`, and
`JSON.stringify` throws on `BigInt` (supply a replacer). For a connection-wide
default, pass `readBigInts: true` in options (it passes through to
`DatabaseSync`). Passing a `BigInt` as a parameter already works without the flag.

## Configuration

| Option | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| `path` | `string` | `":memory:"` | SQLite database file path. |
| `dir` | `string \| string[]` | `"sql"` | Directories scanned for `.sql` files. |
| `functions` | `string \| string[]` | — | Module paths for custom SQL functions. |
| `params` | `object` | — | `$var` substitutions for `-- INIT` blocks. |

All other keys pass through to the `node:sqlite` `DatabaseSync` constructor (e.g.
`readOnly`, `allowExtension`). Unknown keys are ignored; invalid option types
throw at construction.

### Connection posture

SqlRite applies these via `PRAGMA` on every connection: `journal_mode = WAL`,
`synchronous = NORMAL`.

It also sets these `DatabaseSync` options, each overridable by passing the same
key in your own options:

| Option | SqlRite default | Effect |
| :-- | :-- | :-- |
| `enableForeignKeyConstraints` | `true` | Enforces foreign keys. |
| `enableDoubleQuotedStringLiterals` | `false` | Rejects double-quoted string literals (a misspelled `"identifier"` errors instead of becoming a string). |
| `defensive` | `true` | Blocks SQL that can corrupt the file: `writable_schema`, `journal_mode=OFF`, `schema_version`, shadow-table writes. |
| `timeout` | `5000` | `busy_timeout` in ms — concurrent writers wait instead of an immediate `SQLITE_BUSY`, completing the WAL posture. Set `0` to restore the bare-`node:sqlite` behavior. |

### Tuning knobs

A small, curated set of overridable performance knobs, applied as
integer-validated `PRAGMA`s on every connection. Each is optional and off unless
you pass it; a non-integer (or out-of-range) value throws at open.

| Option | Type | PRAGMA | Notes |
| :-- | :-- | :-- | :-- |
| `cacheSize` | `number` | `cache_size` | Positive = pages; negative = KiB of memory. |
| `mmapSize` | `number` (≥ 0) | `mmap_size` | Bytes of memory-mapped I/O; `0` disables. Inert on `:memory:` (nothing to map). |
| `maxPageCount` | `number` (> 0) | `max_page_count` | Hard db-size ceiling in pages — a disk-fill guard. |

## Functions

### Built-in

- `REGEXP` — `col REGEXP $pattern` using JavaScript `RegExp`. Compiled patterns
  are cached per connection in a bounded LRU (256 patterns), so runtime-driven
  patterns (`col REGEXP other_col`) cannot grow memory without limit — the
  bound is not a ReDoS mitigation. A `NULL` pattern or subject yields `NULL` (SQL
  three-valued logic), never a match. An optional leading `(?flags)` sets RegExp
  flags — e.g. `(?i)^foo` for case-insensitive. `lastIndex` is reset per row, so
  the stateful flags are deterministic: `g` is a no-op (REGEXP is boolean) and
  `y` (sticky) anchors the match at the start. Genuinely invalid flags throw. A
  native scoped group such as `(?i:…)` passes through unchanged.
- `uuid()` — `crypto.randomUUID()`. Usable as a column default:
  `id TEXT PRIMARY KEY DEFAULT (uuid())`.

### Custom

Point `functions` at JS modules. Each module's filename becomes the SQL function
name. Functions are registered before any SQL block loads, so they are available
in `-- INIT` and prepared statements. Modules resolve dependencies from the host
app's `node_modules`.

```javascript
// db/getTokens.js
export const deterministic = true;   // optional; enables query optimization
export default (text) => text.length; // required; the handler
```
```javascript
const sql = await SqlRite.open({ dir: "sql", functions: ["./db/getTokens.js"] });
```
```sql
-- PREP: longPosts
SELECT * FROM posts WHERE getTokens(body) > 1000;
```

Custom functions need async registration, so `new SqlRiteSync()` does not load
them — use `await SqlRiteSync.open()` (or the async facade) when passing
`functions`.

## Type generation

```bash
node scripts/codegen.js [dir]   # writes SqlRite.d.ts (default dir "sql")
```

Generates TypeScript declarations for the dynamically generated methods from the
`.sql` files in `dir`.

## Limits & security

- **Trusted-SQL boundary.** `-- EXEC` and `-- TX` are templated, not bound. Only
  `-- PREP` parameterizes runtime values. Routing untrusted input through
  `-- EXEC`/`-- TX` is SQL injection.
- **ReDoS.** `REGEXP` compiles patterns with JavaScript `RegExp`, which
  backtracks: a malicious pattern (e.g. `(a+)+$`) — or attacker-controlled data
  against a vulnerable pattern — can cause catastrophic backtracking. The match
  runs synchronously inside SQLite and cannot be interrupted, freezing the
  process (sync) or wedging the DB worker (async). It is opt-in — only a query
  you author reaches it — so never point `REGEXP` at untrusted patterns or
  unbounded attacker-controlled input. Safe matching of untrusted patterns needs
  a linear-time engine (e.g. RE2) or an out-of-band timeout.
- **Integer precision.** Integer columns read as JS `number` unless a statement
  opts into [`BigInt`](#bigint-flag); without it, a value above `2^53 − 1` throws
  on read rather than losing precision.
- **`-- TX` returns no rows.** It returns only `{ changes, lastInsertRowid }`;
  read committed results with a separate `-- PREP`.
- **Async serialization.** The async facade processes one Worker message at a
  time; calls are serialized, not concurrent.
- **Idle instances don't hold the process.** The async facade unrefs its Worker
  whenever no call is in flight and refs it for each round-trip, so an unclosed
  instance can't pin the process while pending work is never dropped. Exiting
  without `close()` is WAL-crash-safe (the next open recovers), but `close()` /
  `await using` remains the clean shutdown.
- **Async errors are structured-cloned.** A rejected call carries the worker's
  original error — class, message, stack, and `cause` survive the boundary;
  non-standard own properties (e.g. an `errcode`) do not.

## Design decisions & non-goals

Durable rationale — why the shape is what it is, and what SqlRite deliberately
does not do.

- **No `db.transaction(fn)` closure.** The async facade cannot `postMessage` a JS
  closure to its Worker, and a JS-composed transaction would violate SQL-first.
  Transactions are the declarative `-- TX` tag instead; the earlier
  `transaction(calls)` batch API was removed for the same reason.
- **`busy_timeout` via the native `timeout` option, not a `busyTimeout` knob.**
  `DatabaseSync` already accepts `timeout`; SqlRite only defaults it non-zero
  (`5000` ms). A second PRAGMA-based option would be redundant.
- **Tuning knobs are curated.** `cacheSize`/`mmapSize`/`maxPageCount` are exposed
  with integer validation — SqlRite is not a generic PRAGMA passthrough.
- **`PRAGMA dml_strict` is fiction.** Not a real pragma (it reads back
  `undefined`). The DQS-rejection it claimed is already the `node:sqlite` default
  via `enableDoubleQuotedStringLiterals: false`. Verified on Node 26.3.1.
- **Foreign keys via constructor option.** `enableForeignKeyConstraints: true`,
  not a post-hoc `PRAGMA foreign_keys = ON`.
- **No `.ts` source.** A published library cannot ship type-stripped files under
  `node_modules`, so types stay in JSDoc and `SqlRite.d.ts` is generated.
- **No environment configuration.** Tuning flows through exactly two channels:
  the options object (typed, per-instance, fail-hard) and `-- INIT` `$var`
  params (SQL-first). A library reading `SQLRITE_*` env vars would be a third,
  process-global, stringly-typed channel; env-driven config belongs to the host
  app (`--env-file` + `process.env` at the call site).

## Working with the source

- Discover methods: grep `-- PREP:` / `-- EXEC:` / `-- TX:`. Discover schema:
  grep `-- INIT:`.
- Add an operation: add a tagged block to a `.sql` file, then call `db.<name>`
  (re-run `codegen.js` to refresh types).
- Bind runtime values with `-- PREP` + a named-parameter object; never
  interpolate untrusted input through `-- EXEC` or `-- TX`.
- Group dependent writes in a single `-- TX` block for atomicity.
- Read integers beyond `2^53` with a `bigint`-flagged `-- PREP`.

## Conventions

- **Commits:** Conventional (`feat:`/`fix:`/`docs:`/`build:`/`chore:`…), scoped to
  an issue number (`#0` when none).
- **Style:** one class per file, `#private` fields, ESM, double quotes, tabs,
  `export default class`. Biome enforces formatting — `npm run lint`.
- **Types:** checked JS via JSDoc + `tsconfig` (`checkJs`, `strict`,
  `noImplicitAny: false`). No `.ts` source — see
  [Design decisions](#design-decisions--non-goals).
- **Tests:** `node --test`, native asserts, specific error matchers. Unit
  alongside source (`*.test.js`); integration in `test/integration/`.
- **Gate:** `npm run check` (lint + typecheck + tests) must be green; coverage
  ≥ 80/80/80.
