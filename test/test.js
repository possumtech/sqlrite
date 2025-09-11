import assert from "node:assert";
import test from "node:test";
import SqlRite from "../SqlRite.js";

test("SqlRite.js", (t) => {
	t.test("constructor()", async () => {
		const sql = new SqlRite();

		sql.addEmployee.run({ name: "John", position: "CEO", salary: 99999 });
		sql.addEmployee.run({ name: "Jane", position: "COO", salary: 49998 });
		sql.addEmployee.run({ name: "Jack", position: "CFO", salary: 49997 });
		sql.addEmployee.run({ name: "Jill", position: "CIO", salary: 49996 });

		const employee = sql.getHighestPaidEmployee.get();
		assert(employee?.name === "John", "Highest paid employee should be John");

		const positions = await sql.async.getPositions.all();
		assert(positions.length === 4, "There should be four positions");

		sql.deleteTable();

		sql.close();
	});

	t.test("getFiles()", () => {
		const sql = new SqlRite();

		const files = sql.getFiles("sql");

		assert(files.length > 0, "At least one SQL file in the sql directory?");
	});

	t.test("close()", () => {
		const sql = new SqlRite();

		sql.close();

		assert(true, "Database closed without error");
	});
});
