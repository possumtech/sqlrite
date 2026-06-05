import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import SqlRite, { SqlRiteSync } from "../SqlRite.js";

const DIR = "sql_tx";

before(() => {
	if (!fs.existsSync(DIR)) fs.mkdirSync(DIR);
	fs.writeFileSync(
		`${DIR}/001.sql`,
		"-- INIT: t\nCREATE TABLE acct (id INTEGER PRIMARY KEY, bal INTEGER NOT NULL CHECK (bal >= 0)) STRICT;\n" +
			"-- INIT: seed\nINSERT INTO acct (id, bal) VALUES (1, 100), (2, 0);\n" +
			"-- INIT: log\nCREATE TABLE log (id INTEGER PRIMARY KEY, msg TEXT) STRICT;\n" +
			"-- TX: transfer\nUPDATE acct SET bal = bal - $amt WHERE id = $from;\nUPDATE acct SET bal = bal + $amt WHERE id = $to;\n" +
			"-- TX: logTwice\nINSERT INTO log (msg) VALUES ($a);\nINSERT INTO log (msg) VALUES ($b);\n" +
			"-- TX: logTwiceBig bigint\nINSERT INTO log (msg) VALUES ($a);\nINSERT INTO log (msg) VALUES ($b);\n" +
			"-- PREP: bal\nSELECT bal FROM acct WHERE id = $id;",
	);
});

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe("-- TX: (sync)", () => {
	test("commits the whole body atomically", () => {
		const sql = new SqlRiteSync({ dir: DIR });
		sql.transfer({ from: 1, to: 2, amt: 30 });
		assert.strictEqual(sql.bal.get({ id: 1 }).bal, 70);
		assert.strictEqual(sql.bal.get({ id: 2 }).bal, 30);
		sql.close();
	});

	test("rolls back every statement when one fails", () => {
		const sql = new SqlRiteSync({ dir: DIR });
		assert.throws(
			() => sql.transfer({ from: 1, to: 2, amt: 9999 }), // CHECK bal>=0 fails on the debit
			/CHECK constraint failed/,
		);
		assert.strictEqual(sql.bal.get({ id: 1 }).bal, 100, "debit must be rolled back");
		assert.strictEqual(sql.bal.get({ id: 2 }).bal, 0, "credit must not have applied");
		sql.close();
	});

	test("unflagged TX returns number metadata", () => {
		const sql = new SqlRiteSync({ dir: DIR });
		const { changes, lastInsertRowid } = sql.logTwice({ a: "one", b: "two" });
		assert.strictEqual(typeof changes, "number");
		assert.strictEqual(changes, 1); // last INSERT affected one row
		assert.strictEqual(typeof lastInsertRowid, "number");
		assert.strictEqual(lastInsertRowid, 2);
		sql.close();
	});

	test("bigint-flagged TX returns BigInt metadata", () => {
		const sql = new SqlRiteSync({ dir: DIR });
		const { changes, lastInsertRowid } = sql.logTwiceBig({ a: "one", b: "two" });
		assert.strictEqual(typeof changes, "bigint");
		assert.strictEqual(changes, 1n);
		assert.strictEqual(typeof lastInsertRowid, "bigint");
		assert.strictEqual(lastInsertRowid, 2n);
		sql.close();
	});
});

describe("-- TX: (async)", () => {
	test("commits atomically across the worker", async () => {
		const sql = await SqlRite.open({ dir: DIR });
		const { lastInsertRowid } = await sql.logTwiceBig({ a: "one", b: "two" });
		assert.strictEqual(typeof lastInsertRowid, "bigint"); // BigInt survives the worker boundary
		await sql.transfer({ from: 1, to: 2, amt: 40 });
		assert.strictEqual((await sql.bal.get({ id: 1 })).bal, 60);
		await sql.close();
	});

	test("rejects and rolls back on failure", async () => {
		const sql = await SqlRite.open({ dir: DIR });
		await assert.rejects(
			() => sql.transfer({ from: 1, to: 2, amt: 9999 }),
			/CHECK constraint failed/,
		);
		assert.strictEqual((await sql.bal.get({ id: 1 })).bal, 100);
		await sql.close();
	});
});
