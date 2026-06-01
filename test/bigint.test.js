import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import SqlRite, { SqlRiteSync } from "../SqlRite.js";

const DIR = "sql_bigint";
const OVER_2_53 = 9007199254740993n; // 2^53 + 1

before(() => {
	if (!fs.existsSync(DIR)) fs.mkdirSync(DIR);
	fs.writeFileSync(
		`${DIR}/001.sql`,
		"-- INIT: t\nCREATE TABLE ledger (amount INTEGER NOT NULL) STRICT;\n" +
			"-- PREP: add\nINSERT INTO ledger (amount) VALUES ($amount);\n" +
			"-- PREP: total bigint\nSELECT SUM(amount) AS total FROM ledger;\n" +
			"-- PREP: totalNum\nSELECT SUM(amount) AS total FROM ledger;",
	);
});

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe("bigint marker (sync)", () => {
	test("a bigint PREP returns exact BigInt above 2^53", () => {
		const sql = new SqlRiteSync({ dir: DIR });
		sql.add.run({ amount: OVER_2_53 });
		const { total } = sql.total.get();
		assert.strictEqual(typeof total, "bigint");
		assert.strictEqual(total, OVER_2_53);
		sql.close();
	});

	test("an unmarked PREP throws on the same magnitude (no silent loss)", () => {
		const sql = new SqlRiteSync({ dir: DIR });
		sql.add.run({ amount: OVER_2_53 });
		assert.throws(() => sql.totalNum.get(), /too large to be represented/);
		sql.close();
	});
});

describe("bigint marker (async)", () => {
	test("BigInt survives the worker boundary", async () => {
		const sql = await SqlRite.open({ dir: DIR });
		await sql.add.run({ amount: OVER_2_53 });
		const { total } = await sql.total.get();
		assert.strictEqual(typeof total, "bigint");
		assert.strictEqual(total, OVER_2_53);
		await sql.close();
	});
});
