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
	"-- INIT: createEmployees\nCREATE TABLE IF NOT EXISTS employees (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, position TEXT NOT NULL, salary REAL NOT NULL);\n" +
		"-- INIT: createEquipment\nCREATE TABLE equipment (id INTEGER PRIMARY KEY, employee_id INTEGER, name TEXT, FOREIGN KEY(employee_id) REFERENCES employees(id));\n" +
		"-- EXEC: createSyncTest\nCREATE TABLE sync_test (id INTEGER);\n" +
		"-- EXEC: insertSyncTest\nINSERT INTO sync_test VALUES (1);\n" +
		"-- EXEC: createAsyncTest\nCREATE TABLE async_test (id INTEGER);",
);
fs.writeFileSync(
	"sql/002-data.sql",
	"-- PREP: addEmployee\nINSERT INTO employees (name, position, salary) VALUES ($name, $position, $salary);\n" +
		"-- PREP: addEquipment\nINSERT INTO equipment (employee_id, name) VALUES ($employee_id, $name);\n" +
		"-- PREP: getPositions\nSELECT name, position FROM employees;\n-- PREP: getHighestPaidEmployee\nSELECT * FROM employees ORDER BY salary DESC LIMIT 1;\n-- EXEC: deleteTable\nDROP TABLE IF EXISTS sync_test;",
);

if (!fs.existsSync("db_fn")) fs.mkdirSync("db_fn");
fs.writeFileSync(
	"db_fn/double.js",
	"export const deterministic = true;\nexport default (x) => x * 2;\n",
);
fs.writeFileSync("db_fn/greet.js", `export default (name) => \`hello \${name}\`;\n`);

after(() => {
	fs.rmSync("sql", { recursive: true, force: true });
	fs.rmSync("sql2", { recursive: true, force: true });
	fs.rmSync("db_fn", { recursive: true, force: true });
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

	test("jsonify() strips SQL prefixes from keys", () => {
		const input = { $name: "val1", ":age": 20, "@id": 1 };
		const output = SqlRiteCore.jsonify(input);
		assert.strictEqual(output.name, "val1");
		assert.strictEqual(output.age, 20);
		assert.strictEqual(output.id, 1);
		assert.ok(!("$name" in output));
	});
});

describe("SqlRiteSync", () => {
	const sql = new SqlRiteSync({ dir: "sql" });

	test("initialization and INIT chunks", () => {
		const res = sql.getPositions.all();
		assert.ok(Array.isArray(res));
	});

	test("enforces foreign key constraints", () => {
		assert.throws(
			() => sql.addEquipment.run({ employee_id: 999, name: "Laptop" }),
			/FOREIGN KEY constraint failed/,
		);
	});

	test("EXEC methods", () => {
		sql.createSyncTest();
		sql.insertSyncTest();
		sql.deleteTable();
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

	test("close()", () => {
		sql.close();
	});
});

describe("SqlRite (Async)", () => {
	test("Should throw if initialized via new SqlRite()", () => {
		assert.throws(() => new SqlRite(), /SqlRite must be initialized using SqlRite.open/);
	});

	test("enforces foreign key constraints", async () => {
		const sql = await SqlRite.open({ dir: "sql" });
		await assert.rejects(
			async () => await sql.addEquipment.run({ employee_id: 999, name: "Laptop" }),
			/FOREIGN KEY constraint failed/,
		);
		await sql.close();
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

	test("EXEC methods", async () => {
		const sql = await SqlRite.open({ dir: "sql" });
		await sql.createAsyncTest();
		await sql.close();
	});

	test("close()", async () => {
		const sql = await SqlRite.open({ dir: "sql" });
		await sql.close();
	});
});

test("REGEXP function", () => {
	if (!fs.existsSync("sql_regex")) fs.mkdirSync("sql_regex");
	fs.writeFileSync(
		"sql_regex/001.sql",
		"-- INIT: createItems\nCREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;\n" +
			"-- PREP: addItem\nINSERT INTO items (name) VALUES ($name);\n" +
			"-- PREP: findByRegex\nSELECT name FROM items WHERE name REGEXP $pattern ORDER BY name;",
	);

	const sql = new SqlRiteSync({ dir: "sql_regex" });
	sql.addItem.run({ name: "alice" });
	sql.addItem.run({ name: "bob" });
	sql.addItem.run({ name: "alicia" });
	sql.addItem.run({ name: "charlie" });

	const matches = sql.findByRegex.all({ pattern: "^ali" });
	assert.strictEqual(matches.length, 2);
	assert.strictEqual(matches[0].name, "alice");
	assert.strictEqual(matches[1].name, "alicia");

	const none = sql.findByRegex.all({ pattern: "^zzz" });
	assert.strictEqual(none.length, 0);

	sql.close();
	fs.rmSync("sql_regex", { recursive: true, force: true });
});

test("uuid() function", () => {
	if (!fs.existsSync("sql_uuid")) fs.mkdirSync("sql_uuid");
	fs.writeFileSync(
		"sql_uuid/001.sql",
		"-- INIT: createTokens\nCREATE TABLE tokens (id TEXT PRIMARY KEY DEFAULT (uuid()), label TEXT NOT NULL) STRICT;\n" +
			"-- PREP: addToken\nINSERT INTO tokens (label) VALUES ($label) RETURNING id;\n" +
			"-- PREP: getToken\nSELECT * FROM tokens WHERE id = $id;",
	);

	const sql = new SqlRiteSync({ dir: "sql_uuid" });
	const { id } = sql.addToken.get({ label: "first" });
	assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

	const { id: id2 } = sql.addToken.get({ label: "second" });
	assert.notStrictEqual(id, id2);

	const row = sql.getToken.get({ id });
	assert.strictEqual(row.label, "first");

	sql.close();
	fs.rmSync("sql_uuid", { recursive: true, force: true });
});

test("custom functions (sync via open)", async () => {
	if (!fs.existsSync("sql_fn")) fs.mkdirSync("sql_fn");
	fs.writeFileSync(
		"sql_fn/001.sql",
		"-- INIT: t\nCREATE TABLE t (val INTEGER) STRICT;\n" +
			"-- PREP: getDouble\nSELECT double($x) as result;",
	);
	const sql = await SqlRiteSync.open({ dir: "sql_fn", functions: ["./db_fn/double.js"] });
	const row = sql.getDouble.get({ x: 5 });
	assert.strictEqual(row.result, 10);
	sql.close();
	fs.rmSync("sql_fn", { recursive: true, force: true });
});

test("custom functions (async)", async () => {
	if (!fs.existsSync("sql_fn2")) fs.mkdirSync("sql_fn2");
	fs.writeFileSync(
		"sql_fn2/001.sql",
		"-- INIT: t\nCREATE TABLE t (val TEXT) STRICT;\n" +
			"-- PREP: getGreeting\nSELECT greet($name) as result;",
	);
	const sql = await SqlRite.open({ dir: "sql_fn2", functions: ["./db_fn/greet.js"] });
	const row = await sql.getGreeting.get({ name: "world" });
	assert.strictEqual(row.result, "hello world");
	await sql.close();
	fs.rmSync("sql_fn2", { recursive: true, force: true });
});

test("custom functions (multiple + single string)", async () => {
	if (!fs.existsSync("sql_fn3")) fs.mkdirSync("sql_fn3");
	fs.writeFileSync(
		"sql_fn3/001.sql",
		"-- INIT: t\nCREATE TABLE t (id INTEGER) STRICT;\n" +
			"-- PREP: testBoth\nSELECT double($x) as d, greet($name) as g;",
	);
	const sql = await SqlRiteSync.open({
		dir: "sql_fn3",
		functions: ["./db_fn/double.js", "./db_fn/greet.js"],
	});
	const row = sql.testBoth.get({ x: 3, name: "test" });
	assert.strictEqual(row.d, 6);
	assert.strictEqual(row.g, "hello test");
	sql.close();
	fs.rmSync("sql_fn3", { recursive: true, force: true });

	// Single string form
	if (!fs.existsSync("sql_fn4")) fs.mkdirSync("sql_fn4");
	fs.writeFileSync("sql_fn4/001.sql", "-- PREP: getD\nSELECT double($x) as result;");
	const sql2 = await SqlRiteSync.open({ dir: "sql_fn4", functions: "./db_fn/double.js" });
	assert.strictEqual(sql2.getD.get({ x: 7 }).result, 14);
	sql2.close();
	fs.rmSync("sql_fn4", { recursive: true, force: true });
});

test("Multi-directory support", () => {
	if (!fs.existsSync("sql2")) fs.mkdirSync("sql2");
	fs.writeFileSync("sql2/extra.sql", "-- PREP: extra\nSELECT 1 as val;");
	const sql = new SqlRiteSync({ dir: ["sql", "sql2"] });
	const res = sql.extra.get();
	assert.strictEqual(res.val, 1);
	sql.close();
});
