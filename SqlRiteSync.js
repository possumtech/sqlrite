import { DatabaseSync } from "node:sqlite";
import SqlRiteCore from "./SqlRiteCore.js";

export default class SqlRiteSync {
	#db = null;
	#stmts = new Map();
	#protected = new Set(["close", "open", "constructor"]);

	constructor(options = {}, db) {
		const merged = { path: ":memory:", dir: "sql", ...options };
		this.#db = db ?? new DatabaseSync(merged.path, merged);
		if (!db) SqlRiteCore.initDb(this.#db);
		this.#setupChunks(merged);
	}

	static async open(options = {}) {
		const merged = { path: ":memory:", dir: "sql", ...options };
		const db = new DatabaseSync(merged.path, merged);
		SqlRiteCore.initDb(db);
		await SqlRiteCore.registerFunctions(db, merged.functions);
		return new SqlRiteSync(merged, db);
	}

	#setupChunks(merged) {
		const chunks = SqlRiteCore.loadChunks(merged);

		for (const init of chunks.INIT) {
			this.#db.exec(SqlRiteCore.template(init.sql, merged.params));
		}

		for (const exec of chunks.EXEC) {
			if (this.#protected.has(exec.name)) continue;
			this[exec.name] = (params) => this.#db.exec(SqlRiteCore.template(exec.sql, params));
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

	[Symbol.dispose]() {
		this.close();
	}
}
