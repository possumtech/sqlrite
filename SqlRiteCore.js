import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export default class SqlRiteCore {
	static #CHUNK_REGEX = /^--\s*(INIT|EXEC|PREP):\s*(\w+)/gim;
	static #REGEX_INDICATORS = /[+(){}|\\$]/;

	static initDb(db) {
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec("PRAGMA synchronous = NORMAL;");
		db.exec("PRAGMA foreign_keys = ON;");
		db.exec("PRAGMA dml_strict = ON;");

		if (!SqlRiteCore.#hasFunction(db, "'x' REGEXP 'x'")) {
			const regexCache = new Map();
			db.function("regexp", { deterministic: true }, (pattern, string) => {
				if (string === null) return 0;
				let re = regexCache.get(pattern);
				if (!re) {
					re = new RegExp(pattern);
					regexCache.set(pattern, re);
				}
				return re.test(string) ? 1 : 0;
			});
		}

		if (!SqlRiteCore.#hasFunction(db, "uuid()")) {
			db.function("uuid", () => crypto.randomUUID());
		}

		const glorpCache = new Map();
		db.function("glorp", { deterministic: true }, (pattern, string) => {
			if (string === null) return 0;
			let re = glorpCache.get(pattern);
			if (!re) {
				const src = SqlRiteCore.#REGEX_INDICATORS.test(pattern)
					? pattern
					: SqlRiteCore.#globToRegex(pattern);
				re = new RegExp(src);
				glorpCache.set(pattern, re);
			}
			return re.test(string) ? 1 : 0;
		});
	}

	static async registerFunctions(db, functions) {
		if (!functions) return;
		const paths = Array.isArray(functions) ? functions : [functions];

		for (const funcPath of paths) {
			const resolved = path.resolve(funcPath);
			const mod = await import(resolved);
			const handler = mod.default;
			if (typeof handler !== "function") {
				throw new Error(`SqlRite: ${funcPath} must have a default export that is a function`);
			}
			const name = path.basename(resolved, path.extname(resolved));
			const opts = {};
			if (mod.deterministic) opts.deterministic = true;
			db.function(name, opts, handler);
		}
	}

	static #globToRegex(glob) {
		let result = "^";
		for (let i = 0; i < glob.length; i++) {
			const c = glob[i];
			if (c === "*") result += ".*";
			else if (c === "?") result += ".";
			else if (c === "[") {
				const close = glob.indexOf("]", i + 1);
				if (close === -1) {
					result += "\\[";
					continue;
				}
				result += glob.slice(i, close + 1);
				i = close;
			} else if (/[.+^${}()|\\]/.test(c)) {
				result += `\\${c}`;
			} else result += c;
		}
		return `${result}$`;
	}

	static #hasFunction(db, expr) {
		try {
			db.prepare(`SELECT ${expr}`);
			return true;
		} catch {
			return false;
		}
	}

	static loadChunks(options) {
		const dirs = Array.isArray(options.dir) ? options.dir : [options.dir];
		const files = dirs.flatMap((d) => SqlRiteCore.getFiles(d));
		return SqlRiteCore.parseSql(files);
	}

	static getFiles(dir) {
		return fs
			.readdirSync(dir, { withFileTypes: true, recursive: true })
			.filter((f) => f.isFile() && f.name.endsWith(".sql"))
			.map((f) => path.join(f.parentPath, f.name))
			.toSorted((a, b) =>
				path.basename(a).localeCompare(path.basename(b), undefined, {
					numeric: true,
					sensitivity: "base",
				}),
			);
	}

	static parseSql(files) {
		const chunks = { INIT: [], EXEC: [], PREP: [] };
		const seen = new Map();

		for (const file of files) {
			const content = fs.readFileSync(file, "utf8");
			const matches = [...content.matchAll(SqlRiteCore.#CHUNK_REGEX)];

			for (let i = 0; i < matches.length; i++) {
				const match = matches[i];
				const type = match[1].toUpperCase();
				const name = match[2];
				const start = match.index + match[0].length;
				const end = matches[i + 1]?.index ?? content.length;

				const sql = content.slice(start, end).trim();
				if (!sql) continue;

				if (type !== "INIT" && seen.has(name)) {
					const prev = seen.get(name);
					console.warn(
						`SqlRite: duplicate name "${name}" (${type} in ${file}) overwrites (${prev.type} in ${prev.file})`,
					);
				}
				if (type !== "INIT") {
					seen.set(name, { type, file });
				}

				chunks[type].push({ type, name, sql });
			}
		}

		return chunks;
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
