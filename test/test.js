import assert from "node:assert";
import SqlRite from "../SqlRite.js";

const sql = new SqlRite();

sql.addEmployee.run({ name: "John", position: "CEO", salary: 99999 });
sql.addEmployee.run({ name: "Jane", position: "COO", salary: 49998 });
sql.addEmployee.run({ name: "Jack", position: "CFO", salary: 49997 });
sql.addEmployee.run({ name: "Jill", position: "CIO", salary: 49996 });

const employee = sql.getHighestPaidEmployee.get();

assert(employee?.name === "John", "The highest paid employee should be John");

sql.async.getPositions.all().then((positions) => console.log(positions));

console.log(`The highest paid employee is ${employee.name}.`);

sql.deleteTable();
