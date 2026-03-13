import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import SqlRite, { SqlRiteSync } from "../SqlRite.js";
import SqlRiteCore from "../SqlRiteCore.js";

// Setup test environment
if (!fs.existsSync("sql")) fs.mkdirSync("sql");
fs.writeFileSync(
	"sql/001-init.sql",
	"-- INIT: createEmployees\nCREATE TABLE IF NOT EXISTS employees (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, position TEXT NOT NULL, salary REAL NOT NULL);",
);
fs.writeFileSync(
	"sql/002-data.sql",
	"-- PREP: addEmployee\nINSERT INTO employees (name, position, salary) VALUES ($name, $position, $salary);\n-- PREP: getPositions\nSELECT name, position FROM employees;\n-- PREP: getHighestPaidEmployee\nSELECT * FROM employees ORDER BY salary DESC LIMIT 1;\n-- EXEC: deleteTable\nDROP TABLE IF EXISTS sync_test;",
);

test("SqlRiteCore", (t) => {
	t.test("getFiles() should sort numerically", () => {
		const files = SqlRiteCore.getFiles("sql");
		const basenames = files.map((f) => path.basename(f));
		assert.ok(
			basenames.indexOf("001-init.sql") < basenames.indexOf("002-data.sql"),
			"001 should come before 002",
		);
	});

	t.test("getFiles() handles subdirectories", () => {
		if (!fs.existsSync("sql/sub")) fs.mkdirSync("sql/sub");
		fs.writeFileSync("sql/sub/999-last.sql", "-- INIT: subInit\nSELECT 1;");
		const files = SqlRiteCore.getFiles("sql");
		assert.ok(
			files.some((f) => f.includes("999-last.sql")),
			"Should find file in subdirectory",
		);
	});

	t.test("parseSql() filters empty and trims", () => {
		fs.writeFileSync("sql/empty.sql", "-- PREP: empty\n  \n  ");
		const chunks = SqlRiteCore.parseSql(["sql/empty.sql"]);
		assert.strictEqual(chunks.PREP.length, 0, "Should filter empty chunks");
	});

	t.test("jsonify() handles objects and arrays", () => {
		const input = { arr: [1, 2], obj: { a: 1 }, str: "val", nil: null };
		const output = SqlRiteCore.jsonify(input);
		assert.strictEqual(output.arr, "[1,2]");
		assert.strictEqual(output.obj, '{"a":1}');
		assert.strictEqual(output.str, "val");
		assert.strictEqual(output.nil, null);
		assert.deepStrictEqual(
			SqlRiteCore.jsonify(null),
			{},
			"Should return empty object for null params",
		);
	});
});

test("SqlRiteSync", (t) => {
	const sql = new SqlRiteSync({ dir: "sql" });

	t.test("initialization and INIT chunks", () => {
		// Employees table should exist from 001-init.sql
		const res = sql.getPositions.all();
		assert.ok(Array.isArray(res));
	});

	t.test("exec()", () => {
		sql.exec("CREATE TABLE sync_test (id INTEGER)");
		sql.exec("INSERT INTO sync_test VALUES (1)");
		// No error means success
	});

	t.test("PREP methods (all, get, run)", () => {
		sql.addEmployee.run({
			name: "Sync User",
			position: "Dev",
			salary: 50000,
		});
		const res = sql.getPositions.all();
		assert.ok(res.some((e) => e.name === "Sync User"));
	});

	t.test("EXEC methods", () => {
		sql.deleteTable();
		// No error means success
	});

	t.test("close()", () => {
		sql.close();
	});
});

test("SqlRite (Async)", async (t) => {
	const sql = new SqlRite({ dir: "sql" });

	await t.test("READY signal and methods setup", async () => {
		// Wait for ready via any method call or just a small timeout if needed
		// but since every method awaits the readyPromise, we can just call one
		assert.ok(typeof sql.addEmployee.run === "function");
	});

	await t.test("PREP methods", async () => {
		await sql.addEmployee.run({
			name: "Async User",
			position: "Lead",
			salary: 90000,
		});
		const res = await sql.getPositions.all();
		assert.ok(res.some((e) => e.name === "Async User"));
	});

	await t.test("Proxy fallback", async () => {
		const res = await sql.getHighestPaidEmployee.get();
		assert.strictEqual(res.name, "Async User");
	});

	await t.test("Raw SQL execution", async () => {
		await sql.exec("CREATE TABLE async_test (id INTEGER)");
		// Success if no throw
	});

	await t.test("Error handling", async () => {
		try {
			await sql.nonExistentMethod.all();
			assert.fail("Should have thrown");
		} catch (err) {
			// Proxy fallback returns a function that calls #callWorker
			// Since the name isn't found in EXEC or PREP, the worker will throw
			assert.ok(err.message.includes("Cannot read properties of undefined"));
		}
	});

	await t.test("close()", async () => {
		await sql.close();
	});
});

test("Multi-directory support", () => {
	if (!fs.existsSync("sql2")) fs.mkdirSync("sql2");
	fs.writeFileSync("sql2/extra.sql", "-- PREP: extra\nSELECT 1 as val;");
	const sql = new SqlRiteSync({ dir: ["sql", "sql2"] });
	const res = sql.extra.get();
	assert.strictEqual(res.val, 1);
	sql.close();
});
