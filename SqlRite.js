import { Worker } from "node:worker_threads";
import SqlRiteSync from "./SqlRiteSync.js";

const INTERNAL = Symbol("SqlRiteInternal");

export { SqlRiteSync };

export default class SqlRite {
	#worker = null;
	#id = 0;
	#promises = new Map();
	#readyPromise = null;
	#closed = false;
	#protected = new Set(["close", "constructor", "ready"]);

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

	#handleMessage(msg) {
		if (msg.id === undefined) return;
		const promise = this.#promises.get(msg.id);
		if (!promise) return;
		this.#promises.delete(msg.id);
		if (msg.error) promise.reject(new Error(msg.error));
		else promise.resolve(msg.result);
	}

	#rejectAll(err) {
		for (const [, promise] of this.#promises) {
			promise.reject(err);
		}
		this.#promises.clear();
		this.#closed = true;
	}

	#setupMethods(names) {
		for (const name of names.EXEC) {
			if (this.#protected.has(name)) continue;
			this[name] = () => this.#callWorker("EXEC", name);
		}
		for (const name of names.PREP) {
			if (this.#protected.has(name)) continue;
			this[name] = {
				all: (params) => this.#callWorker("PREP_ALL", name, params),
				get: (params) => this.#callWorker("PREP_GET", name, params),
				run: (params) => this.#callWorker("PREP_RUN", name, params),
			};
		}
	}

	async #callWorker(type, name, params) {
		if (this.#closed) throw new Error("SqlRite instance is closed");
		await this.#readyPromise;
		const { promise, resolve, reject } = Promise.withResolvers();
		const id = this.#id++;
		this.#promises.set(id, { resolve, reject });
		this.#worker.postMessage({ id, type, name, params });
		return promise;
	}

	async close() {
		if (this.#closed) return;
		this.#closed = true;
		await this.#readyPromise.catch(() => {});
		const { promise, resolve, reject } = Promise.withResolvers();
		const id = this.#id++;
		this.#promises.set(id, { resolve, reject });
		this.#worker.postMessage({ id, type: "CLOSE" });
		return promise;
	}

	async [Symbol.asyncDispose]() {
		await this.close();
	}
}
