import fs from "node:fs";
import path from "node:path";

export default class SqlRiteCore {
	static getFiles(dir) {
		const files = [];

		const items = fs.readdirSync(dir, { withFileTypes: true });

		for (const item of items) {
			const fullPath = path.join(dir, item.name);
			if (item.isDirectory()) {
				files.push(...this.getFiles(fullPath));
			} else if (item.name.endsWith(".sql")) {
				files.push(fullPath);
			}
		}

		// Numerically linear sorting
		return files.sort((a, b) => {
			const aBase = path.basename(a);
			const bBase = path.basename(b);
			const aMatch = aBase.match(/^(\d+)/);
			const bMatch = bBase.match(/^(\d+)/);

			if (aMatch && bMatch) {
				const aNum = parseInt(aMatch[1], 10);
				const bNum = parseInt(bMatch[1], 10);
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
		const chunks = {
			INIT: [],
			EXEC: [],
			PREP: [],
		};

		for (const file of files) {
			const content = fs.readFileSync(file, "utf8");
			// Split by lines to find headers, then group the SQL following them
			const lines = content.split(/\r?\n/);
			let currentChunk = null;

			for (const line of lines) {
				const match = line.match(/^-- (INIT|EXEC|PREP): (\w+)/);
				if (match) {
					const [_, type, name] = match;
					currentChunk = { type, name, sql: "" };
					chunks[type].push(currentChunk);
				} else if (currentChunk) {
					currentChunk.sql += `${line}\n`;
				}
			}
		}

		// Trim SQL and filter out empty chunks
		for (const type in chunks) {
			chunks[type] = chunks[type].map(c => ({
				...c,
				sql: c.sql.trim()
			})).filter(c => c.sql.length > 0);
		}

		return chunks;
	}

	static jsonify(params) {
		if (!params) return {};
		const result = { ...params };
		for (const key in result) {
			if (Array.isArray(result[key]) || (result[key] !== null && typeof result[key] === "object" && result[key].constructor === Object)) {
				result[key] = JSON.stringify(result[key]);
			}
		}
		return result;
	}
}
