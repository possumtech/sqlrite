import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import SqlRiteSync from "./SqlRiteSync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export { SqlRiteSync };

export default class SqlRite {
	#worker = null;
	#id = 0;
	#promises = new Map();
	#readyPromise = Promise.resolve();
	#protected = new Set(["exec", "close", "constructor"]);

	constructor(options = {}) {
		const defaults = {
			path: ":memory:",
			dir: "sql",
		};
		const merged = { ...defaults, ...options };

		this.#worker = new Worker(path.join(__dirname, "SqlWorker.js"), {
			workerData: { options: merged },
		});

		this.#readyPromise = new Promise((resolve) => {
			this.#worker.on("message", (msg) => {
				if (msg.type === "READY") {
					this.#setupMethods(msg.names);
					resolve();
				} else if (msg.id !== undefined) {
					const promise = this.#promises.get(msg.id);
					if (promise) {
						this.#promises.delete(msg.id);
						if (msg.error) promise.reject(new Error(msg.error));
						else promise.resolve(msg.result);
					}
				}
			});
		});

		// Fallback for methods not yet defined or dynamic ones
		return new Proxy(this, {
			get: (target, prop, _receiver) => {
				if (prop in target) {
					const val = target[prop];
					if (typeof val === "function") return val.bind(target);
					return val;
				}
				if (typeof prop === "symbol" || prop === "then") {
					return target[prop];
				}
				// Return a proxy that can handle .all(), .get(), .run() or direct calls
				return new Proxy(() => {}, {
					apply: (_t, _thisArg, args) => {
						return target.#callWorker("EXEC", prop, null, args[0]);
					},
					get: (_t, method) => {
						if (["all", "get", "run"].includes(method)) {
							return (params) =>
								target.#callWorker(`PREP_${method.toUpperCase()}`, prop, null, params);
						}
					},
				});
			},
		});
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
		return this.#callWorker("CLOSE");
	}
}
