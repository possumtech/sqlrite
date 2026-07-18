import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * @typedef {object} SqlRiteOptions
 * @property {string} [path] Database file path (default ":memory:").
 * @property {string|string[]} [dir] Directory or directories scanned for .sql files.
 * @property {string|string[]} [functions] Module path(s) for custom SQL functions.
 * @property {Record<string, string|number|boolean|null>} [params] $var substitutions for INIT blocks.
 * @property {number} [timeout] busy_timeout in ms (default 5000); 0 restores immediate SQLITE_BUSY.
 * @property {number} [cacheSize] cache_size: positive = pages, negative = KiB of memory.
 * @property {number} [mmapSize] mmap_size: bytes of memory-mapped I/O; 0 disables. Inert on :memory:.
 * @property {number} [maxPageCount] max_page_count: hard db-size ceiling in pages.
 */

/**
 * @typedef {object} Chunk
 * @property {string} type INIT, EXEC, TX, or PREP.
 * @property {string} name Tag name.
 * @property {string} sql Block body.
 * @property {boolean} [bigint] PREP only: read integer columns as BigInt.
 */

/** @typedef {{ INIT: Chunk[], EXEC: Chunk[], TX: Chunk[], PREP: Chunk[] }} Chunks */

/** @typedef {{ changes: number|bigint, lastInsertRowid: number|bigint }} SqlRiteResult */

export default class SqlRiteCore {
	// Captures: 1=type, 2=name, 3=trailing flags (rest of the tag line, e.g. "bigint").
	static #CHUNK_REGEX = /^--\s*(INIT|EXEC|TX|PREP):\s*(\w+)(.*)$/gim;

	// Connection-scoped write metadata. Read via setReadBigInts so a rowid past 2^53 is lossless.
	static #META_SQL = "SELECT last_insert_rowid() AS lastInsertRowid, changes() AS changes";

	// Optional inline-flag prefix for REGEXP, e.g. `(?i)foo`. A native scoped group
	// `(?i:...)` has a trailing colon, so it won't match here and passes through untouched.
	static #REGEXP_FLAG_PREFIX = /^\(\?([a-z]+)\)/;

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
				if (!re) {
					re = SqlRiteCore.#compileRegExp(key);
					regexCache.set(key, re);
				}
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
		const chunks = { INIT: [], EXEC: [], TX: [], PREP: [] };
		/** @type {Map<string, { type: string, file: string }>} */
		const seen = new Map();

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

	static template(sql, params) {
		if (!params) return sql;
		return sql.replace(/\$(\w+)/g, (match, key) => {
			if (!(key in params)) return match;
			const value = params[key];
			if (value === null) return "NULL";
			if (typeof value === "number") return String(value);
			if (typeof value === "boolean") return value ? "1" : "0";
			return `'${String(value).replaceAll("'", "''")}'`;
		});
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
			if (
				Array.isArray(value) ||
				(value !== null && typeof value === "object" && value.constructor?.name === "Object")
			) {
				result[cleanKey] = JSON.stringify(value);
			} else {
				result[cleanKey] = value;
			}
		}
		return result;
	}
}
