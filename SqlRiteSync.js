import SqlRiteCore from "./SqlRiteCore.js";

export default class SqlRiteSync {
	/** @type {import("node:sqlite").DatabaseSync} */
	#db;
	#stmts = new Map();
	#protected = new Set(["close", "open", "constructor", "transaction"]);

	/**
	 * @param {import("./SqlRiteCore.js").SqlRiteOptions} [options]
	 * @param {import("node:sqlite").DatabaseSync} [db]
	 */
	constructor(options = {}, db) {
		const merged = { path: ":memory:", dir: "sql", ...options };
		this.#db = db ?? SqlRiteCore.openDb(merged);
		if (!db) SqlRiteCore.initDb(this.#db);
		this.#setupChunks(merged);
	}

	/** @param {import("./SqlRiteCore.js").SqlRiteOptions} [options] */
	static async open(options = {}) {
		const merged = { path: ":memory:", dir: "sql", ...options };
		const db = SqlRiteCore.openDb(merged);
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
			if (prep.bigint) stmt.setReadBigInts(true);
			this.#stmts.set(prep.name, stmt);

			this[prep.name] = {
				all: (params = {}) => stmt.all(SqlRiteCore.jsonify(params)),
				get: (params = {}) => stmt.get(SqlRiteCore.jsonify(params)),
				run: (params = {}) => stmt.run(SqlRiteCore.jsonify(params)),
			};
		}
	}

	transaction(calls) {
		this.#db.exec("BEGIN");
		try {
			const results = calls.map(({ name, params, mode = "run" }) => {
				const stmt = this.#stmts.get(name);
				if (!stmt) throw new Error(`SqlRite: no PREP statement named "${name}"`);
				return stmt[mode](SqlRiteCore.jsonify(params));
			});
			this.#db.exec("COMMIT");
			return results;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	close() {
		this.#db.close();
	}

	[Symbol.dispose]() {
		this.close();
	}
}
