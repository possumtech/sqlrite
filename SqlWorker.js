import { parentPort, workerData } from "node:worker_threads";
import SqlRiteCore from "./SqlRiteCore.js";

const port = /** @type {import("node:worker_threads").MessagePort} */ (parentPort);

const { options } = workerData;
const db = SqlRiteCore.openDb(options);

SqlRiteCore.initDb(db);
await SqlRiteCore.registerFunctions(db, options.functions);

const stmts = new Map();
const execs = new Map();

const chunks = SqlRiteCore.loadChunks(options);

for (const init of chunks.INIT) {
	db.exec(SqlRiteCore.template(init.sql, options.params));
}

for (const exec of chunks.EXEC) {
	execs.set(exec.name, exec.sql);
}

for (const prep of chunks.PREP) {
	const stmt = db.prepare(prep.sql);
	if (prep.bigint) stmt.setReadBigInts(true);
	stmts.set(prep.name, stmt);
}

// Signal ready
port.postMessage({
	type: "READY",
	names: {
		EXEC: chunks.EXEC.map((e) => e.name),
		PREP: chunks.PREP.map((p) => p.name),
	},
});

port.on("message", (msg) => {
	const { id, type, name, params, calls } = msg;

	try {
		let result;
		if (type === "EXEC") {
			const sql = execs.get(name);
			if (sql) db.exec(SqlRiteCore.template(sql, params));
			result = null;
		} else if (type === "TRANSACTION") {
			db.exec("BEGIN");
			try {
				result = calls.map(({ name: callName, params: callParams, mode = "run" }) => {
					const stmt = stmts.get(callName);
					if (!stmt) throw new Error(`SqlRite: no PREP statement named "${callName}"`);
					return stmt[mode](SqlRiteCore.jsonify(callParams));
				});
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		} else if (type === "PREP_ALL") {
			result = stmts.get(name).all(SqlRiteCore.jsonify(params));
		} else if (type === "PREP_GET") {
			result = stmts.get(name).get(SqlRiteCore.jsonify(params));
		} else if (type === "PREP_RUN") {
			result = stmts.get(name).run(SqlRiteCore.jsonify(params));
		} else if (type === "CLOSE") {
			db.close();
			port.postMessage({ id, result: null });
			process.exit(0);
		}

		port.postMessage({ id, result });
	} catch (error) {
		port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
	}
});
