import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import SqlRiteCore from "./SqlRiteCore.js";

const { options } = workerData;
const db = new DatabaseSync(options.path, options);

// Performance and Safety Defaults
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA dml_strict = ON;");

const stmts = new Map();

// Initialize
const dirs = Array.isArray(options.dir) ? options.dir : [options.dir];
const files = dirs.flatMap((d) => SqlRiteCore.getFiles(d));
const chunks = SqlRiteCore.parseSql(files);

for (const init of chunks.INIT) {
	db.exec(init.sql);
}

for (const prep of chunks.PREP) {
	const stmt = db.prepare(prep.sql);
	stmts.set(prep.name, stmt);
}

// Signal ready
parentPort.postMessage({
	type: "READY",
	names: {
		EXEC: chunks.EXEC.map((e) => e.name),
		PREP: chunks.PREP.map((p) => p.name),
	},
});

parentPort.on("message", (msg) => {
	const { id, type, name, params } = msg;

	try {
		let result;
		if (type === "EXEC") {
			const chunk = chunks.EXEC.find((e) => e.name === name);
			if (chunk) {
				db.exec(chunk.sql);
			}
			result = null;
		} else if (type === "PREP_ALL") {
			result = stmts.get(name).all(SqlRiteCore.jsonify(params));
		} else if (type === "PREP_GET") {
			result = stmts.get(name).get(SqlRiteCore.jsonify(params));
		} else if (type === "PREP_RUN") {
			result = stmts.get(name).run(SqlRiteCore.jsonify(params));
		} else if (type === "CLOSE") {
			db.close();
			parentPort.postMessage({ id, result: null });
			process.exit(0);
		}

		parentPort.postMessage({ id, result });
	} catch (error) {
		parentPort.postMessage({ id, error: error.message });
	}
});
