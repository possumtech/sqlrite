import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import SqlRite, { SqlRiteSync } from "../../SqlRite.js";

// Two connections on one file DB: a sync holder takes the write lock via a
// -- TX-free BEGIN IMMEDIATE EXEC tag, an async facade (own Worker, own
// connection) writes against it. This is the contention the busy_timeout
// default exists for — a single-connection suite cannot exercise it.
const DIR = "sql_busy";
const DB = `${DIR}/contention.db`;

before(() => {
	fs.mkdirSync(DIR, { recursive: true });
	fs.writeFileSync(
		`${DIR}/001.sql`,
		"-- INIT: t\nCREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v INTEGER) STRICT;\n" +
			"-- EXEC: lock\nBEGIN IMMEDIATE;\n" +
			"-- EXEC: unlock\nCOMMIT;\n" +
			"-- PREP: put\nINSERT INTO t (v) VALUES ($v);",
	);
});

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe("busy_timeout across connections", () => {
	test("default busy_timeout waits out a held write lock instead of SQLITE_BUSY", async () => {
		const holder = new SqlRiteSync({ path: DB, dir: DIR });
		const writer = await SqlRite.open({ path: DB, dir: DIR });

		holder.lock();
		let released = false;
		const pending = writer.put.run({ v: 1 }).then((result) => ({ result, released }));
		await delay(300);
		released = true;
		holder.unlock();

		const { result, released: seenAtResolve } = await pending;
		assert.strictEqual(seenAtResolve, true, "write must not complete while the lock is held");
		assert.strictEqual(result.changes, 1);

		await writer.close();
		holder.close();
	});

	test("timeout: 0 restores immediate SQLITE_BUSY", async () => {
		const holder = new SqlRiteSync({ path: DB, dir: DIR });
		const writer = await SqlRite.open({ path: DB, dir: DIR, timeout: 0 });

		holder.lock();
		await assert.rejects(() => writer.put.run({ v: 2 }), /database is locked/);
		holder.unlock();

		await writer.close();
		holder.close();
	});
});
