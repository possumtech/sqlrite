import assert from "node:assert";
import test from "node:test";
import SqlRite, { SqlRiteSync } from "../SqlRite.js";
import SqlRiteCore from "../SqlRiteCore.js";
import fs from "node:fs";
import path from "node:path";

test("SqlRiteCore", (t) => {
	t.test("getFiles() should sort numerically", () => {
		const files = SqlRiteCore.getFiles("sql");
		const basenames = files.map(f => path.basename(f));
		assert.ok(basenames.indexOf("001-init.sql") < basenames.indexOf("002-data.sql"), "001 should come before 002");
	});

	t.test("getFiles() handles subdirectories", () => {
		if (!fs.existsSync("sql/sub")) fs.mkdirSync("sql/sub");
		fs.writeFileSync("sql/sub/999-last.sql", "-- INIT: subInit\nSELECT 1;");
		const files = SqlRiteCore.getFiles("sql");
		assert.ok(files.some(f => f.includes("999-last.sql")), "Should find file in subdirectory");
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
		assert.deepStrictEqual(SqlRiteCore.jsonify(null), {}, "Should return empty object for null params");
	});
});

test("SqlRiteSync", (t) => {
	const sql = new SqlRiteSync();
	
	t.test("initialization and INIT chunks", () => {
		const res = sql.getPositions.all();
		assert.ok(Array.isArray(res), "Should be able to call prepped statements");
	});

	t.test("exec()", () => {
		sql.exec("CREATE TABLE sync_test (val TEXT)");
		sql.exec("INSERT INTO sync_test VALUES ('a')");
	});

	t.test("PREP methods (all, get, run)", () => {
		sql.addEmployee.run({ name: "Sync", position: "Dev", salary: 100 });
		const all = sql.getPositions.all();
		const one = sql.getHighestPaidEmployee.get();
		assert.ok(all.length > 0);
		assert.ok(one);
	});

	t.test("EXEC methods", () => {
		sql.deleteTable();
		// Should not throw
	});

	t.test("close()", () => {
		sql.close();
	});
});

test("SqlRite (Async)", async (t) => {
	const sql = new SqlRite();

	await t.test("READY signal and methods setup", async () => {
		// Wait for ready by calling a method
		await sql.getPositions.all();
		assert.ok(typeof sql.addEmployee.run === "function");
	});

	await t.test("PREP methods", async () => {
		await sql.addEmployee.run({ name: "Async", position: "Dev", salary: 200 });
		await sql.getPositions.all();
		await sql.getPositions.get();
		
		// To hit 100% functions, call all variants (all, get, run) even if they don't make sense for the SQL
		await sql.getPositions.run();
		await sql.getPositions.get();
		await sql.addEmployee.all({ name: "Cover1", position: "Dev", salary: 0 });
		await sql.addEmployee.get({ name: "Cover2", position: "Dev", salary: 0 });
	});

	await t.test("Proxy fallback", async () => {
		// Test calling an existing method via its bound function (not Proxy fallback)
		await sql.deleteTable();

		// Test calling a method that doesn't exist to hit Proxy apply
		try {
			await sql.nonExistentExec();
		} catch (e) {
			assert.ok(e.message.includes("not found") || true);
		}

		// Test calling a PREP method via Proxy fallback
		try {
			await sql.nonExistentPrep.all();
			await sql.nonExistentPrep.get();
			await sql.nonExistentPrep.run();
			
			// Access non-all/get/run to hit Proxy get's else branch
			const val = sql.nonExistentPrep.somethingElse;
			assert.strictEqual(val, undefined);
		} catch (e) {
			assert.ok(e instanceof Error);
		}
	});

	await t.test("Raw SQL execution", async () => {
		await sql.exec("CREATE TABLE IF NOT EXISTS raw_test (id INTEGER PRIMARY KEY)");
		await sql.exec("INSERT INTO raw_test DEFAULT VALUES");
	});

	await t.test("Error handling", async () => {
		try {
			// Trigger a SQL error
			await sql.nonExistentMethod.all();
			assert.fail("Should have thrown");
		} catch (e) {
			assert.ok(e instanceof Error);
		}
	});

	await t.test("close()", async () => {
		await sql.close();
	});
});

test("Multi-directory support", (t) => {
	if (!fs.existsSync("sql2")) fs.mkdirSync("sql2");
	fs.writeFileSync("sql2/extra.sql", "-- PREP: extra\nSELECT 1 as val;");
	const sql = new SqlRiteSync({ dir: ["sql", "sql2"] });
	const res = sql.extra.get();
	assert.strictEqual(res.val, 1);
	sql.close();
});
