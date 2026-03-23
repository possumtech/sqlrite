import { DatabaseSync } from "node:sqlite";
import SqlRiteCore from "./SqlRiteCore.js";

export default class SqlRiteSync {
	#db = null;
	#stmts = new Map();
	#protected = new Set(["close", "constructor"]);

	constructor(options = {}) {
		const defaults = {
			path: ":memory:",
			dir: "sql",
		};
		const merged = { ...defaults, ...options };
		this.#db = new DatabaseSync(merged.path, merged);

		SqlRiteCore.initDb(this.#db);
		const chunks = SqlRiteCore.loadChunks(merged);

		for (const init of chunks.INIT) {
			this.#db.exec(init.sql);
		}

		for (const exec of chunks.EXEC) {
			if (this.#protected.has(exec.name)) continue;
			this[exec.name] = () => this.#db.exec(exec.sql);
		}

		for (const prep of chunks.PREP) {
			if (this.#protected.has(prep.name)) continue;
			const stmt = this.#db.prepare(prep.sql);
			this.#stmts.set(prep.name, stmt);

			this[prep.name] = {
				all: (params = {}) => stmt.all(SqlRiteCore.jsonify(params)),
				get: (params = {}) => stmt.get(SqlRiteCore.jsonify(params)),
				run: (params = {}) => stmt.run(SqlRiteCore.jsonify(params)),
			};
		}
	}

	close() {
		this.#db.close();
	}
}
