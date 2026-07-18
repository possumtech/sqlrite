import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { SqlRiteSync } from "../SqlRite.js";
import SqlRiteCore from "../SqlRiteCore.js";

const DIR = "sql_posture";

before(() => {
	fs.mkdirSync(DIR, { recursive: true });
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

describe("tuning knobs", () => {
	// busy_timeout reports its value under a column named "timeout", so read by position, not name.
	const pragma = (db, name) => Object.values(db.prepare(`PRAGMA ${name}`).get())[0];

	test("busy_timeout defaults to a non-zero value", () => {
		const db = SqlRiteCore.openDb({ path: ":memory:" });
		assert.strictEqual(pragma(db, "busy_timeout"), 5000);
		db.close();
	});

	test("timeout option overrides the busy_timeout default", () => {
		const db = SqlRiteCore.openDb({ path: ":memory:", timeout: 250 });
		assert.strictEqual(pragma(db, "busy_timeout"), 250);
		db.close();
	});

	test("cacheSize applies as a signed cache_size (negative = KiB)", () => {
		const db = SqlRiteCore.openDb({ path: ":memory:" });
		SqlRiteCore.initDb(db, { cacheSize: -4000 });
		assert.strictEqual(pragma(db, "cache_size"), -4000);
		db.close();
	});

	test("maxPageCount applies as a hard page ceiling", () => {
		const db = SqlRiteCore.openDb({ path: ":memory:" });
		SqlRiteCore.initDb(db, { maxPageCount: 1000 });
		assert.strictEqual(pragma(db, "max_page_count"), 1000);
		db.close();
	});

	test("absent knobs are a no-op", () => {
		const db = SqlRiteCore.openDb({ path: ":memory:" });
		SqlRiteCore.initDb(db, {}); // must not throw
		db.close();
	});

	test("non-integer cacheSize fails hard", () => {
		const db = SqlRiteCore.openDb({ path: ":memory:" });
		assert.throws(
			() => SqlRiteCore.initDb(db, { cacheSize: 1.5 }),
			/cacheSize must be a safe integer/,
		);
		db.close();
	});

	test("negative mmapSize fails hard", () => {
		const db = SqlRiteCore.openDb({ path: ":memory:" });
		assert.throws(
			() => SqlRiteCore.initDb(db, { mmapSize: -1 }),
			/mmapSize must be a non-negative safe integer/,
		);
		db.close();
	});

	test("non-positive maxPageCount fails hard", () => {
		const db = SqlRiteCore.openDb({ path: ":memory:" });
		assert.throws(
			() => SqlRiteCore.initDb(db, { maxPageCount: 0 }),
			/maxPageCount must be a positive safe integer/,
		);
		db.close();
	});
});
