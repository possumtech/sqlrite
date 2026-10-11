import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import SqlRite, { SqlRiteSync } from "../SqlRite.js";
import SqlRiteCore from "../SqlRiteCore.js";

const DIR = "sql_lifecycle";
const DB = `${DIR}/lifecycle.db`;
const BAD_FUNCTION = `${DIR}/bad-function.mjs`;
const FAILURE_ROOT = "sql_lifecycle_failures";
const SETUP_FAILURES = [
	{
		stage: "SQL loading",
		dir: `${FAILURE_ROOT}/missing`,
		error: /ENOENT|no such file or directory/,
	},
	{
		stage: "migration",
		dir: `${FAILURE_ROOT}/migration`,
		sql: "-- MIGRATE: 1 broken\nCREATE TABLE duplicate (id); CREATE TABLE duplicate (id);",
		error: /table duplicate already exists/,
	},
	{
		stage: "INIT",
		dir: `${FAILURE_ROOT}/init`,
		sql: "-- INIT: broken\nINSERT INTO missing VALUES (1);",
		error: /no such table: missing/,
	},
	{
		stage: "statement preparation",
		dir: `${FAILURE_ROOT}/prepare`,
		sql: "-- PREP: broken\nTHIS IS NOT SQL;",
		error: /syntax error/,
	},
];

function assertClosed(db) {
	assert.throws(() => db.exec("SELECT 1"), /database is not open/);
}

before(() => {
	fs.mkdirSync(DIR, { recursive: true });
	fs.writeFileSync(
		`${DIR}/001.sql`,
		"-- INIT: t\nCREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v INTEGER) STRICT;\n" +
			"-- PREP: count\nSELECT COUNT(*) AS n FROM t;\n" +
			"-- PREP: addReturning\nINSERT INTO t (v) VALUES ($v) RETURNING id;",
	);
	fs.writeFileSync(BAD_FUNCTION, "export default 42;\n");
	for (const { dir, sql } of SETUP_FAILURES) {
		if (sql === undefined) continue;
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(`${dir}/001.sql`, sql);
	}
});

after(() => {
	fs.rmSync(DIR, { recursive: true, force: true });
	fs.rmSync(FAILURE_ROOT, { recursive: true, force: true });
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

	test("sync constructor closes its database when posture initialization fails", (t) => {
		const db = new DatabaseSync(":memory:");
		t.mock.method(SqlRiteCore, "openDb", () => db);

		assert.throws(
			() => new SqlRiteSync({ dir: DIR, synchronous: null }),
			/synchronous must be one of/,
		);
		assertClosed(db);
	});

	test("sync open closes its database when function registration fails", async (t) => {
		const db = new DatabaseSync(":memory:");
		t.mock.method(SqlRiteCore, "openDb", () => db);

		await assert.rejects(
			() => SqlRiteSync.open({ dir: DIR, functions: BAD_FUNCTION }),
			/must have a default export that is a function/,
		);
		assertClosed(db);
	});

	for (const { stage, dir, error } of SETUP_FAILURES) {
		test(`sync open closes its handed-off database after ${stage} fails`, async (t) => {
			const db = new DatabaseSync(":memory:");
			t.mock.method(SqlRiteCore, "openDb", () => db);

			await assert.rejects(() => SqlRiteSync.open({ dir }), error);
			assertClosed(db);
		});
	}

	test("sync initialization surfaces both initialization and cleanup failures", () => {
		const initializationError = new Error("initialization failed");
		const cleanupError = new Error("cleanup failed");
		const db = {
			prepare() {
				throw initializationError;
			},
			close() {
				throw cleanupError;
			},
		};

		assert.throws(
			() => new SqlRiteSync({}, /** @type {any} */ (db)),
			(error) => {
				assert.ok(error instanceof AggregateError);
				assert.strictEqual(error.cause, initializationError);
				assert.deepStrictEqual(error.errors, [initializationError, cleanupError]);
				return true;
			},
		);
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
