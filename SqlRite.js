import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import SqlRiteSync from "./SqlRiteSync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTERNAL = Symbol("SqlRiteInternal");

export { SqlRiteSync };

export default class SqlRite {
	#worker = null;
	#id = 0;
	#promises = new Map();
	#readyPromise = null;
	#protected = new Set(["exec", "close", "constructor", "ready"]);

	constructor(options = {}, token) {
		if (token !== INTERNAL) {
			throw new Error(
				"SqlRite must be initialized using SqlRite.open(options)",
			);
		}

		const defaults = {
			path: ":memory:",
			dir: "sql",
		};
		const merged = { ...defaults, ...options };

		this.#worker = new Worker(path.join(__dirname, "SqlWorker.js"), {
			workerData: { options: merged },
		});

		this.#readyPromise = new Promise((resolve, reject) => {
			this.#worker.on("message", (msg) => {
				if (msg.type === "READY") {
					this.#setupMethods(msg.names);
					resolve(this);
				} else if (msg.id !== undefined) {
					const promise = this.#promises.get(msg.id);
					if (promise) {
						this.#promises.delete(msg.id);
						if (msg.error) promise.reject(new Error(msg.error));
						else promise.resolve(msg.result);
					}
				}
			});

			this.#worker.on("error", (err) => reject(err));
			this.#worker.on("exit", (code) => {
				if (code !== 0) {
					reject(new Error(`Worker stopped with exit code ${code}`));
				}
			});
		});
	}

	/**
	 * Opens a new SqlRite instance and waits for it to be fully initialized.
	 * @param {Object} options
	 * @returns {Promise<SqlRite>}
	 */
	static async open(options) {
		const instance = new SqlRite(options, INTERNAL);
		await instance.ready();
		return instance;
	}

	ready() {
		return this.#readyPromise;
	}

	#setupMethods(names) {
		for (const name of names.EXEC) {
			if (this.#protected.has(name)) continue;
			this[name] = (params) => this.#callWorker("EXEC", name, null, params);
		}
		for (const name of names.PREP) {
			if (this.#protected.has(name)) continue;
			this[name] = {
				all: (params) => this.#callWorker("PREP_ALL", name, null, params),
				get: (params) => this.#callWorker("PREP_GET", name, null, params),
				run: (params) => this.#callWorker("PREP_RUN", name, null, params),
			};
		}
	}

	async #callWorker(type, name, sql, params) {
		await this.#readyPromise;
		return new Promise((resolve, reject) => {
			const id = this.#id++;
			this.#promises.set(id, { resolve, reject });
			this.#worker.postMessage({ id, type, name, sql, params });
		});
	}

	async exec(sql) {
		return this.#callWorker("EXEC", null, sql, null);
	}

	async close() {
		await this.#readyPromise.catch(() => {});
		return this.#callWorker("CLOSE");
	}
}
