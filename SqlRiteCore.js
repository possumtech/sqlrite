import fs from "node:fs";
import path from "node:path";

export default class SqlRiteCore {
	static #CHUNK_REGEX = /^-- (INIT|EXEC|PREP): (\w+)/;

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
		return [...files].sort((a, b) => {
			const aBase = path.basename(a);
			const bBase = path.basename(b);
			const aMatch = aBase.match(/^(\d+)/);
			const bMatch = bBase.match(/^(\d+)/);

			if (aMatch && bMatch) {
				const aNum = Number.parseInt(aMatch[1], 10);
				const bNum = Number.parseInt(bMatch[1], 10);
				if (aNum !== bNum) return aNum - bNum;
			} else if (aMatch) {
				return -1;
			} else if (bMatch) {
				return 1;
			}

			return a.localeCompare(b);
		});
	}

	static parseSql(files) {
		const chunks = { INIT: [], EXEC: [], PREP: [] };

		for (const file of files) {
			const content = fs.readFileSync(file, "utf8");
			SqlRiteCore.#processContent(content, chunks);
		}

		return SqlRiteCore.#trimChunks(chunks);
	}

	static #processContent(content, chunks) {
		const lines = content.split(/\r?\n/);
		let currentChunk = null;

		for (const line of lines) {
			const match = line.match(SqlRiteCore.#CHUNK_REGEX);
			if (match) {
				const [_, type, name] = match;
				currentChunk = { type, name, sql: "" };
				chunks[type].push(currentChunk);
			} else if (currentChunk) {
				currentChunk.sql += `${line}\n`;
			}
		}
	}

	static #trimChunks(chunks) {
		for (const [type, list] of Object.entries(chunks)) {
			chunks[type] = list
				.map((c) => ({
					...c,
					sql: c.sql.trim(),
				}))
				.filter((c) => c.sql.length > 0);
		}
		return chunks;
	}

	static jsonify(params) {
		if (!params) return {};
		const result = { ...params };

		for (const [key, value] of Object.entries(result)) {
			if (
				Array.isArray(value) ||
				(value !== null &&
					typeof value === "object" &&
					value.constructor?.name === "Object")
			) {
				result[key] = JSON.stringify(value);
			}
		}
		return result;
	}
}
