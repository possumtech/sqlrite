import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

export default class SqlRite {
	constructor(options = {}) {
		const defaults = {
			path: ":memory:",
			dir: "sql/",
		};

		const merged = { ...defaults, ...options };

		const db = new DatabaseSync(merged.path, merged);

		const { dir } = merged;
		const files = fs.readdirSync(dir);
		const code = files.map((f) => fs.readFileSync(dir + f, "utf8")).join("");

		const chunks =
			/-- (?<chunk>(?<type>INIT|EXEC|PREP): (?<name>\w+)\n(?<sql>.*?))($|(?=-- (INIT|EXEC|PREP):))/gs;

		for (const chunk of code.matchAll(chunks)) {
			const { type, name, sql } = chunk.groups;
			switch (type) {
				case "INIT":
					db.exec(sql);
					break;
				case "EXEC":
					this[name] = () => db.exec(sql);
					break;
				case "PREP":
					this[name] = db.prepare(sql);
					break;
			}
		}
	}
}
