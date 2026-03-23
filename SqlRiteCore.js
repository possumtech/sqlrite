import fs from "node:fs";
import path from "node:path";

export default class SqlRiteCore {
	static #CHUNK_REGEX = /^--\s*(INIT|EXEC|PREP):\s*(\w+)/gim;

	static initDb(db) {
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec("PRAGMA synchronous = NORMAL;");
		db.exec("PRAGMA foreign_keys = ON;");
		db.exec("PRAGMA dml_strict = ON;");
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
