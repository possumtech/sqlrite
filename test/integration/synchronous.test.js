import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import SqlRite, { SqlRiteSync } from "../../SqlRite.js";

const DIR = "sql_synchronous";
const SYNC_DB = "synchronous_full.db";
const DEFAULT_DB = "synchronous_default.db";
const ASYNC_DB = "synchronous_async_full.db";
const ASYNC_DEFAULT_DB = "synchronous_async_default.db";

before(() => {
	fs.mkdirSync(DIR, { recursive: true });
	fs.writeFileSync(
		`${DIR}/001.sql`,
		"-- MIGRATE: 1 base\nCREATE TABLE observed (v);\n" +
			"INSERT INTO observed SELECT synchronous FROM pragma_synchronous;\n" +
			"-- PREP: getSync\nPRAGMA synchronous;\n" +
			"-- PREP: readObserved\nSELECT v AS v FROM observed;",
	);
});

after(() => {
	fs.rmSync(DIR, { recursive: true, force: true });
	for (const file of [SYNC_DB, DEFAULT_DB, ASYNC_DB, ASYNC_DEFAULT_DB]) {
		for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true });
	}
});

describe("synchronous option", () => {
	const level = (sql) => Object.values(sql.getSync.get())[0];

	test("sync facade: FULL reaches the writing connection before migrations", () => {
		const sql = new SqlRiteSync({ path: SYNC_DB, dir: DIR, synchronous: "FULL" });
		assert.strictEqual(level(sql), 2); // FULL
		assert.deepStrictEqual(
			sql.readObserved.all().map((r) => ({ v: r.v })),
			[{ v: 2 }],
		);
		sql.close();
	});

	test("sync facade: the default stays NORMAL", () => {
		const sql = new SqlRiteSync({ path: DEFAULT_DB, dir: DIR });
		assert.strictEqual(level(sql), 1); // NORMAL
		assert.deepStrictEqual(
			sql.readObserved.all().map((r) => ({ v: r.v })),
			[{ v: 1 }],
		);
		sql.close();
	});

	test("sync constructor rejects explicit null instead of selecting NORMAL", () => {
		assert.throws(
			() => new SqlRiteSync({ path: ":memory:", dir: DIR, synchronous: null }),
			/synchronous must be one of/,
		);
	});

	test("sync open rejects explicit null instead of selecting NORMAL", async () => {
		await assert.rejects(
			() => SqlRiteSync.open({ path: ":memory:", dir: DIR, synchronous: null }),
			/synchronous must be one of/,
		);
	});

	test("async facade: FULL reaches a fresh migration, reader, and reopen", async () => {
		const options = { path: ASYNC_DB, dir: DIR, readers: 1, synchronous: "FULL" };
		const first = await SqlRite.open(options);
		assert.strictEqual(Object.values(await first.getSync.get())[0], 2);
		assert.deepStrictEqual(
			(await first.readObserved.all()).map((r) => ({ v: r.v })),
			[{ v: 2 }],
		);
		await first.close();

		const second = await SqlRite.open(options);
		assert.strictEqual(Object.values(await second.getSync.get())[0], 2);
		await second.close();
	});

	test("async facade: a fresh open defaults migrations and writes to NORMAL", async () => {
		const sql = await SqlRite.open({ path: ASYNC_DEFAULT_DB, dir: DIR });
		assert.strictEqual(Object.values(await sql.getSync.get())[0], 1);
		assert.deepStrictEqual(
			(await sql.readObserved.all()).map((r) => ({ v: r.v })),
			[{ v: 1 }],
		);
		await sql.close();
	});

	test("async facade rejects explicit null instead of selecting NORMAL", async () => {
		await assert.rejects(
			() => SqlRite.open({ path: ":memory:", dir: DIR, synchronous: null }),
			/synchronous must be one of/,
		);
	});
});
