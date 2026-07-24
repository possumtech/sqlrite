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
			"-- PREP: put\nINSERT INTO t (v) VALUES ($v);\n" +
			"-- PREP: putReturning\nINSERT INTO t (v) VALUES ($v) RETURNING id;\n" +
			"-- PREP: count\nSELECT COUNT(*) AS n FROM t;",
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

	test("reads bypass a writer waiting on the write lock", async () => {
		const holder = new SqlRiteSync({ path: DB, dir: DIR });
		const sql = await SqlRite.open({ path: DB, dir: DIR });
		const before = (await sql.count.get()).n;

		holder.lock();
		const pendingWrite = sql.put.run({ v: 3 });
		try {
			const read = await Promise.race([
				sql.count.get(),
				delay(500).then(() => {
					throw new Error("read queued behind the blocked writer");
				}),
			]);
			assert.strictEqual(read.n, before, "reader must observe the last committed WAL snapshot");
		} finally {
			holder.unlock();
			await pendingWrite;
			await sql.close();
			holder.close();
		}
	});

	test("get fails hard when used with mutating SQL", async () => {
		const sql = await SqlRite.open({ path: DB, dir: DIR });
		const before = (await sql.count.get()).n;

		await assert.rejects(() => sql.putReturning.get({ v: 4 }), /readonly database/);
		assert.strictEqual((await sql.count.get()).n, before);

		await sql.close();
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
