import { parentPort, workerData } from "node:worker_threads";
import SqlRiteCore from "./SqlRiteCore.js";

const port = /** @type {import("node:worker_threads").MessagePort} */ (parentPort);

const { options } = workerData;
const db = SqlRiteCore.openDb(options);

SqlRiteCore.initDb(db, options);
await SqlRiteCore.registerFunctions(db, options.functions);

const stmts = new Map();
const execs = new Map();
const txs = new Map();
const metas = new Map(); // name -> meta read (bigint or number) per the chunk's flag
const metaNum = SqlRiteCore.prepareMeta(db, false);
const metaBig = SqlRiteCore.prepareMeta(db, true);

const chunks = SqlRiteCore.loadChunks(options);

for (const init of chunks.INIT) {
	db.exec(SqlRiteCore.template(init.sql, options.params));
}

for (const exec of chunks.EXEC) {
	execs.set(exec.name, exec.sql);
	metas.set(exec.name, exec.bigint ? metaBig : metaNum);
}

for (const tx of chunks.TX) {
	txs.set(tx.name, tx.sql);
	metas.set(tx.name, tx.bigint ? metaBig : metaNum);
}

for (const prep of chunks.PREP) {
	const stmt = db.prepare(prep.sql);
	if (prep.bigint) stmt.setReadBigInts(true);
	stmts.set(prep.name, stmt);
	metas.set(prep.name, prep.bigint ? metaBig : metaNum);
}

// Signal ready
port.postMessage({
	type: "READY",
	names: {
		EXEC: chunks.EXEC.map((e) => e.name),
		TX: chunks.TX.map((t) => t.name),
		PREP: chunks.PREP.map((p) => p.name),
	},
});

port.on("message", (msg) => {
	const { id, type, name, params } = msg;

	try {
		let result;
		if (type === "EXEC") {
			db.exec(SqlRiteCore.template(execs.get(name), params));
			result = SqlRiteCore.result(metas.get(name));
		} else if (type === "TX") {
			db.exec("BEGIN");
			try {
				db.exec(SqlRiteCore.template(txs.get(name), params));
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
			result = SqlRiteCore.result(metas.get(name));
		} else if (type === "PREP_ALL") {
			result = stmts.get(name).all(SqlRiteCore.jsonify(params));
		} else if (type === "PREP_GET") {
			result = stmts.get(name).get(SqlRiteCore.jsonify(params));
		} else if (type === "PREP_RUN") {
			stmts.get(name).run(SqlRiteCore.jsonify(params));
			result = SqlRiteCore.result(metas.get(name));
		} else if (type === "CLOSE") {
			db.close();
			port.postMessage({ id, result: null });
			process.exit(0);
		}

		port.postMessage({ id, result });
	} catch (error) {
		// postMessage structured-clones Errors: class, message, stack, and cause
		// survive the boundary; non-standard own props (e.g. errcode) do not.
		port.postMessage({ id, error });
	}
});
