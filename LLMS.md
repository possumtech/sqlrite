# SqlRite: LLM Contract & Reference

SqlRite is a structured, SQL-first persistence engine for Node.js. It eliminates ORM abstractions by mapping SQL files directly to a JavaScript API.

## 1. Core Paradigm
- **Input**: Directories of `.sql` files containing tagged blocks.
- **Output**: A JavaScript Object (`db`) with dynamically generated methods.
- **Contract**: No magic methods (`find`, `save`, etc.) exist. Every database interaction must be explicitly defined in a `.sql` file.

## 2. SQL Tagging Syntax
SqlRite scans `.sql` files for specific markers. Files are sorted numerically by filename for deterministic execution. Multiple tags can exist in a single file.

### `-- INIT: <name>` (Schema Definitions)
- **Execution**: Runs automatically during initialization.
- **Purpose**: Idempotent DDL (e.g., `CREATE TABLE IF NOT EXISTS`), PRAGMA configuration.
- **Templating**: Supports `$variable` substitution via the `params` option at open time.
  ```sql
  -- INIT: configure
  PRAGMA cache_size = $cacheSize;
  ```
  ```javascript
  const sql = await SqlRite.open({ dir: "sql", params: { cacheSize: 5000 } });
  ```

### `-- EXEC: <method_name>` (Raw Commands)
- **Execution**: Maps to `db.<method_name>(params)`.
- **Purpose**: SQL execution with optional `$variable` string templating.
- **Templating**: Pass an object to substitute `$variable` placeholders. Use `-- PREP` with `.run()` for proper parameterized writes.
  ```javascript
  sql.insertRecord({ table: "users", val: "Alice" });
  ```

### `-- PREP: <method_name>` (Application Logic)
- **Execution**: Maps to `db.<method_name>`.
- **SQL Definition**: Use named parameters (e.g., `$name`, `:name`, or `@name`). Positional `?` placeholders are forbidden.
- **JS Interface**: Pass an object with keys matching the parameter names (e.g., `{ name: "value" }`).

## 3. JavaScript API
Methods defined via `-- PREP` are objects with three execution modes:

| Mode | Use Case | Returns |
| :--- | :--- | :--- |
| `.run({ params })` | `INSERT`, `UPDATE`, `DELETE` | `{ changes: number, lastInsertRowid: number }` |
| `.get({ params })` | Single row lookup | `Object` (first row) or `undefined` |
| `.all({ params })` | Multi-row queries | `Array<Object>` |

## 4. Inline REGEXP
SQLite's `REGEXP` operator is enabled on every connection. Use it in `WHERE` clauses:
```sql
-- PREP: searchUsers
SELECT * FROM users WHERE name REGEXP $pattern;
```
The regex engine is V8's JIT-compiled Irregexp (via JS `RegExp`). Compiled patterns are cached per connection.

A `uuid()` function is also available via `crypto.randomUUID()`, useful as a column default:
```sql
CREATE TABLE tokens (
  id TEXT PRIMARY KEY DEFAULT (uuid()),
  label TEXT NOT NULL
) STRICT;
```

## 5. LLM Operational Rules
- **Method Discovery**: Grep for `-- PREP:` or `-- EXEC:` to find available methods.
- **Schema Discovery**: Grep for `-- INIT:` to understand the data model.
- **Parameter Mapping**: Object keys in JS must match the names defined in SQL.
- **JSON Handling**: 
  - **Input**: Objects/Arrays passed as parameters are **automatically stringified** to JSON.
  - **Output**: You must `JSON.parse()` results manually in JS.
- **Dynamic SQL**: Use SQL logic for optional filters:
  ```sql
  WHERE ($filter IS NULL OR category = $filter)
  ```

## 6. Custom SQL Functions
Register custom SQL functions via module paths. Each module's filename becomes the SQL function name.

**Module contract:**
- Default export: the handler function (required)
- Named export `deterministic`: boolean (optional, defaults to false)

```javascript
// db/getTokens.js
import { encode } from "tiktoken";
export const deterministic = true;
export default (text) => encode(text).length;
```

```javascript
const sql = await SqlRite.open({
  dir: "sql",
  functions: ["./db/getTokens.js"],
});
```

Functions are registered before SQL chunks load, so they are available in `-- INIT` blocks and prepared statements. Modules resolve dependencies from the app's own `node_modules`.

## 7. Type Safety & LSP Support
SqlRite supports automatic TypeScript generation to provide LSPs and LLMs with precise method signatures.

### Codegen Workflow
1. **Define SQL**: Add blocks to your `.sql` files.
2. **Generate Types**: Run `npm run build:types`.
3. **Benefit**: Get autocomplete, type checking, and parameter hints in your IDE.

This ensures that the dynamically generated methods are "visible" to static analysis tools, significantly reducing errors in implementation.

## 8. Typical Workflow for Agents
1. **Understand State**: Read schema definitions in files containing `-- INIT`.
2. **Implement Logic**: Create/edit a `.sql` file with a `-- PREP: <name>` or `-- EXEC: <name>` tag.
3. **Sync Types**: Run `npm run build:types` to update the library's type definitions.
4. **Execute**: Call the method in JS: `await db.<name>.<mode>({ ... })`.
5. **Standardize**: Ensure SQL is clean and follows project conventions.
