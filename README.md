# 🪨 SqlRite

[![npm version](https://img.shields.io/npm/v/@possumtech/sqlrite?color=brightgreen)](https://www.npmjs.com/package/@possumtech/sqlrite)
[![license](https://img.shields.io/github/license/possumtech/sqlrite)](LICENSE)
[![node version](https://img.shields.io/badge/node-%3E%3D25.0.0-blue)](https://nodejs.org)

**SQL Done Right.** A high-performance, opinionated, and LLM-ready wrapper for Node.js native SQLite.

---

## 📖 About

SqlRite is a thin, zero-dependency wrapper around the [native Node.js `sqlite` module](https://nodejs.org/api/sqlite.html). It enforces a clean separation of concerns by treating SQL as a first-class citizen, enabling a development workflow that is faster, more secure, and optimized for modern AI coding assistants.

### Why SqlRite?

1.  **⚡ Zero-Config Prepared Statements**: Define SQL in `.sql` files; call them as native JS methods.
2.  **🧵 True Non-Blocking I/O**: The default async model offloads all DB operations to a dedicated Worker Thread.
3.  **📦 LLM-Ready Architecture**: By isolating SQL from JS boilerplate, you provide AI agents with a clean, high-signal "Source of Truth" for your data layer.
4.  **🧩 Locality of Behavior**: Keep your SQL files right next to the JS logic that uses them.
5.  **🚀 Modern Standards**: Built for Node 25+, ESM-native, and uses the latest `node:sqlite` primitives.
6.  **🛡️ Production-Ready Defaults**: Automatically enables WAL mode, Foreign Key enforcement, and DML Strictness.

---

## 🛠 Installation

```bash
npm install @possumtech/sqlrite
```

---

## 🚀 Quick Start

### 1. Define your SQL (`src/users.sql`)

SqlRite uses simple metadata headers to turn SQL chunks into JS methods. We recommend using `STRICT` tables for maximum type safety.

```sql
-- INIT: createUsers
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  meta TEXT
) STRICT;

-- PREP: addUser
INSERT INTO users (name, meta) VALUES ($name, $meta);

-- PREP: getUserByName
SELECT * FROM users WHERE name = $name;
```

### 2. Use it in Javascript

#### Asynchronous (Default - Recommended)
Uses Worker Threads to keep your main event loop free.

```javascript
import SqlRite from "@possumtech/sqlrite";

const sql = new SqlRite({ 
  path: "data.db", 
  dir: "src" 
});

// PREP chunks expose .all(), .get(), and .run()
// Objects/Arrays are automatically stringified for you!
await sql.addUser.run({ 
  name: "Alice", 
  meta: { theme: "dark", preferences: [1, 2, 3] } 
});

const user = await sql.getUserByName.get({ name: "Alice" });
console.log(JSON.parse(user.meta).theme); // Manual parse required for output

await sql.close();
```

#### Synchronous
Ideal for CLI tools, migrations, or scripts.

```javascript
import { SqlRiteSync } from "@possumtech/sqlrite";

const sql = new SqlRiteSync({ dir: ["src", "migrations"] });
const users = sql.getUserByName.all({ name: "Alice" });
sql.close();
```

---

## 🤖 LLM-Ready Architecture

In the era of AI-assisted engineering, **Context is King**. 

SqlRite's "SQL-First" approach is specifically designed to maximize the effectiveness of LLMs (like Gemini, Claude, and GPT):

*   **High Signal-to-Noise**: When you feed a `.sql` file to an LLM, it sees 100% schema and logic, 0% Javascript boilerplate. This prevents "context contamination" and hallucination.
*   **Schema Awareness**: Agents can instantly "understand" your entire database contract by reading the isolated SQL files, making them significantly better at generating correct queries.
*   **Clean Diffs**: AI-generated refactors of your data layer stay within `.sql` files, keeping your JS history clean and your logic easier to audit.

---

## 💎 Features & Syntax

### Modern Defaults

SqlRite automatically executes these PRAGMAs on every connection to ensure high performance and data integrity:

*   **WAL Mode**: `PRAGMA journal_mode = WAL` enables concurrent readers and writers.
*   **Foreign Keys**: `PRAGMA foreign_keys = ON` enforces relational constraints.
*   **DML Strict Mode**: `PRAGMA dml_strict = ON` catches common SQL errors (like using double quotes for strings).

### Metadata Headers

| Syntax | Name | Behavior |
| :--- | :--- | :--- |
| `-- INIT: name` | **Initializer** | Runs once automatically when `SqlRite` is instantiated. |
| `-- EXEC: name` | **Transaction** | Exposes a method `sql.name()` for one-off SQL execution. |
| `-- PREP: name` | **Statement** | Compiles a Prepared Statement; exposes `.all()`, `.get()`, and `.run()`. |

### Locality & Multi-Directory Support

You don't have to put all your SQL in one folder. SqlRite encourages placing SQL files exactly where they are needed:

```javascript
const sql = new SqlRite({
  dir: ["src/auth", "src/billing", "src/shared/sql"]
});
```

Files are sorted **numerically by filename prefix** across all directories (e.g., `001-setup.sql` will always run before `002-seed.sql`), ensuring deterministic migrations.

---

## ⚙️ Configuration

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `path` | `string` | `":memory:"` | Path to the SQLite database file. |
| `dir` | `string\|string[]` | `"sql"` | Directory or directories to scan for `.sql` files. |

---

## 📄 License

MIT © [@wikitopian](https://github.com/wikitopian)
