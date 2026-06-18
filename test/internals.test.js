import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import SqlRite, { SqlRiteSync } from "../SqlRite.js";
import SqlRiteCore from "../SqlRiteCore.js";

const DIR = "sql_internals";

before(() => {
	if (!fs.existsSync(DIR)) fs.mkdirSync(DIR);
	fs.writeFileSync(
		`${DIR}/001.sql`,
		"-- INIT: t\nCREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER) STRICT;\n" +
			"-- PREP: count\nSELECT COUNT(*) AS n FROM t;",
	);
});

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe("SqlRiteCore.template", () => {
	test("escapes single quotes by doubling them", () => {
		assert.strictEqual(SqlRiteCore.template("name = $v", { v: "O'Brien" }), "name = 'O''Brien'");
	});

	test("inlines numbers, booleans, and null unquoted", () => {
		assert.strictEqual(
			SqlRiteCore.template("$n $t $f $z", { n: 42, t: true, f: false, z: null }),
			"42 1 0 NULL",
		);
	});

	test("leaves unknown $keys untouched", () => {
		assert.strictEqual(SqlRiteCore.template("$known $missing", { known: 1 }), "1 $missing");
	});

	test("returns SQL unchanged when params is absent", () => {
		assert.strictEqual(SqlRiteCore.template("SELECT 1", undefined), "SELECT 1");
	});

	test("coerces non-primitive values via String() (not JSON)", () => {
		// template is the trusted-input path; objects/arrays stringify, they are not JSON-encoded
		assert.strictEqual(SqlRiteCore.template("$v", { v: [1, 2] }), "'1,2'");
		assert.strictEqual(SqlRiteCore.template("$v", { v: { a: 1 } }), "'[object Object]'");
	});
});

describe("SqlRiteCore.registerFunctions", () => {
	test("throws when a module's default export is not a function", async () => {
		const file = "internals_badfn.mjs";
		fs.writeFileSync(file, "export default 42;\n");
		const db = new DatabaseSync(":memory:");
		try {
			await assert.rejects(
				() => SqlRiteCore.registerFunctions(db, `./${file}`),
				/must have a default export that is a function/,
			);
		} finally {
			db.close();
			fs.rmSync(file, { force: true });
		}
	});

	test("is a no-op when functions option is absent", async () => {
		const db = new DatabaseSync(":memory:");
		await SqlRiteCore.registerFunctions(db, undefined); // must not throw
		db.close();
	});
});

describe("SqlRiteCore.parseSql duplicate names", () => {
	test("warns and lets the later chunk override the earlier", () => {
		const file = `${DIR}/dup.sql`;
		fs.writeFileSync(file, "-- PREP: dup\nSELECT 1;\n-- PREP: dup\nSELECT 2;");
		const warnings = [];
		const orig = console.warn;
		console.warn = (...a) => warnings.push(a.join(" "));
		let chunks;
		try {
			chunks = SqlRiteCore.parseSql([file]);
		} finally {
			console.warn = orig;
			fs.rmSync(file, { force: true });
		}
		assert.match(warnings.join("\n"), /duplicate name "dup"/);
		const dup = chunks.PREP.filter((c) => c.name === "dup");
		assert.strictEqual(dup.at(-1).sql, "SELECT 2;");
	});
});

describe("lifecycle / disposal", () => {
	test("sync Symbol.dispose closes the db (via using)", () => {
		let ref;
		{
			using sql = new SqlRiteSync({ dir: DIR });
			ref = sql;
			assert.strictEqual(sql.count.get().n, 0);
		}
		assert.throws(() => ref.count.get(), /statement has been finalized/);
	});

	test("async close is idempotent", async () => {
		const sql = await SqlRite.open({ dir: DIR });
		await sql.close();
		await sql.close(); // second close must be a no-op, not throw
	});

	test("async Symbol.asyncDispose closes the worker", async () => {
		const sql = await SqlRite.open({ dir: DIR });
		await sql[Symbol.asyncDispose]();
		await assert.rejects(() => sql.count.get(), /closed/i);
	});
});
