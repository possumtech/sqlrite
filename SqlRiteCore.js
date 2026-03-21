import fs from "node:fs";
import path from "node:path";

export default class SqlRiteCore {
	static #CHUNK_REGEX = /^--\s*(INIT|EXEC|PREP):\s*(\w+)/gim;

	static getFiles(dir) {
		const files = [];
		const items = fs.readdirSync(dir, { withFileTypes: true });

		for (const item of items) {
			const fullPath = path.join(dir, item.name);
			if (item.isDirectory()) {
				files.push(...SqlRiteCore.getFiles(fullPath));
			} else if (item.name.endsWith(".sql")) {
				files.push(fullPath);
			}
		}

		return SqlRiteCore.#sortFiles(files);
	}

	static #sortFiles(files) {
		return [...files].sort((a, b) =>
			path.basename(a).localeCompare(path.basename(b), undefined, {
				numeric: true,
				sensitivity: "base",
			}),
		);
	}

	static parseSql(files) {
		const chunks = { INIT: [], EXEC: [], PREP: [] };

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
				if (sql) {
					chunks[type].push({ type, name, sql });
				}
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
				(value !== null &&
					typeof value === "object" &&
					value.constructor?.name === "Object")
			) {
				result[cleanKey] = JSON.stringify(value);
			} else {
				result[cleanKey] = value;
			}
		}
		return result;
	}
}
