import { DatabaseSync } from "node:sqlite";
import SqlRiteCore from "./SqlRiteCore.js";

export default class SqlRiteSync {
	#db = null;
	#stmts = new Map();
	#protected = new Set(["exec", "close", "constructor"]);

	constructor(options = {}) {
		const defaults = {
			path: ":memory:",
			dir: "sql",
		};
		const merged = { ...defaults, ...options };
		this.#db = new DatabaseSync(merged.path, merged);

		const dirs = Array.isArray(merged.dir) ? merged.dir : [merged.dir];
		const files = dirs.flatMap((d) => SqlRiteCore.getFiles(d));
		const chunks = SqlRiteCore.parseSql(files);

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

	exec(sql) {
		this.#db.exec(sql);
	}

	close() {
		this.#db.close();
	}
}
