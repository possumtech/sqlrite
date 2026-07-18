import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import SqlRite from "../SqlRite.js";

describe("SqlRite Initialization Error Handling", () => {
	before(() => {
		fs.mkdirSync("sql_init_error", { recursive: true });
		fs.writeFileSync(
			"sql_init_error/faulty.sql",
			"-- INIT: faulty\nINSERT INTO non_existent_table VALUES (1);",
		);
	});

	after(() => {
		fs.rmSync("sql_init_error", { recursive: true, force: true });
	});

	test("should reject readyPromise on initialization error (via open)", async () => {
		await assert.rejects(
			async () =>
				await SqlRite.open({
					path: ":memory:",
					dir: "sql_init_error",
				}),
			/no such table: non_existent_table/,
		);
	});
});
