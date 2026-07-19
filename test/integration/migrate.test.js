import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { SqlRiteSync } from "../../SqlRite.js";
import SqlRiteCore from "../../SqlRiteCore.js";

const run = promisify(execFile);
const DIR = "sql_migrate";
const DB = `${DIR}/app.db`;

// v1 and v2 of the same app's sql dir. CREATE TABLE and ALTER TABLE are
// deliberately NOT idempotent: any re-run of an applied migration throws.
before(() => {
	fs.mkdirSync(`${DIR}/m1`, { recursive: true });
	fs.mkdirSync(`${DIR}/m2`, { recursive: true });
	fs.writeFileSync(
		`${DIR}/m1/001.sql`,
		"-- MIGRATE: 1 baseline\nCREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;\n" +
			"-- PREP: addUser\nINSERT INTO users (name) VALUES ($name);\n" +
			"-- PREP: version\nPRAGMA user_version;",
	);
	fs.writeFileSync(
		`${DIR}/m2/001.sql`,
		"-- MIGRATE: 1 baseline\nCREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;\n" +
			"-- MIGRATE: 2 addEmail\nALTER TABLE users ADD COLUMN email TEXT;\n" +
			"-- PREP: addUserEmail\nINSERT INTO users (name, email) VALUES ($name, $email);\n" +
			"-- PREP: version\nPRAGMA user_version;",
	);
});

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe("-- MIGRATE (#12)", () => {
	test("fresh database applies migrations and records user_version", () => {
		using sql = new SqlRiteSync({ path: DB, dir: `${DIR}/m1` });
		sql.addUser.run({ name: "a" });
		assert.strictEqual(sql.version.get().user_version, 1);
	});

	test("reopen skips applied migrations; a later one applies only the delta", () => {
		// Re-running migration 1 would throw "table users already exists".
		using sql = new SqlRiteSync({ path: DB, dir: `${DIR}/m2` });
		assert.strictEqual(sql.version.get().user_version, 2);
		sql.addUserEmail.run({ name: "b", email: "b@x" });
	});

	test("a third open is a no-op at version 2", () => {
		// Re-running migration 2 would throw "duplicate column name: email".
		using sql = new SqlRiteSync({ path: DB, dir: `${DIR}/m2` });
		assert.strictEqual(sql.version.get().user_version, 2);
	});

	test("a failed migration rolls back its body and the version bump, and fails open", () => {
		const bad = `${DIR}/bad`;
		fs.mkdirSync(bad, { recursive: true });
		fs.writeFileSync(
			`${bad}/001.sql`,
			"-- MIGRATE: 1 broken\nCREATE TABLE t1 (id INTEGER) STRICT;\nCREATE TABLE t1 (id INTEGER) STRICT;",
		);
		const badDb = `${DIR}/bad.db`;
		assert.throws(() => new SqlRiteSync({ path: badDb, dir: bad }), /table t1 already exists/);
		const db = SqlRiteCore.openDb({ path: badDb });
		assert.strictEqual(db.prepare("PRAGMA user_version").get().user_version, 0);
		const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema").get();
		assert.strictEqual(tables.n, 0, "the first CREATE must have rolled back with the failure");
		db.close();
	});

	test("concurrent openers apply a non-idempotent migration exactly once", async () => {
		const seed = `${DIR}/seed`;
		fs.mkdirSync(seed, { recursive: true });
		fs.writeFileSync(
			`${seed}/001.sql`,
			"-- MIGRATE: 1 seed\nCREATE TABLE seeded (id INTEGER PRIMARY KEY, v INTEGER) STRICT;\nINSERT INTO seeded (v) VALUES (1);\n" +
				"-- PREP: count\nSELECT COUNT(*) AS n FROM seeded;",
		);
		const seedDb = `${DIR}/seed.db`;
		fs.writeFileSync(
			`${DIR}/opener.mjs`,
			`import SqlRite from "../SqlRite.js";\n` +
				`const sql = await SqlRite.open({ path: "${seedDb}", dir: "${seed}" });\n` +
				`await sql.close();\n`,
		);
		// Both processes race the same pending migration; BEGIN IMMEDIATE + the
		// in-lock re-check means the loser no-ops instead of double-seeding.
		await Promise.all([
			run(process.execPath, [`${DIR}/opener.mjs`], { timeout: 10_000 }),
			run(process.execPath, [`${DIR}/opener.mjs`], { timeout: 10_000 }),
		]);
		using sql = new SqlRiteSync({ path: seedDb, dir: seed });
		assert.strictEqual(sql.count.get().n, 1, "seed row must exist exactly once");
	});

	test("migrations run before INIT", () => {
		const ordered = `${DIR}/ordered`;
		fs.mkdirSync(ordered, { recursive: true });
		fs.writeFileSync(
			`${ordered}/001.sql`,
			"-- MIGRATE: 1 cfg\nCREATE TABLE cfg (k TEXT PRIMARY KEY, v TEXT) STRICT;\n" +
				"-- INIT: seedCfg\nINSERT OR IGNORE INTO cfg (k, v) VALUES ('mode', 'on');\n" +
				"-- PREP: mode\nSELECT v FROM cfg WHERE k = 'mode';",
		);
		using sql = new SqlRiteSync({ path: `${DIR}/ordered.db`, dir: ordered });
		assert.strictEqual(sql.mode.get().v, "on", "INIT must see the migrated table");
	});

	test("a current database needs zero writes: readOnly connections open", () => {
		// applyMigrations directly, isolating the zero-writes claim from initDb.
		const db = SqlRiteCore.openDb({ path: DB, readOnly: true });
		const { MIGRATE } = SqlRiteCore.loadChunks({ dir: `${DIR}/m2` });
		SqlRiteCore.applyMigrations(db, MIGRATE); // must not throw: nothing pending
		assert.strictEqual(db.prepare("PRAGMA user_version").get().user_version, 2);
		db.close();
	});
});
