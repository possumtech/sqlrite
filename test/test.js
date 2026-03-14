import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
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

after(() => {
	fs.rmSync("sql", { recursive: true, force: true });
	fs.rmSync("sql2", { recursive: true, force: true });
});

describe("SqlRiteCore", () => {
	test("getFiles() should sort numerically", () => {
		const files = SqlRiteCore.getFiles("sql");
		const basenames = files.map((f) => path.basename(f));
		assert.ok(
			basenames.indexOf("001-init.sql") < basenames.indexOf("002-data.sql"),
			"001 should come before 002",
		);
	});

	test("getFiles() handles subdirectories", () => {
		if (!fs.existsSync("sql/sub")) fs.mkdirSync("sql/sub");
		fs.writeFileSync("sql/sub/999-last.sql", "-- INIT: subInit\nSELECT 1;");
		const files = SqlRiteCore.getFiles("sql");
		assert.ok(
			files.some((f) => f.includes("999-last.sql")),
			"Should find file in subdirectory",
		);
	});

	test("parseSql() filters empty and trims", () => {
		fs.writeFileSync("sql/empty.sql", "-- PREP: empty\n  \n  ");
		const chunks = SqlRiteCore.parseSql(["sql/empty.sql"]);
		assert.strictEqual(chunks.PREP.length, 0);
	});

	test("jsonify() handles objects and arrays", () => {
		const input = { arr: [1, 2], obj: { a: 1 }, str: "val", nil: null };
		const output = SqlRiteCore.jsonify(input);
		assert.strictEqual(output.arr, "[1,2]");
		assert.strictEqual(output.obj, '{"a":1}');
		assert.strictEqual(output.str, "val");
		assert.strictEqual(output.nil, null);
		assert.deepStrictEqual(SqlRiteCore.jsonify(null), {});
	});
});

describe("SqlRiteSync", () => {
	const sql = new SqlRiteSync({ dir: "sql" });

	test("initialization and INIT chunks", () => {
		const res = sql.getPositions.all();
		assert.ok(Array.isArray(res));
	});

	test("exec()", () => {
		sql.exec("CREATE TABLE sync_test (id INTEGER)");
		sql.exec("INSERT INTO sync_test VALUES (1)");
	});

	test("PREP methods (all, get, run)", () => {
		sql.addEmployee.run({
			name: "Sync User",
			position: "Dev",
			salary: 50000,
		});
		const res = sql.getPositions.all();
		assert.ok(res.some((e) => e.name === "Sync User"));
	});

	test("EXEC methods", () => {
		sql.deleteTable();
	});

	test("close()", () => {
		sql.close();
	});
});

describe("SqlRite (Async)", () => {
	test("Should throw if initialized via new SqlRite()", () => {
		assert.throws(
			() => new SqlRite(),
			/SqlRite must be initialized using SqlRite.open/,
		);
	});

	test("READY signal and methods setup (via open)", async () => {
		const sql = await SqlRite.open({ dir: "sql" });
		assert.strictEqual(typeof sql.addEmployee.run, "function");
		await sql.close();
	});

	test("PREP methods", async () => {
		const sql = await SqlRite.open({ dir: "sql" });
		await sql.addEmployee.run({
			name: "Async User",
			position: "Lead",
			salary: 90000,
		});
		const res = await sql.getPositions.all();
		assert.ok(res.some((e) => e.name === "Async User"));
		await sql.close();
	});

	test("Raw SQL execution", async () => {
		const sql = await SqlRite.open({ dir: "sql" });
		await sql.exec("CREATE TABLE async_test (id INTEGER)");
		await sql.close();
	});

	test("close()", async () => {
		const sql = await SqlRite.open({ dir: "sql" });
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
