import SqlRiteCore from "./SqlRiteCore.js";

export default class SqlRiteSync {
	/** @type {import("node:sqlite").DatabaseSync} */
	#db;
	/** @type {import("node:sqlite").StatementSync} */
	#metaNum;
	/** @type {import("node:sqlite").StatementSync} */
	#metaBig;
	#protected = new Set(["close", "open", "constructor"]);

	/**
	 * @param {import("./SqlRiteCore.js").SqlRiteOptions} [options]
	 * @param {import("node:sqlite").DatabaseSync} [db]
	 */
	constructor(options = {}, db) {
		const merged = { path: ":memory:", dir: "sql", ...options };
		this.#db = db ?? SqlRiteCore.openDb(merged);
		if (!db) SqlRiteCore.initDb(this.#db, merged);
		this.#metaNum = SqlRiteCore.prepareMeta(this.#db, false);
		this.#metaBig = SqlRiteCore.prepareMeta(this.#db, true);
		this.#setupChunks(merged);
	}

	/** @param {import("./SqlRiteCore.js").SqlRiteOptions} [options] */
	static async open(options = {}) {
		const merged = { path: ":memory:", dir: "sql", ...options };
		const db = SqlRiteCore.openDb(merged);
		SqlRiteCore.initDb(db, merged);
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
			const meta = exec.bigint ? this.#metaBig : this.#metaNum;
			this[exec.name] = (params) => {
				this.#db.exec(SqlRiteCore.template(exec.sql, params));
				return SqlRiteCore.result(meta);
			};
		}

		for (const tx of chunks.TX) {
			if (this.#protected.has(tx.name)) continue;
			const meta = tx.bigint ? this.#metaBig : this.#metaNum;
			this[tx.name] = (params) => {
				this.#db.exec("BEGIN");
				try {
					this.#db.exec(SqlRiteCore.template(tx.sql, params));
					this.#db.exec("COMMIT");
				} catch (error) {
					this.#db.exec("ROLLBACK");
					throw error;
				}
				return SqlRiteCore.result(meta);
			};
		}

		for (const prep of chunks.PREP) {
			if (this.#protected.has(prep.name)) continue;
			const stmt = this.#db.prepare(prep.sql);
			if (prep.bigint) stmt.setReadBigInts(true);
			const meta = prep.bigint ? this.#metaBig : this.#metaNum;

			this[prep.name] = {
				all: (params = {}) => stmt.all(SqlRiteCore.jsonify(params)),
				get: (params = {}) => stmt.get(SqlRiteCore.jsonify(params)),
				run: (params = {}) => {
					stmt.run(SqlRiteCore.jsonify(params));
					return SqlRiteCore.result(meta);
				},
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
