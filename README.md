# SqlRite

[![check](https://github.com/possumtech/sqlrite/actions/workflows/check.yml/badge.svg)](https://github.com/possumtech/sqlrite/actions/workflows/check.yml)
[![npm](https://img.shields.io/npm/v/%40possumtech%2Fsqlrite)](https://www.npmjs.com/package/@possumtech/sqlrite)
[![node](https://raw.githubusercontent.com/possumtech/sqlrite/main/.github/badges/node.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

SQL-first persistence for Node.js — a zero-dependency wrapper over the built-in
`node:sqlite`. You write SQL in `.sql` files tagged with comment markers, and
SqlRite turns each tagged block into a JavaScript method. No models, no query
builder, no implicit `find`/`save` — every operation is an explicit SQL block you
can read.

- Requires Node `>=26.0.0`, npm `>=11.1.0`. Zero runtime dependencies.
- Two facades over one core: **async** (DB in a Worker thread) and **sync**.

> Full reference — exhaustive tag/option semantics, the design contract, security
> limits, and maintainer notes — lives in [SPEC.md](SPEC.md). This page is the
> quickstart.

## Install

```bash
npm install @possumtech/sqlrite
```

## How it works

Point SqlRite at one or more directories of `.sql` files. Each tagged block
becomes a method on the returned object.

| Tag | Becomes | What it does |
| :-- | :-- | :-- |
| `-- INIT: <name>` | runs at open | DDL / `PRAGMA` executed every open. Use idempotent DDL. |
| `-- MIGRATE: <n>` | runs once per database | Versioned schema evolution recorded in `PRAGMA user_version` — atomic, exactly-once, no ledger table. `ALTER TABLE` belongs here. |
| `-- PREP: <name>` | `db.<name>.{all,get,run}(params)` | Prepared statement — the **only** path for runtime or untrusted values. |
| `-- EXEC: <name>` | `db.<name>(params)` | `db.exec()` of the block. **Trusted SQL only** — values are string-interpolated, not bound. |
| `-- TX: <name>` | `db.<name>(params)` | `-- EXEC` wrapped in `BEGIN`/`COMMIT` (auto-`ROLLBACK` on error). Trusted SQL only. |

Directories are scanned recursively; files run sorted by basename, numerically
(`001-*.sql` before `002-*.sql`). Duplicate `EXEC`/`PREP`/`TX` names warn — the
last definition wins.

## Usage

### Async (default — runs in a Worker thread)

```javascript
import SqlRite from "@possumtech/sqlrite";

await using sql = await SqlRite.open({ path: "data.db", dir: "sql" });

await sql.addUser.run({ name: "Alice", meta: { theme: "dark" } });
const user = await sql.getUserByName.get({ name: "Alice" });
```

Construct only via `open()` — the constructor throws otherwise. Methods return
Promises. An idle instance does not hold the process open; `close()` (or
`await using`) is still the clean shutdown.

### Sync

```javascript
import { SqlRiteSync } from "@possumtech/sqlrite";

using sql = new SqlRiteSync({ dir: ["migrations", "src/users"] });
const users = sql.getUserByName.all({ name: "Alice" });
```

`new SqlRiteSync()` cannot register custom `functions` (registration is async) —
use `await SqlRiteSync.open()` if you pass `functions`.

| Import | Default export | Named |
| :-- | :-- | :-- |
| `@possumtech/sqlrite` | `SqlRite` (async) | `SqlRiteSync` |
| `@possumtech/sqlrite/sync` | `SqlRiteSync` | — |
| `@possumtech/sqlrite/core` | `SqlRiteCore` (static utilities) | — |

## PREP statements

A `-- PREP` method exposes three modes:

| Mode | For | Returns |
| :-- | :-- | :-- |
| `.run(params)` | `INSERT`/`UPDATE`/`DELETE` | `{ changes, lastInsertRowid }` |
| `.get(params)` | one row | row object or `undefined` |
| `.all(params)` | many rows | array of rows |

- Bind with named parameters (`$name`, `:name`, `@name`). Pass an object; a
  leading `$`/`:`/`@` on keys is optional, so `{ name }` binds `$name`.
- Object/array values are `JSON.stringify`-ed on the way in; output is **not**
  parsed — call `JSON.parse()` yourself.
- Integers read as `number`; a value past `2^53 − 1` throws rather than silently
  rounding. Opt a statement into `BigInt` with a `bigint` flag on its tag — see
  [SPEC.md](SPEC.md#bigint-flag).
- JS numbers bind as `REAL` (storage into `INTEGER` columns converts
  losslessly); pass `BigInt` params for integer-exact SQL arithmetic.

```sql
-- PREP: addUser
INSERT INTO users (name, meta) VALUES ($name, $meta);

-- PREP: searchUsers
SELECT * FROM users WHERE name REGEXP $pattern;
```

## Configuration

| Option | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| `path` | `string` | `":memory:"` | SQLite database file path. |
| `dir` | `string \| string[]` | `"sql"` | Directories scanned for `.sql` files. |
| `functions` | `string \| string[]` | — | JS module paths for custom SQL functions. |
| `params` | `object` | — | `$var` substitutions for `-- INIT` blocks. |

SqlRite opens with a hardened, WAL-mode posture (foreign keys on, defensive mode,
a non-zero `busy_timeout`) and exposes curated performance knobs (`cacheSize`,
`mmapSize`, `maxPageCount`). Every default is overridable; any other key passes
through to `node:sqlite`. Full tables in [SPEC.md](SPEC.md#configuration).

## Built-in SQL functions

- `REGEXP` — `col REGEXP $pattern` via JavaScript `RegExp`, with an optional
  `(?flags)` prefix (e.g. `(?i)^foo` for case-insensitive). **Trusted patterns
  only** — `RegExp` can catastrophically backtrack (ReDoS); see
  [SPEC.md](SPEC.md#limits--security).
- `uuid()` — `crypto.randomUUID()`; usable as a column default:
  `id TEXT PRIMARY KEY DEFAULT (uuid())`.

Register your own with the `functions` option — see [SPEC.md](SPEC.md#functions).

## Safety in one breath

- `-- PREP` is the only place runtime or untrusted values belong — it binds them.
- `-- EXEC` / `-- TX` string-interpolate their values — **developer-authored SQL
  only**, never untrusted input.
- `REGEXP` patterns must be trusted (ReDoS).

## For AI agents

[SPEC.md](SPEC.md) is the complete behavior contract; [AGENTS.md](AGENTS.md)
has integration and contribution instructions. Discover any project's API by
grepping its `.sql` tags (`-- PREP:`, `-- EXEC:`, `-- TX:`, `-- INIT:`). Both
files ship in the npm package.

## License

MIT © [@wikitopian](https://github.com/wikitopian)
