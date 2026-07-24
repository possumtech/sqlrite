import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * @typedef {object} SqlRiteOptions
 * @property {string} [path] Database file path (default ":memory:").
 * @property {string|string[]} [dir] Directory or directories scanned for .sql files.
 * @property {string|string[]} [functions] Module path(s) for custom SQL functions.
 * @property {Record<string, string|number|boolean|null>} [params] $var substitutions for INIT blocks.
 * @property {number} [readers] Async file-backed read Workers; defaults to max(0, availableParallelism() - 1).
 * @property {number} [timeout] busy_timeout in ms (default 5000); 0 restores immediate SQLITE_BUSY.
 * @property {number} [cacheSize] cache_size: positive = pages, negative = KiB of memory.
 * @property {number} [mmapSize] mmap_size: bytes of memory-mapped I/O; 0 disables. Inert on :memory:.
 * @property {number} [maxPageCount] max_page_count: hard db-size ceiling in pages.
 */

/**
 * @typedef {object} Chunk
 * @property {string} type INIT, EXEC, TX, PREP, or MIGRATE.
 * @property {string} name Tag name.
 * @property {string} sql Block body.
 * @property {boolean} [bigint] PREP only: read integer columns as BigInt.
 * @property {number} [version] MIGRATE only: schema version recorded in user_version.
 */

/** @typedef {Chunk & { version: number }} Migration */

/** @typedef {{ INIT: Chunk[], EXEC: Chunk[], TX: Chunk[], PREP: Chunk[], MIGRATE: Migration[] }} Chunks */

/** @typedef {{ changes: number|bigint, lastInsertRowid: number|bigint }} SqlRiteResult */

export default class SqlRiteCore {
	// Captures: 1=type, 2=name, 3=trailing flags (rest of the tag line, e.g. "bigint";
	// for MIGRATE a cosmetic label). MIGRATE names are versions: digits only.
	static #CHUNK_REGEX = /^--\s*(INIT|EXEC|TX|PREP|MIGRATE):\s*(\w+)(.*)$/gim;

	// Connection-scoped write metadata. Read via setReadBigInts so a rowid past 2^53 is lossless.
	static #META_SQL = "SELECT last_insert_rowid() AS lastInsertRowid, changes() AS changes";

	// Names that can never become methods on either facade.
	static #RESERVED = new Set(["constructor", "close", "open", "ready"]);

	// One left-to-right pass consuming string literals, quoted identifiers, and
	// comments, so a quote inside a comment (or -- inside a string) can't derail
	// the strip. What survives is scanned for parameter-shaped tokens.
	static #UNQUOTE_REGEX = /'(?:[^']|'')*'|"[^"]*"|--[^\n]*|\/\*[\s\S]*?\*\//g;

	// Optional inline-flag prefix for REGEXP, e.g. `(?i)foo`. A native scoped group
	// `(?i:...)` has a trailing colon, so it won't match here and passes through untouched.
	static #REGEXP_FLAG_PREFIX = /^\(\?([a-z]+)\)/;

	// LRU bound for the per-connection REGEXP cache: authored patterns are few, but
	// `col REGEXP other_col` feeds arbitrary runtime strings — unbounded, that leaks.
	static #REGEXP_CACHE_MAX = 256;

	// Connection posture. Spread under user options, so callers can override any of these.
	static #HARDENED = Object.freeze({
		enableForeignKeyConstraints: true, // enforce relational constraints
		enableDoubleQuotedStringLiterals: false, // reject the DQS misfeature (a typo'd identifier becomes a string)
		defensive: true, // block schema/page self-corruption (writable_schema, journal_mode=OFF, shadow tables)
	});

	// Curated, overridable tuning knobs → integer-validated PRAGMA. PRAGMA can't bind params, but
	// each value is a validated safe integer, so interpolation is injection-free. Fail-hard on bad input.
	static #TUNING = Object.freeze([
		{
			option: "cacheSize",
			pragma: "cache_size",
			ok: (v) => Number.isSafeInteger(v),
			want: "a safe integer",
		},
		{
			option: "mmapSize",
			pragma: "mmap_size",
			ok: (v) => Number.isSafeInteger(v) && v >= 0,
			want: "a non-negative safe integer",
		},
		{
			option: "maxPageCount",
			pragma: "max_page_count",
			ok: (v) => Number.isSafeInteger(v) && v > 0,
			want: "a positive safe integer",
		},
	]);

	/**
	 * @param {SqlRiteOptions & { path: string }} options
	 * @returns {DatabaseSync}
	 */
	static openDb(options) {
		// timeout (busy_timeout, ms): non-zero default so concurrent writers wait instead of an
		// immediate SQLITE_BUSY, completing the WAL posture. Native option; overridable by the user.
		return new DatabaseSync(options.path, { timeout: 5000, ...SqlRiteCore.#HARDENED, ...options });
	}

	/**
	 * @param {DatabaseSync} db
	 * @param {SqlRiteOptions} [options]
	 */
	static initDb(db, options = {}) {
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec("PRAGMA synchronous = NORMAL;");

		for (const { option, pragma, ok, want } of SqlRiteCore.#TUNING) {
			const value = options[option];
			if (value === undefined) continue;
			if (!ok(value)) throw new Error(`SqlRite: ${option} must be ${want}`);
			db.exec(`PRAGMA ${pragma} = ${value};`);
		}

		if (!SqlRiteCore.#hasFunction(db, "'x' REGEXP 'x'")) {
			const regexCache = new Map();
			db.function("regexp", { deterministic: true }, (pattern, string) => {
				// SQL three-valued logic: a NULL pattern or subject yields NULL, never a match.
				if (pattern === null || string === null) return null;
				const key = String(pattern);
				let re = regexCache.get(key);
				if (re) {
					regexCache.delete(key); // LRU: re-insertion below refreshes recency
				} else {
					re = SqlRiteCore.#compileRegExp(key);
					if (regexCache.size >= SqlRiteCore.#REGEXP_CACHE_MAX) {
						regexCache.delete(regexCache.keys().next().value);
					}
				}
				regexCache.set(key, re);
				// REGEXP is boolean over a cached, reused RegExp, so neutralize the stateful
				// flags each row: `g` becomes a no-op and `y` (sticky) anchors at the start.
				re.lastIndex = 0;
				return re.test(String(string)) ? 1 : 0;
			});
		}

		if (!SqlRiteCore.#hasFunction(db, "uuid()")) {
			db.function("uuid", () => crypto.randomUUID());
		}
	}

	static async registerFunctions(db, functions) {
		if (!functions) return;
		const paths = Array.isArray(functions) ? functions : [functions];

		for (const funcPath of paths) {
			const resolved = resolve(funcPath);
			const mod = await import(resolved);
			const handler = mod.default;
			if (typeof handler !== "function") {
				throw new Error(`SqlRite: ${funcPath} must have a default export that is a function`);
			}
			const name = basename(resolved, extname(resolved));
			const opts = {};
			if (mod.deterministic) opts.deterministic = true;
			db.function(name, opts, handler);
		}
	}

	static #hasFunction(db, expr) {
		try {
			db.prepare(`SELECT ${expr}`);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Compile a REGEXP pattern, honoring an optional leading `(?flags)` prefix.
	 * Invalid flags throw via the RegExp constructor; stateful flags are tamed at call time.
	 * @param {string} pattern
	 * @returns {RegExp}
	 */
	static #compileRegExp(pattern) {
		const match = SqlRiteCore.#REGEXP_FLAG_PREFIX.exec(pattern);
		const flags = match ? match[1] : "";
		return new RegExp(match ? pattern.slice(match[0].length) : pattern, flags);
	}

	/**
	 * @param {SqlRiteOptions} options
	 * @returns {Chunks}
	 */
	static loadChunks(options) {
		const dirs = Array.isArray(options.dir) ? options.dir : [options.dir];
		const files = dirs.flatMap((d) => SqlRiteCore.getFiles(d));
		return SqlRiteCore.parseSql(files);
	}

	static getFiles(dir) {
		return readdirSync(dir, { withFileTypes: true, recursive: true })
			.filter((f) => f.isFile() && f.name.endsWith(".sql"))
			.map((f) => join(f.parentPath, f.name))
			.toSorted((a, b) =>
				basename(a).localeCompare(basename(b), undefined, {
					numeric: true,
					sensitivity: "base",
				}),
			);
	}

	/**
	 * @param {string[]} files
	 * @returns {Chunks}
	 */
	static parseSql(files) {
		/** @type {Chunks} */
		const chunks = { INIT: [], EXEC: [], TX: [], PREP: [], MIGRATE: [] };
		/** @type {Map<string, { type: string, file: string }>} */
		const seen = new Map();
		/** @type {Map<number, string>} */
		const versions = new Map();

		for (const file of files) {
			const content = readFileSync(file, "utf8");
			const matches = [...content.matchAll(SqlRiteCore.#CHUNK_REGEX)];

			for (let i = 0; i < matches.length; i++) {
				const match = matches[i];
				const type = match[1].toUpperCase();
				const name = match[2];
				const bigint = /\bbigint\b/i.test(match[3]);
				const start = match.index + match[0].length;
				const end = matches[i + 1]?.index ?? content.length;

				const sql = content.slice(start, end).trim();
				if (!sql) continue;

				if (type === "MIGRATE") {
					if (!/^\d+$/.test(name) || Number(name) < 1) {
						throw new Error(
							`SqlRite: MIGRATE version must be a positive integer, got "${name}" (${file})`,
						);
					}
					const version = Number(name);
					const prevFile = versions.get(version);
					if (prevFile) {
						throw new Error(
							`SqlRite: duplicate MIGRATE version ${version} (${file}, already in ${prevFile})`,
						);
					}
					versions.set(version, file);
					chunks.MIGRATE.push({ type, name, sql, version });
					continue;
				}

				if (type !== "INIT" && SqlRiteCore.#RESERVED.has(name)) {
					throw new Error(`SqlRite: "${name}" is a reserved name (${type} in ${file})`);
				}

				const prev = type !== "INIT" ? seen.get(name) : undefined;
				if (prev) {
					console.warn(
						`SqlRite: duplicate name "${name}" (${type} in ${file}) overwrites (${prev.type} in ${prev.file})`,
					);
				}
				if (type !== "INIT") {
					seen.set(name, { type, file });
				}

				chunks[type].push({ type, name, sql, bigint });
			}
		}

		return chunks;
	}

	/**
	 * Apply pending -- MIGRATE chunks: every version above the database's
	 * PRAGMA user_version, ascending, each atomically with its version bump.
	 * Zero writes when the database is current, so readOnly connections open.
	 * @param {DatabaseSync} db
	 * @param {Migration[]} migrations
	 */
	static applyMigrations(db, migrations) {
		if (migrations.length === 0) return;
		const read = db.prepare("PRAGMA user_version");
		const current = /** @type {any} */ (read.get()).user_version;
		const pending = migrations
			.filter((m) => m.version > current)
			.toSorted((a, b) => a.version - b.version);

		for (const m of pending) {
			SqlRiteCore.#assertBound(m.sql, `MIGRATE ${m.version}`);
			db.exec("BEGIN IMMEDIATE");
			try {
				// Re-check under the write lock: a concurrent opener may have won the race.
				if (/** @type {any} */ (read.get()).user_version >= m.version) {
					db.exec("COMMIT");
					continue;
				}
				db.exec(m.sql);
				// user_version lives in the header page: the bump commits or rolls back
				// with the body. The version is a validated integer — injection-free.
				db.exec(`PRAGMA user_version = ${m.version}`);
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}
	}

	/**
	 * @param {string} sql
	 * @param {Record<string, unknown>} [params]
	 * @param {string} [context] Block identity for error messages.
	 */
	static template(sql, params, context = "SQL block") {
		const templated = !params
			? sql
			: sql.replace(/\$(\w+)/g, (match, key) => {
					if (!(key in params)) return match;
					const value = params[key];
					if (value === null) return "NULL";
					if (typeof value === "number") return String(value);
					if (typeof value === "boolean") return value ? "1" : "0";
					return `'${String(value).replaceAll("'", "''")}'`;
				});
		SqlRiteCore.#assertBound(templated, context);
		return templated;
	}

	/**
	 * db.exec silently binds an unresolved parameter token as NULL — quiet data
	 * loss. After templating, any parameter-shaped token outside string
	 * literals, quoted identifiers, and comments is a fail-hard error. The
	 * lookbehind spares identifiers containing $ (legal in SQLite: a$b).
	 * @param {string} sql
	 * @param {string} context
	 */
	static #assertBound(sql, context) {
		const bare = sql.replace(SqlRiteCore.#UNQUOTE_REGEX, "");
		const token = bare.match(/(?<!\w)[$:@]\w+/);
		if (token) throw new Error(`SqlRite: unbound parameter ${token[0]} in ${context}`);
	}

	/**
	 * @param {import("node:sqlite").DatabaseSync} db
	 * @param {boolean} bigint Read the metadata integers as BigInt (lossless past 2^53).
	 * @returns {import("node:sqlite").StatementSync}
	 */
	static prepareMeta(db, bigint) {
		const stmt = db.prepare(SqlRiteCore.#META_SQL);
		if (bigint) stmt.setReadBigInts(true);
		return stmt;
	}

	/**
	 * @param {import("node:sqlite").StatementSync} metaStmt
	 * @returns {SqlRiteResult}
	 */
	static result(metaStmt) {
		const { changes, lastInsertRowid } = /** @type {any} */ (metaStmt.get());
		return { changes, lastInsertRowid };
	}

	static jsonify(params) {
		if (!params) return {};
		const result = {};

		for (const [key, value] of Object.entries(params)) {
			const cleanKey = key.replace(/^[$:@]/, "");
			result[cleanKey] = SqlRiteCore.#bindable(value, cleanKey);
		}
		return result;
	}

	/**
	 * node:sqlite binds null, numbers, bigints, strings, and TypedArrays;
	 * anything else dies there with a generic "cannot be bound". Convert what
	 * has one honest SQL shape (boolean → 1/0, plain object/array → JSON) and
	 * fail-hard, naming the parameter, on what doesn't.
	 * @param {unknown} value
	 * @param {string} key
	 */
	static #bindable(value, key) {
		if (value === null) return null;
		const type = typeof value;
		if (type === "string" || type === "number" || type === "bigint") return value;
		if (type === "boolean") return value ? 1 : 0;
		if (type === "object") {
			if (ArrayBuffer.isView(value)) return value;
			const proto = Object.getPrototypeOf(value);
			if (Array.isArray(value) || proto === Object.prototype || proto === null) {
				return JSON.stringify(value);
			}
		}
		throw new Error(
			`SqlRite: unsupported parameter type ${value?.constructor?.name ?? type} for $${key}`,
		);
	}
}
