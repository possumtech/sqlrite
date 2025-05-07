# sqlrite

SQL Done Right

## About sqlrite

The sqlrite package is a modern node module that delivers an opinionated
alternative to ORMs.

## Opinions

1. **SQL First**: SQL is the best way to interact with data.

2. **Standards**: Node is the standard for server-side web apps, and it now
contains a native sqlite module. Sqlite is the standard for SQL.

3. **Simplicity**: It takes as much time to master an ORM as it would take to
just master SQL, and with worse performance. For all but the most distributed,
concurrent, and custom use cases, sqlite is the best choice.

4. **Security**: Inline SQL is insecure, hard to maintain, and error-prone.

5. **Separation**: SQL code should be in separate SQL files rather than
scattered throughout your JS codebase.

## Solution

**SQL**

Add a `sql` directory to your project and include as many `.sql` files as you
wish, with whatever folder structure you like. Sqlrite will automatically load
them all.

Sqlrite automatically loads only two types of code, "transactions," and 
"prepared statements." Transactions can contain multiple statements, and are
best for operations like creating tables, views, and indexes. Prepared
Statements are best for the queries you will be running.

**Example SQL File**

```sql
-- TX: createEmployeeTable
CREATE TABLE IF NOT EXISTS employees (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	position TEXT NOT NULL,
	salary REAL NOT NULL
);

-- PS: addEmployee
INSERT INTO employees (name, position, salary)
	VALUES ($name, $position, $salary);

-- PS: getTopEmployee
SELECT name FROM employees ORDER BY salary DESC LIMIT 1;
```

**Example Node File**

```js
import sqlrite from "sqlrite";

const sql = new sqlrite();

(async () => {
	await sql.createEmployeeTable();

	await sql.addEmployee.run({ name: "John", position: "CEO", salary: 99999 });
	await sql.addEmployee.run({ name: "Jane", position: "COO", salary: 49998 });
	await sql.addEmployee.run({ name: "Jack", position: "CFO", salary: 49998 });
	await sql.addEmployee.run({ name: "Jill", position: "CIO", salary: 49998 });

	const employee = await sql.getTopEmployee.get();

	console.log(employee.name);
})();
```


## Installation

Navigate to your project directory and run the following command:

```bash
npm install sqlrite
```

## Configuration

```js
import sqlrite from "sqlrite";

const sql = new sqlrite(options = {
		// Custom SQLite database file path.
		path: ":memory:",

		// Path to your SQL directory.
		dir: "./sql",
});
```

Additional arguments to the
[native sqlite module](https://nodejs.org/api/sqlite.html) can be passed as
well.
