import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import SqlRite, { SqlRiteSync } from "../SqlRite.js";

const DIR = "sql_lifecycle";
const DB = `${DIR}/lifecycle.db`;

before(() => {
	fs.mkdirSync(DIR, { recursive: true });
	fs.writeFileSync(
		`${DIR}/001.sql`,
		"-- INIT: t\nCREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v INTEGER) STRICT;\n" +
			"-- PREP: count\nSELECT COUNT(*) AS n FROM t;\n" +
			"-- PREP: addReturning\nINSERT INTO t (v) VALUES ($v) RETURNING id;",
	);
});

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

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
		const sql = await SqlRite.open({ path: DB, dir: DIR, readers: 1 });
		await sql.close();
		await sql.close(); // second close must be a no-op, not throw
	});

	test("async Symbol.asyncDispose closes the worker", async () => {
		const sql = await SqlRite.open({ path: DB, dir: DIR, readers: 1 });
		await sql[Symbol.asyncDispose]();
		await assert.rejects(() => sql.count.get(), /closed/i);
	});

	test("async close drains a RETURNING call rerouted to the writer", async () => {
		const sql = await SqlRite.open({ path: DB, dir: DIR, readers: 1 });
		const inserted = sql.addReturning.get({ v: 1 });
		const closing = sql.close();

		assert.strictEqual(typeof (await inserted).id, "number");
		await closing;
	});
});
