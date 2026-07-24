import { Worker } from "node:worker_threads";
import SqlRiteSync from "./SqlRiteSync.js";

const INTERNAL = Symbol("SqlRiteInternal");

export { SqlRiteSync };

export default class SqlRite {
	/** @type {import("node:worker_threads").Worker} */
	#writer;
	/** @type {import("node:worker_threads").Worker | undefined} */
	#reader;
	#id = 0;
	/** @type {Map<number, { worker: import("node:worker_threads").Worker, resolve: (value: unknown) => void, reject: (reason?: unknown) => void }>} */
	#promises = new Map();
	/** @type {Map<import("node:worker_threads").Worker, number>} */
	#pending = new Map();
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

		this.#writer = this.#createWorker(merged, false);
		this.#readyPromise = this.#initialize(merged);
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

	async #initialize(options) {
		try {
			const names = await this.#workerReady(this.#writer);
			if (options.path !== ":memory:") {
				this.#reader = this.#createWorker(options, true);
				await this.#workerReady(this.#reader);
			}
			this.#setupMethods(names);
			return this;
		} catch (error) {
			this.#closed = true;
			await Promise.allSettled(this.#workers().map((worker) => worker.terminate()));
			throw error;
		}
	}

	#workers() {
		return this.#reader ? [this.#writer, this.#reader] : [this.#writer];
	}

	#createWorker(options, readOnly) {
		const worker = new Worker(new URL("./SqlWorker.js", import.meta.url), {
			workerData: { options, readOnly },
		});
		this.#pending.set(worker, 0);
		worker.on("message", (msg) => this.#handleMessage(worker, msg));
		worker.on("error", (error) => this.#fail(error));
		worker.on("exit", (code) => {
			if (!this.#closed) this.#fail(new Error(`Worker stopped with exit code ${code}`));
		});
		return worker;
	}

	#workerReady(worker) {
		return new Promise((resolve, reject) => {
			const onMessage = (msg) => {
				if (msg.type !== "READY") return;
				cleanup();
				worker.unref();
				resolve(msg.names);
			};
			const onError = (error) => {
				cleanup();
				reject(error);
			};
			const onExit = (code) => {
				cleanup();
				reject(new Error(`Worker stopped with exit code ${code}`));
			};
			const cleanup = () => {
				worker.off("message", onMessage);
				worker.off("error", onError);
				worker.off("exit", onExit);
			};
			worker.on("message", onMessage);
			worker.once("error", onError);
			worker.once("exit", onExit);
		});
	}

	#handleMessage(worker, msg) {
		if (msg.id === undefined) return;
		const promise = this.#promises.get(msg.id);
		if (!promise) return;
		this.#promises.delete(msg.id);
		const pending = (this.#pending.get(worker) ?? 1) - 1;
		this.#pending.set(worker, pending);
		if (pending === 0) worker.unref();
		if (msg.error !== undefined) promise.reject(msg.error);
		else promise.resolve(msg.result);
	}

	#rejectAll(err) {
		for (const promise of this.#promises.values()) {
			promise.reject(err);
		}
		this.#promises.clear();
		for (const worker of this.#pending.keys()) {
			this.#pending.set(worker, 0);
			worker.unref();
		}
	}

	#fail(error) {
		if (this.#closed) return;
		this.#closed = true;
		this.#rejectAll(error);
		for (const worker of this.#pending.keys()) worker.terminate();
	}

	#setupMethods(names) {
		for (const name of names.EXEC) {
			this[name] = (params) => this.#callWorker(this.#writer, "EXEC", name, params);
		}
		for (const name of names.TX) {
			this[name] = (params) => this.#callWorker(this.#writer, "TX", name, params);
		}
		for (const name of names.PREP) {
			this[name] = {
				all: (params) => this.#callWorker(this.#reader ?? this.#writer, "PREP_ALL", name, params),
				get: (params) => this.#callWorker(this.#reader ?? this.#writer, "PREP_GET", name, params),
				run: (params) => this.#callWorker(this.#writer, "PREP_RUN", name, params),
			};
		}
	}

	#send(worker, type, name, params) {
		const { promise, resolve, reject } = Promise.withResolvers();
		const id = this.#id++;
		const pending = this.#pending.get(worker) ?? 0;
		if (pending === 0) worker.ref();
		this.#pending.set(worker, pending + 1);
		this.#promises.set(id, { worker, resolve, reject });
		worker.postMessage({ id, type, name, params });
		return promise;
	}

	async #callWorker(worker, type, name, params) {
		if (this.#closed) throw new Error("SqlRite instance is closed");
		await this.#readyPromise;
		return this.#send(worker, type, name, params);
	}

	async close() {
		if (this.#closed) return;
		this.#closed = true;
		await this.#readyPromise.catch(() => {});
		await Promise.all(this.#workers().map((worker) => this.#send(worker, "CLOSE")));
	}

	async [Symbol.asyncDispose]() {
		await this.close();
	}
}
