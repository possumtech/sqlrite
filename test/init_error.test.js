import assert from "node:assert/strict";
import fs from "node:fs";
import { after, describe, test } from "node:test";
import SqlRite from "../SqlRite.js";

describe("SqlRite Initialization Error Handling", () => {
	// Create a directory with a faulty SQL file
	if (!fs.existsSync("sql_init_error")) fs.mkdirSync("sql_init_error");
	fs.writeFileSync(
		"sql_init_error/faulty.sql",
		"-- INIT: faulty\nINSERT INTO non_existent_table VALUES (1);",
	);

	after(() => {
		fs.rmSync("sql_init_error", { recursive: true, force: true });
	});

	test("should reject readyPromise on initialization error", async () => {
		const db = new SqlRite({
			path: ":memory:",
			dir: "sql_init_error",
		});

		await assert.rejects(
			async () => await db.exec("SELECT 1"),
			/no such table: non_existent_table/,
		);

		try {
			await db.close();
		} catch (_e) {
			// Ignore error during close
		}
	});
});
