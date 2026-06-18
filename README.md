# SqlRite

SQL-first persistence for Node.js. A zero-dependency wrapper over the built-in
`node:sqlite` `DatabaseSync`. SQL lives in `.sql` files tagged with comment
markers; SqlRite turns each tagged block into a JavaScript method.

- Requires Node `>=25.0.0`, npm `>=11.1.0`.
- No runtime dependencies.
- Two facades over one core: async (Worker thread) and sync.

## Install

```bash
npm install @possumtech/sqlrite
```

## Model

- Input: one or more directories of `.sql` files containing tagged blocks.
- Output: an object whose methods are generated from those tags.
- No implicit methods (`find`, `save`, …). Every operation is an explicit SQL block.

### Tags

A block runs from its tag line to the next tag (or end of file). Empty blocks
are skipped.

| Tag | Maps to | Behavior |
| :-- | :-- | :-- |
| `-- INIT: <name>` | (runs at open) | Executed once when the DB opens. Use idempotent DDL (`CREATE TABLE IF NOT EXISTS`) and `PRAGMA`s. Supports `$var` templating via the `params` option. |
| `-- EXEC: <name>` | `db.<name>(params)` | `db.exec()` of the block, with optional `$var` string templating. Trusted, developer-authored SQL only — see [EXEC](#exec-trusted-sql). |
| `-- PREP: <name>` | `db.<name>.{all,get,run}(params)` | Prepared statement. The only parameterized path for runtime values. |

`-- INIT` names are not deduplicated. Duplicate `-- EXEC`/`-- PREP` names emit a
warning; the last definition wins.

### File ordering

Directories are scanned recursively for `.sql` files. Files are sorted by
basename, numerically (`001-*.sql` before `002-*.sql`), across all directories
merged into one execution plan.

## Usage

### Async (Worker thread)

DB operations run in a dedicated Worker; methods return Promises. Construct only
via `open()` — the constructor throws otherwise.

```javascript
import SqlRite from "@possumtech/sqlrite";

const sql = await SqlRite.open({ path: "data.db", dir: "sql" });

await sql.addUser.run({ name: "Alice", meta: { theme: "dark" } });
const user = await sql.getUserByName.get({ name: "Alice" });

await sql.close(); // or: await using sql = await SqlRite.open(...)
```

### Sync

```javascript
import { SqlRiteSync } from "@possumtech/sqlrite";

const sql = new SqlRiteSync({ dir: ["migrations", "src/users"] });
const users = sql.getUserByName.all({ name: "Alice" });
sql.close(); // or: using sql = new SqlRiteSync(...)
```

`new SqlRiteSync()` does not register custom `functions`. Use the async
`SqlRiteSync.open()` if you pass `functions` (registration is async).

### Entry points

| Import | Export |
| :-- | :-- |
| `@possumtech/sqlrite` | default `SqlRite` (async), named `SqlRiteSync` |
| `@possumtech/sqlrite/sync` | default `SqlRiteSync` |
| `@possumtech/sqlrite/core` | default `SqlRiteCore` (static utilities) |

## PREP statements

A `-- PREP` method exposes three modes:

| Mode | Use | Returns (sync / async) |
| :-- | :-- | :-- |
| `.run(params)` | `INSERT`/`UPDATE`/`DELETE` | `{ changes, lastInsertRowid }` |
| `.get(params)` | single row | row object or `undefined` |
| `.all(params)` | multiple rows | array of row objects |

- Use named parameters (`$name`, `:name`, or `@name`). The JS interface takes an
  object; keys map to parameter names. Leading `$`/`:`/`@` on keys is stripped,
  so `{ name }` binds `$name`.
- Object and array parameter values are `JSON.stringify`-ed on input. Output is
  not parsed — call `JSON.parse()` yourself.
- `.run()` returns `{ changes, lastInsertRowid }`. `-- EXEC` and `-- TX` return
  the same shape. Both fields are `number` by default and `BigInt` when the
  statement carries the [`bigint`](#bigint-reads) flag — without it, a
  `lastInsertRowid` past `2^53` throws rather than rounding.

```sql
-- PREP: addUser
INSERT INTO users (name, meta) VALUES ($name, $meta);

-- PREP: searchUsers
SELECT * FROM users WHERE name REGEXP $pattern;
```

### bigint reads

Integers are read as JS `number` by default; a value above `2^53 − 1` throws on
read rather than losing precision. Append the `bigint` flag to a tag to read that
statement's integers as `BigInt` instead:

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
`DatabaseSync`). Passing a `BigInt` as a parameter already works without the
flag.

## EXEC (trusted SQL)

`-- EXEC` runs `db.exec()` (one or more statements) after `$var` templating. It
is for developer-authored SQL with constant or developer-supplied inputs —
DDL, `PRAGMA`s, maintenance. It is **not** a parameterized path: templated values
are string-interpolated (string values are single-quote escaped; numbers,
booleans, and `null` are inlined; identifiers are not handled). Do not pass
untrusted input through EXEC. For runtime values, use `-- PREP` with `.run()`.

```sql
-- EXEC: insertKv
INSERT INTO kv (key, val) VALUES ($key, $val);
```

```javascript
sql.insertKv({ key: "role", val: "admin" }); // val is escaped, not bound
// returns { changes, lastInsertRowid } — number, or BigInt with the `bigint` flag
```

## TX (transactions)

`-- TX` is `-- EXEC` made transactional: the templated multi-statement body runs
wrapped in `BEGIN` / `COMMIT`, and any error triggers `ROLLBACK` before the error
is rethrown (async: rejects). The whole transaction lives in one SQL block — there
is no JS composition step. In the async facade it is one Worker round-trip.

```sql
-- TX: transfer
UPDATE acct SET bal = bal - $amt WHERE id = $from;
UPDATE acct SET bal = bal + $amt WHERE id = $to;
```

```javascript
sql.transfer({ from, to, amt }); // both statements commit, or neither does
```

Templating is identical to `-- EXEC` — values are string-interpolated, **not**
bound — so the same trusted-input contract applies; do not pass untrusted input
through `-- TX`. A `-- TX` method returns the write metadata
`{ changes, lastInsertRowid }` (`number`, or `BigInt` with the
[`bigint`](#bigint-reads) flag). Because the body is run via `db.exec()`, it
cannot return result rows: keep intra-transaction data flow in SQL
(`last_insert_rowid()`, subqueries) and read committed results with a separate
`-- PREP` afterward.

## INIT templating

`-- INIT` blocks support `$var` substitution from the `params` option (same
templating rules as EXEC).

```sql
-- INIT: configure
PRAGMA cache_size = $cacheSize;
```

```javascript
await SqlRite.open({ dir: "sql", params: { cacheSize: 5000 } });
```

## Configuration

| Option | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| `path` | `string` | `":memory:"` | SQLite database file path. |
| `dir` | `string \| string[]` | `"sql"` | Directories scanned for `.sql` files. |
| `functions` | `string \| string[]` | — | Module paths for custom SQL functions. |
| `params` | `object` | — | `$var` substitutions for `-- INIT` blocks. |

All other keys pass through to the `node:sqlite` `DatabaseSync` constructor
(e.g. `readOnly`, `timeout`, `allowExtension`). Unknown keys are ignored;
invalid option types throw at construction.

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

## Built-in SQL functions

- `REGEXP` — `col REGEXP $pattern` using JavaScript `RegExp`. Compiled patterns
  are cached per connection. A `NULL` subject yields no match. An optional
  leading `(?flags)` sets RegExp flags — e.g. `(?i)^foo` for case-insensitive.
  `lastIndex` is reset per row, so the stateful flags are deterministic: `g` is a
  no-op (REGEXP is boolean) and `y` (sticky) anchors the match at the start.
  Genuinely invalid flags still throw. A native scoped group such as `(?i:…)`
  passes through unchanged.
- `uuid()` — `crypto.randomUUID()`. Usable as a column default: `id TEXT PRIMARY KEY DEFAULT (uuid())`.

## Custom SQL functions

Point `functions` at JS modules. Each module's filename becomes the SQL function
name. Functions are registered before any SQL block loads, so they are available
in `-- INIT` and prepared statements. Modules resolve dependencies from the
host app's `node_modules`.

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

## Type generation

```bash
node scripts/codegen.js [dir]   # writes SqlRite.d.ts
```

Generates TypeScript declarations for the dynamically generated methods from the
`.sql` files in `dir` (default `"sql"`).

## Known limits

- Integer columns are read as JS `number` unless a statement opts into `BigInt`
  (see [bigint reads](#bigint-reads)); without it, a value above `2^53 − 1`
  throws on read rather than losing precision.
- `-- TX` is templated, not bound (same contract as `-- EXEC`), and cannot
  return result rows — it returns only `{ changes, lastInsertRowid }`. Read
  committed results with a separate `-- PREP` afterward.
- The async facade processes one Worker message at a time; calls are serialized,
  not concurrent.
- `REGEXP` compiles patterns with JavaScript `RegExp`, which backtracks: a
  malicious pattern (e.g. `(a+)+$`) — or attacker-controlled data against a
  vulnerable pattern — can cause catastrophic backtracking (ReDoS). The match
  runs synchronously inside SQLite and cannot be interrupted, freezing the
  process (sync) or wedging the DB worker (async). It is opt-in — only a query
  you author reaches it — so never point `REGEXP` at untrusted patterns or
  unbounded attacker-controlled input. Safe matching of untrusted patterns needs
  a linear-time engine (e.g. RE2) or an out-of-band timeout.

## Agent operations

- Discover methods: grep for `-- PREP:` / `-- EXEC:` / `-- TX:`.
- Discover schema: grep for `-- INIT:`.
- Add an operation: add a tagged block to a `.sql` file, then call
  `db.<name>` (run `codegen.js` to refresh types).
- Bind runtime values with `-- PREP` + an object of named parameters; never
  interpolate untrusted input through `-- EXEC`.
- Group dependent writes in a single `-- TX` block for atomicity.
- Read integers beyond `2^53` with a `bigint`-flagged `-- PREP`.

## License

MIT © [@wikitopian](https://github.com/wikitopian)
