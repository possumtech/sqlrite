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

The native sqlite module currently only supports synchronous operations. This
can pose a performance issue in some common cases. Sqlrite addresses this by
allowing one to run one's queries asynchronously by appending `.async`:

For example, instead of:

**Synchronous**

```js
console.log(sql.getPositions.all());
```

**Asynchronous**

```js
sql.async.getPositions.all().then((positions) => console.log(positions));
```


**Example SQL File**

```sql
-- INIT: createEmployeeTable
BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS employees (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	position TEXT NOT NULL,
	salary REAL NOT NULL
);

END TRANSACTION;

-- EXEC: deleteTable
BEGIN TRANSACTION;

DROP TABLE IF EXISTS employees;

END TRANSACTION;

-- PREP: addEmployee
INSERT INTO employees (name, position, salary)
	VALUES ($name, $position, $salary);

-- PREP: getPositions
SELECT name, position FROM employees;

-- PREP: getHighestPaidEmployee
SELECT name FROM employees ORDER BY salary DESC LIMIT 1;
```

**Example Node File**

```js
import SqlRite from "@possumtech/sqlrite";

const sql = new SqlRite();

sql.addEmployee.run({ name: "John", position: "CEO", salary: 99999 });
sql.addEmployee.run({ name: "Jane", position: "COO", salary: 49998 });
sql.addEmployee.run({ name: "Jack", position: "CFO", salary: 49997 });
sql.addEmployee.run({ name: "Jill", position: "CIO", salary: 49996 });

const employee = sql.getHighestPaidEmployee.get();

assert(employee?.name === "John", "The highest paid employee should be John");

sql.async.getPositions.all().then((positions) => console.log(positions));

console.log(`The highest paid employee is ${employee.name}.`);

sql.deleteTable();
```

## Installation

1. Navigate to your project directory and run the following command:

```bash
npm install @possumtech/sqlrite
```

2. Then create a `sql` directory in your project directory. This is where you
will put your SQL files.

```bash
mkdir sql
cd sql
touch exampleFile.sql
```

## Configuration

```js
import SqlRite from "@possumtech/sqlrite";

const sql = new SqlRite({
	// SQLite database file path.
	path: ":memory:",

	// Path to your SQL directory.
	dir: "sql",
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
