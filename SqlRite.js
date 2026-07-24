import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import SqlRiteSync from "./SqlRiteSync.js";

const INTERNAL = Symbol("SqlRiteInternal");

export { SqlRiteSync };

export default class SqlRite {
	/** @type {import("node:worker_threads").Worker} */
	#writer;
	/** @type {import("node:worker_threads").Worker[]} */
	#readers = [];
	#readerCount;
	#readerCursor = 0;
	#id = 0;
	/** @type {Map<number, { type: string, name?: string, params?: unknown, resolve: (value: unknown) => void, reject: (reason?: unknown) => void }>} */
	#promises = new Map();
	/** @type {Map<import("node:worker_threads").Worker, number>} */
	#pending = new Map();
	/** @type {Array<() => void>} */
	#drainResolvers = [];
	/** @type {Promise<SqlRite>} */
	#readyPromise;
	/** @type {Promise<void> | undefined} */
	#closePromise;
	#closing = false;
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
		if (
			merged.readers !== undefined &&
			(!Number.isSafeInteger(merged.readers) || merged.readers < 0)
		) {
			throw new Error("SqlRite: readers must be a non-negative safe integer");
		}
		if (merged.path === ":memory:" && (merged.readers ?? 0) > 0) {
			throw new Error("SqlRite: readers cannot be used with an in-memory database");
		}
		this.#readerCount =
			merged.path === ":memory:" ? 0 : (merged.readers ?? Math.max(0, availableParallelism() - 1));

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
			this.#readers = Array.from({ length: this.#readerCount }, () =>
				this.#createWorker(options, true),
			);
			await Promise.all(this.#readers.map((reader) => this.#workerReady(reader)));
			this.#setupMethods(names);
			return this;
		} catch (error) {
			this.#closed = true;
			await Promise.allSettled(this.#workers().map((worker) => worker.terminate()));
			throw error;
		}
	}

	#workers() {
		return [this.#writer, ...this.#readers];
	}

	#createWorker(options, readOnly) {
		const worker = new Worker(new URL("./SqlWorker.js", import.meta.url), {
			workerData: { options, readOnly },
		});
		this.#pending.set(worker, 0);
		worker.on("message", (msg) => this.#handleMessage(worker, msg));
		worker.on("error", (error) => this.#fail(error));
		worker.on("exit", (code) => {
			if (!this.#closing && !this.#closed) {
				this.#fail(new Error(`Worker stopped with exit code ${code}`));
			}
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
		this.#completeWorkerCall(worker);

		if (msg.retry === true) {
			this.#post(this.#writer, promise);
			return;
		}

		if (msg.error !== undefined) promise.reject(msg.error);
		else promise.resolve(msg.result);
		this.#resolveDrain();
	}

	#completeWorkerCall(worker) {
		const pending = (this.#pending.get(worker) ?? 1) - 1;
		this.#pending.set(worker, pending);
		if (pending === 0) worker.unref();
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
		this.#resolveDrain();
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
				all: (params) => this.#callWorker(this.#selectReader(), "PREP_ALL", name, params),
				get: (params) => this.#callWorker(this.#selectReader(), "PREP_GET", name, params),
				run: (params) => this.#callWorker(this.#writer, "PREP_RUN", name, params),
			};
		}
	}

	#selectReader() {
		if (this.#readers.length === 0) return this.#writer;

		let selected = this.#readerCursor;
		let leastPending = Number.POSITIVE_INFINITY;
		for (let offset = 0; offset < this.#readers.length; offset++) {
			const index = (this.#readerCursor + offset) % this.#readers.length;
			const pending = this.#pending.get(this.#readers[index]) ?? 0;
			if (pending < leastPending) {
				selected = index;
				leastPending = pending;
			}
		}
		this.#readerCursor = (selected + 1) % this.#readers.length;
		return this.#readers[selected];
	}

	#send(worker, type, name, params) {
		const { promise, resolve, reject } = Promise.withResolvers();
		this.#post(worker, { type, name, params, resolve, reject });
		return promise;
	}

	#post(worker, call) {
		const id = this.#id++;
		const pending = this.#pending.get(worker) ?? 0;
		if (pending === 0) worker.ref();
		this.#pending.set(worker, pending + 1);
		this.#promises.set(id, call);
		worker.postMessage({ id, type: call.type, name: call.name, params: call.params });
	}

	async #callWorker(worker, type, name, params) {
		if (this.#closing || this.#closed) throw new Error("SqlRite instance is closed");
		await this.#readyPromise;
		return this.#send(worker, type, name, params);
	}

	#drain() {
		if (this.#promises.size === 0) return Promise.resolve();
		return new Promise((resolve) => this.#drainResolvers.push(() => resolve(undefined)));
	}

	#resolveDrain() {
		if (this.#promises.size !== 0) return;
		for (const resolve of this.#drainResolvers) resolve();
		this.#drainResolvers = [];
	}

	close() {
		if (this.#closePromise) return this.#closePromise;
		this.#closing = true;
		this.#closePromise = this.#close();
		return this.#closePromise;
	}

	async #close() {
		await this.#readyPromise.catch(() => {});
		await this.#drain();
		if (this.#closed) return;
		await Promise.all(this.#workers().map((worker) => this.#send(worker, "CLOSE")));
		this.#closed = true;
	}

	async [Symbol.asyncDispose]() {
		await this.close();
	}
}
