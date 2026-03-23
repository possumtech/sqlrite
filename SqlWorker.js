import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import SqlRiteCore from "./SqlRiteCore.js";

const { options } = workerData;
const db = new DatabaseSync(options.path, options);

SqlRiteCore.initDb(db);

const stmts = new Map();
const execs = new Map();

const chunks = SqlRiteCore.loadChunks(options);

for (const init of chunks.INIT) {
	db.exec(init.sql);
}

for (const exec of chunks.EXEC) {
	execs.set(exec.name, exec.sql);
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
			const sql = execs.get(name);
			if (sql) db.exec(sql);
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
