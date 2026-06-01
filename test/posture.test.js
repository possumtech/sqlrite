import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { SqlRiteSync } from "../SqlRite.js";

const DIR = "sql_posture";

before(() => {
	if (!fs.existsSync(DIR)) fs.mkdirSync(DIR);
	fs.writeFileSync(
		`${DIR}/001.sql`,
		"-- INIT: t\nCREATE TABLE t (name TEXT NOT NULL) STRICT;\n" +
			"-- EXEC: rewriteSchema\nPRAGMA writable_schema = ON;\nUPDATE sqlite_schema SET sql = 'x' WHERE name = 't';",
	);
});

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe("hardened connection posture", () => {
	test("rejects double-quoted string literals (the real dml_strict)", () => {
		// "oops" is not a column; with DQS off it must error at prepare time,
		// not be silently reinterpreted as a string literal.
		const badDir = "sql_dqs";
		fs.mkdirSync(badDir, { recursive: true });
		fs.writeFileSync(
			`${badDir}/001.sql`,
			'-- INIT: t\nCREATE TABLE t (name TEXT) STRICT;\n-- PREP: q\nSELECT * FROM t WHERE name = "oops";',
		);
		try {
			assert.throws(() => new SqlRiteSync({ dir: badDir }), /no such column: "oops"/);
		} finally {
			fs.rmSync(badDir, { recursive: true, force: true });
		}
	});

	test("DQS can be re-enabled via passthrough option", () => {
		const dqsDir = "sql_dqs_on";
		fs.mkdirSync(dqsDir, { recursive: true });
		fs.writeFileSync(
			`${dqsDir}/001.sql`,
			'-- INIT: t\nCREATE TABLE t (name TEXT) STRICT;\n-- PREP: q\nSELECT * FROM t WHERE name = "oops";',
		);
		try {
			const sql = new SqlRiteSync({ dir: dqsDir, enableDoubleQuotedStringLiterals: true });
			assert.deepStrictEqual(sql.q.all(), []);
			sql.close();
		} finally {
			fs.rmSync(dqsDir, { recursive: true, force: true });
		}
	});

	test("defensive blocks direct sqlite_schema writes", () => {
		const sql = new SqlRiteSync({ dir: DIR });
		assert.throws(() => sql.rewriteSchema(), /sqlite_master may not be modified/);
		sql.close();
	});

	test("user options override hardened defaults (defensive off)", () => {
		const sql = new SqlRiteSync({ dir: DIR, defensive: false });
		sql.rewriteSchema(); // permitted with defensive disabled
		sql.close();
	});

	test("bad option type fails hard", () => {
		assert.throws(
			() => new SqlRiteSync({ dir: DIR, defensive: "yes" }),
			/options\.defensive.*must be a boolean/,
		);
	});
});
