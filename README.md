# sqlrite

SQL Done Right

## About sqlrite

The sqlrite package is a modern node module that delivers an opinionated
alternative to ORMs. It is a thin wrapper around the
[native sqlite module](https://nodejs.org/api/sqlite.html), which
enables one to separate SQL code from Javascript code.

## Opinions

1. **SQL Supremacy**: Your application is data, and SQL is the best interface.

2. **Standards**: Node is the standard for server-side web apps, and it now
contains a native sqlite module. Sqlite is the standard for SQL.

3. **Simplicity**: It takes as much time to master an ORM as it would take to
just master SQL, and with worse performance. For all but the most distributed,
concurrent, and custom use cases, sqlite is the simple, correct choice.

4. **Security**: Inline SQL is insecure, unmaintainable, and error-prone.

5. **Speed**: By enforcing the use of prepared statements, sqlrite ensures that
your queries are compiled and cached by the sqlite engine.

6. **Separation**: SQL code should be in separate SQL files rather than
scattered throughout your JS codebase.

7. **Size**: By relying on the native sqlite module, and nothing else, sqlrite
won't bloat your project with unnecessary dependencies. This thing is *tiny*.

## Usage

**SQL**

Add a `sql` folder to your project and include as many `.sql` files as you
wish, with whatever folder structure you like. Sqlrite will automatically load
them all.

| Syntax              | Name                   | Description            |
|---------------------|------------------------|------------------------|
| `-- INIT: txName`   | Executed Transaction   | Executed transaction   |
| `-- EXEC: txName`   | Executable Transaction | Executable transaction |
| `-- PREP: stmtName` | Prepared Statements    | Prepared statement     |

There are three types of "chunk" one can add to a `.sql` file:

1. **INIT**: A transaction that is executed when the module is instantiated.
This is where you should create your tables, for example.

2. **EXEC**: A transaction that can be executed at any time. For example,
	 dropping a table. This is where you should put your transactions that are
	 not prepared statements, like maintaining your database.

3. **PREP**: A prepared statement that can be executed at any time. This is
where you should put your queries. After declaring a prepared statement, you can
then run it with either the `.all({})`, `.get({})` or `.run({})` methods, as per
the native sqlite API.

| Method     | Description                                           |
|------------|-------------------------------------------------------|
| `.all({})` | Returns all rows that match the query.                |
| `.get({})` | Returns the first row that matches the query.         |
| `.run({})` | Executes the query and returns the (optional) result. |

### Synchronous/Asynchronous

Sqlrite now provides both asynchronous and synchronous models. The default export is fully asynchronous, offloading database operations to a separate Worker Thread to ensure your main event loop remains unblocked.

### Asynchronous (Default)

The asynchronous model uses worker threads and returns Promises.

```js
import SqlRite from "@possumtech/sqlrite";

const sql = new SqlRite();

// Prepped statements return Promises
const positions = await sql.getPositions.all();

// Executable transactions are also async
await sql.deleteTable();

// Raw SQL execution
await sql.exec("CREATE TABLE test (id INTEGER)");

await sql.close();
```

### Synchronous

For CLI tools or scripts where blocking is acceptable or preferred, use `SqlRiteSync`.

```js
import { SqlRiteSync } from "@possumtech/sqlrite";

const sql = new SqlRiteSync();

const positions = sql.getPositions.all();
sql.close();
```

## Features

1. **Worker Threads**: The default async model runs the database in a separate thread, providing true non-blocking I/O.
2. **Numerical Migrations**: SQL files are processed in a numerically linear order (e.g., `001-init.sql`, `002-data.sql`).
3. **Robust Parser**: Improved SQL extraction that correctly handles complex files and metadata headers.
4. **Enhanced JSON Support**: Automatically detects arrays and objects in parameters and converts them to JSON strings for SQLite's `json_each` and other JSON functions.
5. **Zero-Config Prepared Statements**: Just define them in your `.sql` files with `-- PREP:` and they are automatically compiled and exposed as methods.

## SQL Syntax

Add a `sql` folder to your project and include as many `.sql` files as you wish. Files are sorted numerically by their filename prefix.

| Syntax              | Name                   | Description            |
|---------------------|------------------------|------------------------|
| `-- INIT: txName`   | Initial Transaction    | Executed once on init  |
| `-- EXEC: txName`   | Executable Transaction | Exposes a method       |
| `-- PREP: stmtName` | Prepared Statement     | Pre-compiled statement |

**Example SQL File (`001-init.sql`)**

```sql
-- INIT: createEmployeeTable
CREATE TABLE IF NOT EXISTS employees (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	position TEXT NOT NULL,
	salary REAL NOT NULL
);

-- PREP: addEmployee
INSERT INTO employees (name, position, salary)
	VALUES ($name, $position, $salary);

-- PREP: getPositions
SELECT name, position FROM employees;
```

## Configuration

```js
import SqlRite from "@possumtech/sqlrite";

const sql = new SqlRite({
	path: "database.sqlite", // Path to SQLite file (default: ":memory:")
	dir: "sql",              // SQL directory (default: "sql")
});
```

You will almost certainly wish to replace the `path` with a path to your
database file. Otherwise, the database will be created in memory and lost when
the process ends.

```js
const sql = new SqlRite({ path: "path/to/your/database.sqlite3" });
```

Additional arguments will be passed to the options object of the native sqlite
module.

To close the database connection, call the `.close()` method:
