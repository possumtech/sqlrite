import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import SqlRite from "../../SqlRite.js";

const DIR = "sql_read_pool";
const DB = `${DIR}/pool.db`;
const FUNCTION_DIR = `${DIR}/functions`;
const FUNCTIONS = [`${FUNCTION_DIR}/sleep.js`, `${FUNCTION_DIR}/workerId.js`];

before(() => {
	fs.mkdirSync(FUNCTION_DIR, { recursive: true });
	fs.writeFileSync(
		`${DIR}/001.sql`,
		"-- INIT: t\nCREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v INTEGER) STRICT;\n" +
			"-- INIT: workers\nCREATE TABLE IF NOT EXISTS workers (id INTEGER NOT NULL) STRICT;\n" +
			"-- EXEC: recordWriter\nDELETE FROM workers; INSERT INTO workers (id) VALUES (workerId());\n" +
			"-- PREP: workerIds\nSELECT (SELECT id FROM workers LIMIT 1) AS writer, workerId() AS executing;\n" +
			"-- PREP: slow\nSELECT sleep($ms) AS waited;\n" +
			"-- PREP: quick\nSELECT 1 AS n;",
	);
	fs.writeFileSync(
		`${FUNCTION_DIR}/sleep.js`,
		"export default (ms) => {\n" +
			"\tAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms));\n" +
			"\treturn ms;\n" +
			"};\n",
	);
	fs.writeFileSync(
		`${FUNCTION_DIR}/workerId.js`,
		'import { threadId } from "node:worker_threads";\nexport default () => threadId;\n',
	);
});

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe("async read Worker pool (#14)", () => {
	test("two readers execute blocking queries concurrently", async () => {
		const sql = await SqlRite.open({
			path: DB,
			dir: DIR,
			functions: FUNCTIONS,
			readers: 2,
		});
		const started = performance.now();

		await Promise.all([sql.slow.get({ ms: 600 }), sql.slow.get({ ms: 600 })]);

		assert.ok(performance.now() - started < 1_050, "reads must occupy separate Workers");
		await sql.close();
	});

	test("least-pending dispatch bypasses a busy reader", async () => {
		const sql = await SqlRite.open({
			path: DB,
			dir: DIR,
			functions: FUNCTIONS,
			readers: 2,
		});
		const short = sql.slow.get({ ms: 200 });
		const long = sql.slow.get({ ms: 1_000 });
		await short;
		await sql.quick.get(); // advances the tie cursor toward the still-busy reader

		const quick = await Promise.race([
			sql.quick.get(),
			delay(300).then(() => {
				throw new Error("quick read queued behind the busy reader");
			}),
		]);

		assert.strictEqual(quick.n, 1);
		await long;
		await sql.close();
	});

	test("default routes reads through the sole writer", async () => {
		const sql = await SqlRite.open({
			path: DB,
			dir: DIR,
			functions: FUNCTIONS,
		});
		try {
			await sql.recordWriter();
			const first = await sql.workerIds.get();
			const second = await sql.workerIds.get();

			assert.strictEqual(first.executing, first.writer, "default must not create a reader");
			assert.strictEqual(second.executing, first.writer, "default must keep using the writer");
		} finally {
			await sql.close();
		}
	});

	test("readers: 1 creates a reader separate from the writer", async () => {
		const sql = await SqlRite.open({
			path: DB,
			dir: DIR,
			functions: FUNCTIONS,
			readers: 1,
		});
		try {
			await sql.recordWriter();
			const ids = await sql.workerIds.get();

			assert.notStrictEqual(ids.executing, ids.writer, "reads must use the configured reader");
		} finally {
			await sql.close();
		}
	});

	test("readers: 0 serializes PREP modes through the writer", async () => {
		const sql = await SqlRite.open({
			path: DB,
			dir: DIR,
			functions: FUNCTIONS,
			readers: 0,
		});
		try {
			await sql.recordWriter();
			const ids = await sql.workerIds.get();

			assert.strictEqual(ids.executing, ids.writer, "readers: 0 must use the writer");
		} finally {
			await sql.close();
		}
	});

	test("invalid reader counts fail before opening Workers", async () => {
		await assert.rejects(
			() => SqlRite.open({ path: DB, dir: DIR, readers: 1.5 }),
			/readers must be a non-negative safe integer/,
		);
		await assert.rejects(
			() => SqlRite.open({ path: DB, dir: DIR, readers: -1 }),
			/readers must be a non-negative safe integer/,
		);
		await assert.rejects(
			() => SqlRite.open({ dir: DIR, readers: 1 }),
			/readers cannot be used with an in-memory database/,
		);
	});
});
