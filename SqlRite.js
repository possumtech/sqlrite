import { Worker } from "node:worker_threads";
import SqlRiteSync from "./SqlRiteSync.js";

const INTERNAL = Symbol("SqlRiteInternal");

export { SqlRiteSync };

export default class SqlRite {
	/** @type {import("node:worker_threads").Worker} */
	#worker;
	#id = 0;
	/** @type {Map<number, { resolve: (value: unknown) => void, reject: (reason?: unknown) => void }>} */
	#promises = new Map();
	/** @type {Promise<SqlRite>} */
	#readyPromise;
	#closed = false;

	/**
	 * @param {import("./SqlRiteCore.js").SqlRiteOptions} [options]
	 * @param {symbol} [token]
	 */
	constructor(options = {}, token) {
		if (token !== INTERNAL) {
			throw new Error("SqlRite must be initialized using SqlRite.open(options)");
		}

		const defaults = {
			path: ":memory:",
			dir: "sql",
		};
		const merged = { ...defaults, ...options };

		this.#worker = new Worker(new URL("./SqlWorker.js", import.meta.url), {
			workerData: { options: merged },
		});

		this.#readyPromise = new Promise((resolve, reject) => {
			this.#worker.once("message", (msg) => {
				if (msg.type === "READY") {
					this.#setupMethods(msg.names);
					this.#worker.on("message", (msg) => this.#handleMessage(msg));
					// An idle instance must not hold the process open (#8): unref while
					// no call is in flight; #send refs for each round-trip's duration.
					this.#worker.unref();
					resolve(this);
				}
			});

			this.#worker.on("error", (err) => {
				this.#rejectAll(err);
				reject(err);
			});
			this.#worker.on("exit", (code) => {
				if (code !== 0) {
					const err = new Error(`Worker stopped with exit code ${code}`);
					this.#rejectAll(err);
					reject(err);
				}
			});
		});
	}

	/**
	 * Opens a new SqlRite instance and waits for it to be fully initialized.
	 * @param {import("./SqlRiteCore.js").SqlRiteOptions} [options]
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

	#handleMessage(msg) {
		if (msg.id === undefined) return;
		const promise = this.#promises.get(msg.id);
		if (!promise) return;
		this.#promises.delete(msg.id);
		if (this.#promises.size === 0) this.#worker.unref();
		if (msg.error !== undefined) promise.reject(msg.error);
		else promise.resolve(msg.result);
	}

	#rejectAll(err) {
		for (const promise of this.#promises.values()) {
			promise.reject(err);
		}
		this.#promises.clear();
		this.#closed = true;
	}

	#setupMethods(names) {
		for (const name of names.EXEC) {
			this[name] = (params) => this.#callWorker("EXEC", name, params);
		}
		for (const name of names.TX) {
			this[name] = (params) => this.#callWorker("TX", name, params);
		}
		for (const name of names.PREP) {
			this[name] = {
				all: (params) => this.#callWorker("PREP_ALL", name, params),
				get: (params) => this.#callWorker("PREP_GET", name, params),
				run: (params) => this.#callWorker("PREP_RUN", name, params),
			};
		}
	}

	#send(type, name, params) {
		const { promise, resolve, reject } = Promise.withResolvers();
		const id = this.#id++;
		if (this.#promises.size === 0) this.#worker.ref();
		this.#promises.set(id, { resolve, reject });
		this.#worker.postMessage({ id, type, name, params });
		return promise;
	}

	async #callWorker(type, name, params) {
		if (this.#closed) throw new Error("SqlRite instance is closed");
		await this.#readyPromise;
		return this.#send(type, name, params);
	}

	async close() {
		if (this.#closed) return;
		this.#closed = true;
		await this.#readyPromise.catch(() => {});
		return this.#send("CLOSE");
	}

	async [Symbol.asyncDispose]() {
		await this.close();
	}
}
