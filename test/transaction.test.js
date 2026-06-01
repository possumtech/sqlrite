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
			"-- PREP: debit\nUPDATE acct SET bal = bal - $amt WHERE id = $id;\n" +
			"-- PREP: credit\nUPDATE acct SET bal = bal + $amt WHERE id = $id;\n" +
			"-- PREP: bal\nSELECT bal FROM acct WHERE id = $id;",
	);
});

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe("transaction (sync)", () => {
	test("commits all calls atomically", () => {
		const sql = new SqlRiteSync({ dir: DIR });
		const results = sql.transaction([
			{ name: "debit", params: { id: 1, amt: 30 } },
			{ name: "credit", params: { id: 2, amt: 30 } },
		]);
		assert.strictEqual(results.length, 2);
		assert.strictEqual(results[0].changes, 1);
		assert.strictEqual(sql.bal.get({ id: 1 }).bal, 70);
		assert.strictEqual(sql.bal.get({ id: 2 }).bal, 30);
		sql.close();
	});

	test("rolls back every call when one fails", () => {
		const sql = new SqlRiteSync({ dir: DIR });
		assert.throws(
			() =>
				sql.transaction([
					{ name: "debit", params: { id: 1, amt: 50 } }, // ok
					{ name: "debit", params: { id: 1, amt: 9999 } }, // CHECK bal>=0 fails
				]),
			/CHECK constraint failed/,
		);
		assert.strictEqual(sql.bal.get({ id: 1 }).bal, 100, "first debit must be rolled back");
		sql.close();
	});

	test("unknown statement name fails and rolls back", () => {
		const sql = new SqlRiteSync({ dir: DIR });
		assert.throws(
			() => sql.transaction([{ name: "nope", params: {} }]),
			/no PREP statement named "nope"/,
		);
		sql.close();
	});

	test("mode get returns rows inside the transaction", () => {
		const sql = new SqlRiteSync({ dir: DIR });
		const [row] = sql.transaction([{ name: "bal", params: { id: 1 }, mode: "get" }]);
		assert.strictEqual(row.bal, 100);
		sql.close();
	});
});

describe("transaction (async)", () => {
	test("commits atomically across the worker", async () => {
		const sql = await SqlRite.open({ dir: DIR });
		await sql.transaction([
			{ name: "debit", params: { id: 1, amt: 40 } },
			{ name: "credit", params: { id: 2, amt: 40 } },
		]);
		assert.strictEqual((await sql.bal.get({ id: 1 })).bal, 60);
		await sql.close();
	});

	test("rejects and rolls back on failure", async () => {
		const sql = await SqlRite.open({ dir: DIR });
		await assert.rejects(
			() =>
				sql.transaction([
					{ name: "debit", params: { id: 1, amt: 10 } },
					{ name: "debit", params: { id: 1, amt: 9999 } },
				]),
			/CHECK constraint failed/,
		);
		assert.strictEqual((await sql.bal.get({ id: 1 })).bal, 100);
		await sql.close();
	});
});
