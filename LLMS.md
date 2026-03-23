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
- **Purpose**: Idempotent DDL (e.g., `CREATE TABLE IF NOT EXISTS`).
- **Constraint**: Do not use parameters.

### `-- EXEC: <method_name>` (Raw Commands)
- **Execution**: Maps to `db.<method_name>()`.
- **Purpose**: Non-parameterized SQL execution (e.g., DDL, migrations, `PRAGMA` changes).
- **Constraint**: Does not accept parameters. Use `-- PREP` with `.run()` for parameterized writes.

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

## 4. LLM Operational Rules
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

## 5. Type Safety & LSP Support
SqlRite supports automatic TypeScript generation to provide LSPs and LLMs with precise method signatures.

### Codegen Workflow
1. **Define SQL**: Add blocks to your `.sql` files.
2. **Generate Types**: Run `npm run build:types`.
3. **Benefit**: Get autocomplete, type checking, and parameter hints in your IDE.

This ensures that the dynamically generated methods are "visible" to static analysis tools, significantly reducing errors in implementation.

## 6. Typical Workflow for Agents
1. **Understand State**: Read schema definitions in files containing `-- INIT`.
2. **Implement Logic**: Create/edit a `.sql` file with a `-- PREP: <name>` or `-- EXEC: <name>` tag.
3. **Sync Types**: Run `npm run build:types` to update the library's type definitions.
4. **Execute**: Call the method in JS: `await db.<name>.<mode>({ ... })`.
5. **Standardize**: Ensure SQL is clean and follows project conventions.
