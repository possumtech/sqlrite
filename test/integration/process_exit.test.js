import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { SqlRiteSync } from "../../SqlRite.js";

const run = promisify(execFile);
const DIR = "sql_exit";
const DB = `${DIR}/exit.db`;

before(() => {
	fs.mkdirSync(DIR, { recursive: true });
	fs.writeFileSync(
		`${DIR}/001.sql`,
		"-- INIT: t\nCREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v INTEGER) STRICT;\n" +
			"-- PREP: put\nINSERT INTO t (v) VALUES ($v);\n" +
			"-- PREP: n\nSELECT COUNT(*) AS n FROM t;",
	);
	fs.writeFileSync(
		`${DIR}/child.mjs`,
		`import SqlRite from "../SqlRite.js";\n` +
			`const sql = await SqlRite.open({ path: "${DB}", dir: "${DIR}", readers: 1 });\n` +
			`await sql.put.run({ v: 1 });\n` +
			`sql.put.run({ v: 2 }); // in flight at script end: must hold the process until it lands\n` +
			`console.log("script end");\n`,
	);
});

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe("process exit with an unclosed instance (#8)", () => {
	test("idle instance exits the process; in-flight write completes first", async () => {
		// A real child process: before #8, the unclosed Worker held it open forever
		// (the 10 s timeout kills a hung child and fails the test).
		const { stdout } = await run(process.execPath, [`${DIR}/child.mjs`], { timeout: 10_000 });
		assert.match(stdout, /script end/);

		using check = new SqlRiteSync({ path: DB, dir: DIR });
		assert.strictEqual(check.n.get().n, 2, "both writes must land before the process exits");
	});
});
