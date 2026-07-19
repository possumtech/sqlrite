import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import SqlRiteCore from "./SqlRiteCore.js";

const DIR = "sql_core";

before(() => {
	fs.mkdirSync(`${DIR}/sub`, { recursive: true });
	fs.writeFileSync(`${DIR}/001-first.sql`, "-- PREP: first\nSELECT 1;");
	fs.writeFileSync(`${DIR}/002-second.sql`, "-- PREP: second\nSELECT 2;");
	fs.writeFileSync(`${DIR}/sub/999-last.sql`, "-- INIT: subInit\nSELECT 1;");
});

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe("SqlRiteCore.getFiles", () => {
	test("sorts by basename numerically", () => {
		const basenames = SqlRiteCore.getFiles(DIR).map((f) => path.basename(f));
		assert.ok(
			basenames.indexOf("001-first.sql") < basenames.indexOf("002-second.sql"),
			"001 should come before 002",
		);
	});

	test("recurses into subdirectories", () => {
		const files = SqlRiteCore.getFiles(DIR);
		assert.ok(
			files.some((f) => f.includes("999-last.sql")),
			"Should find file in subdirectory",
		);
	});
});

describe("SqlRiteCore.parseSql", () => {
	test("filters empty blocks and trims", () => {
		const file = `${DIR}/empty.sql`;
		fs.writeFileSync(file, "-- PREP: empty\n  \n  ");
		try {
			const chunks = SqlRiteCore.parseSql([file]);
			assert.strictEqual(chunks.PREP.length, 0);
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	test("parses MIGRATE versions from the tag with a cosmetic label", () => {
		const file = `${DIR}/migrate.sql`;
		fs.writeFileSync(
			file,
			"-- MIGRATE: 2 addEmail\nALTER TABLE users ADD COLUMN email TEXT;\n" +
				"-- MIGRATE: 007 padded\nSELECT 7;",
		);
		try {
			const { MIGRATE } = SqlRiteCore.parseSql([file]);
			assert.deepStrictEqual(
				MIGRATE.map((m) => m.version),
				[2, 7],
			);
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	test("throws on duplicate MIGRATE versions, including padded collisions", () => {
		const file = `${DIR}/migrate_dup.sql`;
		fs.writeFileSync(file, "-- MIGRATE: 7\nSELECT 1;\n-- MIGRATE: 007\nSELECT 2;");
		try {
			assert.throws(() => SqlRiteCore.parseSql([file]), /duplicate MIGRATE version 7/);
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	test("throws on a non-positive MIGRATE version", () => {
		const file = `${DIR}/migrate_zero.sql`;
		fs.writeFileSync(file, "-- MIGRATE: 0\nSELECT 1;");
		try {
			assert.throws(
				() => SqlRiteCore.parseSql([file]),
				/MIGRATE version must be a positive integer, got "0"/,
			);
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	test("warns on duplicate names and lets the later chunk override", () => {
		const file = `${DIR}/dup.sql`;
		fs.writeFileSync(file, "-- PREP: dup\nSELECT 1;\n-- PREP: dup\nSELECT 2;");
		const warnings = [];
		const orig = console.warn;
		console.warn = (...a) => warnings.push(a.join(" "));
		let chunks;
		try {
			chunks = SqlRiteCore.parseSql([file]);
		} finally {
			console.warn = orig;
			fs.rmSync(file, { force: true });
		}
		assert.match(warnings.join("\n"), /duplicate name "dup"/);
		const dup = chunks.PREP.filter((c) => c.name === "dup");
		assert.strictEqual(dup.at(-1).sql, "SELECT 2;");
	});
});

describe("SqlRiteCore.template", () => {
	test("escapes single quotes by doubling them", () => {
		assert.strictEqual(SqlRiteCore.template("name = $v", { v: "O'Brien" }), "name = 'O''Brien'");
	});

	test("inlines numbers, booleans, and null unquoted", () => {
		assert.strictEqual(
			SqlRiteCore.template("$n $t $f $z", { n: 42, t: true, f: false, z: null }),
			"42 1 0 NULL",
		);
	});

	test("throws on an unbound $param instead of letting exec bind NULL", () => {
		assert.throws(
			() => SqlRiteCore.template("$known $missing", { known: 1 }),
			/unbound parameter \$missing/,
		);
	});

	test("throws on : and @ tokens too — exec NULLs every parameter style", () => {
		assert.throws(() => SqlRiteCore.template("SELECT :x", undefined), /unbound parameter :x/);
		assert.throws(() => SqlRiteCore.template("SELECT @x", undefined), /unbound parameter @x/);
	});

	test("dollar text inside string literals and comments is not a parameter", () => {
		const sql =
			"SELECT 'cost: $5' AS c; -- refine $later\n/* or $even later */ SELECT 'don''t $stop';";
		assert.strictEqual(SqlRiteCore.template(sql, undefined), sql);
	});

	test("identifiers containing $ are legal SQLite, not parameters", () => {
		assert.strictEqual(SqlRiteCore.template("SELECT a$b FROM t", undefined), "SELECT a$b FROM t");
	});

	test("returns SQL unchanged when params is absent", () => {
		assert.strictEqual(SqlRiteCore.template("SELECT 1", undefined), "SELECT 1");
	});

	test("coerces non-primitive values via String() (not JSON)", () => {
		// template is the trusted-input path; objects/arrays stringify, they are not JSON-encoded
		assert.strictEqual(SqlRiteCore.template("$v", { v: [1, 2] }), "'1,2'");
		assert.strictEqual(SqlRiteCore.template("$v", { v: { a: 1 } }), "'[object Object]'");
	});
});

describe("SqlRiteCore.registerFunctions", () => {
	test("throws when a module's default export is not a function", async () => {
		const file = "core_badfn.mjs";
		fs.writeFileSync(file, "export default 42;\n");
		const db = new DatabaseSync(":memory:");
		try {
			await assert.rejects(
				() => SqlRiteCore.registerFunctions(db, `./${file}`),
				/must have a default export that is a function/,
			);
		} finally {
			db.close();
			fs.rmSync(file, { force: true });
		}
	});

	test("is a no-op when functions option is absent", async () => {
		const db = new DatabaseSync(":memory:");
		await SqlRiteCore.registerFunctions(db, undefined); // must not throw
		db.close();
	});
});

describe("SqlRiteCore.jsonify", () => {
	test("handles objects and arrays", () => {
		const input = { arr: [1, 2], obj: { a: 1 }, str: "val", nil: null };
		const output = SqlRiteCore.jsonify(input);
		assert.strictEqual(output.arr, "[1,2]");
		assert.strictEqual(output.obj, '{"a":1}');
		assert.strictEqual(output.str, "val");
		assert.strictEqual(output.nil, null);
		assert.deepStrictEqual(SqlRiteCore.jsonify(null), {});
	});

	test("strips SQL prefixes from keys", () => {
		const input = { $name: "val1", ":age": 20, "@id": 1 };
		const output = SqlRiteCore.jsonify(input);
		assert.strictEqual(output.name, "val1");
		assert.strictEqual(output.age, 20);
		assert.strictEqual(output.id, 1);
		assert.ok(!("$name" in output));
	});

	test("booleans bind as 1/0 (node:sqlite rejects raw booleans)", () => {
		const output = SqlRiteCore.jsonify({ on: true, off: false });
		assert.strictEqual(output.on, 1);
		assert.strictEqual(output.off, 0);
	});

	test("TypedArrays pass through untouched for BLOB binding", () => {
		const blob = new Uint8Array([1, 2, 3]);
		assert.strictEqual(SqlRiteCore.jsonify({ blob }).blob, blob);
	});

	test("unbindable types throw a named error at the boundary", () => {
		assert.throws(
			() => SqlRiteCore.jsonify({ when: new Date() }),
			/unsupported parameter type Date for \$when/,
		);
		assert.throws(
			() => SqlRiteCore.jsonify({ m: new Map() }),
			/unsupported parameter type Map for \$m/,
		);
		assert.throws(
			() => SqlRiteCore.jsonify({ u: undefined }),
			/unsupported parameter type undefined for \$u/,
		);
	});
});

describe("SqlRiteCore.parseSql reserved names", () => {
	test("a tag that can never become a method throws at load", () => {
		const file = `${DIR}/reserved.sql`;
		fs.writeFileSync(file, "-- PREP: close\nSELECT 1;");
		try {
			assert.throws(() => SqlRiteCore.parseSql([file]), /"close" is a reserved name \(PREP/);
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	test("INIT may use reserved words — it never becomes a method", () => {
		const file = `${DIR}/reserved_init.sql`;
		fs.writeFileSync(file, "-- INIT: open\nSELECT 1;");
		try {
			assert.strictEqual(SqlRiteCore.parseSql([file]).INIT.length, 1);
		} finally {
			fs.rmSync(file, { force: true });
		}
	});
});
