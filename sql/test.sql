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
