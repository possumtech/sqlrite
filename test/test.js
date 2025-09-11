import assert from "node:assert";
import test from "node:test";
import SqlRite from "../SqlRite.js";

test("SqlRite.js", (t) => {
	t.test("constructor()", () => {
		const sql = new SqlRite();
		assert(sql instanceof SqlRite, "sql is an instance of SqlRite");
	});

		const sql = new SqlRite();

	t.test("run()", () => {
		sql.addEmployee.run({ name: "John", position: "CEO", salary: 99999 });
		sql.addEmployee.run({ name: "Jane", position: "COO", salary: 49998 });
		sql.addEmployee.run({ name: "Jack", position: "CFO", salary: 49997 });
		sql.addEmployee.run({ name: "Jill", position: "CIO", salary: 49996 });
	});

	t.test("get()", () => {
		const employee = sql.getHighestPaidEmployee.get();
		assert(employee?.name === "John", "Highest paid employee should be John");
	});

	t.test("all()", () => {
		const positionsSync = sql.getPositions.all();
		assert(positionsSync.length === 4, "There should be four positions");
	});

	t.test("async", async () => {
		const positionsAsync = await sql.async.getPositions.all();
		assert(positionsAsync.length === 4, "There should be four positions");
	});

	t.test("json_each operations", () => {
		sql.deleteEmployees.run({ names: ["Jane", "Jack"] });
		const remaining = sql.getPositions.all();
		assert(remaining.length === 2, "There should be two employees remaining");
	});

	t.test("exec operations", () => {
		sql.deleteTable();
	});

	t.test("getFiles()", () => {
		const files = sql.getFiles("sql");

		assert(files.length > 0, "At least one SQL file in the sql directory?");
	});

	t.test("close()", () => {
		const sql = new SqlRite();

		sql.close();

		assert(true, "Database closed without error");
	});
});
