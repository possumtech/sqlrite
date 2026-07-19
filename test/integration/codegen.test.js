import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const CODEGEN = path.resolve("scripts/codegen.js");
const DIR = "sql_codegen";

before(() => {
	fs.mkdirSync(`${DIR}/gen/sql`, { recursive: true });
	fs.mkdirSync(`${DIR}/base`, { recursive: true });
	fs.writeFileSync(
		`${DIR}/gen/sql/001.sql`,
		"-- PREP: findUser bigint\nSELECT * FROM users WHERE id = $id;\n" +
			"-- EXEC: vacuumDb\nVACUUM;\n" +
			"-- TX: moveFunds\nUPDATE a SET b = 1;",
	);
});

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe("codegen CLI", () => {
	test("--base emits the static surface with a loose index signature", async () => {
		await run(process.execPath, [CODEGEN, "--base"], { cwd: `${DIR}/base` });
		const dts = fs.readFileSync(`${DIR}/base/SqlRite.d.ts`, "utf8");
		assert.match(dts, /export default class SqlRite \{/);
		assert.match(dts, /export class SqlRiteSync \{/);
		assert.match(dts, /static open\(options\?: SqlRiteOptions\): Promise<SqlRite>;/);
		assert.match(dts, /\[method: string\]: any;/);
		assert.match(dts, /\[Symbol\.asyncDispose\]\(\): Promise<void>;/);
		assert.doesNotMatch(dts, /findUser/, "base output must not contain scanned methods");
	});

	test("--base emits the sync and core entry types alongside", async () => {
		const sync = fs.readFileSync(`${DIR}/base/SqlRiteSync.d.ts`, "utf8");
		const core = fs.readFileSync(`${DIR}/base/SqlRiteCore.d.ts`, "utf8");
		assert.match(sync, /export \{ SqlRiteSync as default \} from "\.\/SqlRite\.js";/);
		assert.match(core, /export default class SqlRiteCore \{/);
		assert.match(
			core,
			/static template\(sql: string, params\?: Record<string, unknown>\): string;/,
		);
	});

	test("scanning .sql emits exact method types and drops the index signature", async () => {
		await run(process.execPath, [CODEGEN], { cwd: `${DIR}/gen` });
		const dts = fs.readFileSync(`${DIR}/gen/SqlRite.d.ts`, "utf8");
		assert.match(dts, /findUser: SqlRiteBigIntPreparedStatements;/);
		assert.match(dts, /vacuumDb\(params\?: Record<string, unknown>\): Promise<SqlRiteResult>;/);
		assert.match(dts, /moveFunds\(params\?: Record<string, unknown>\): SqlRiteResult;/);
		assert.doesNotMatch(
			dts,
			/\[method: string\]/,
			"generated types must be strict — no index signature",
		);
	});
});
