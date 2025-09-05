import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

export default class SqlRite {
	constructor(options = {}) {
		const defaults = {
			path: ":memory:",
			dir: "sql",
		};

		const merged = { ...defaults, ...options };

		const db = new DatabaseSync(merged.path, merged);

		// allow multiple directories
		if (!Array.isArray(merged.dir)) merged.dir = [merged.dir];
		const files = merged.dir.flatMap((d) => this.getFiles(d));

		const code = files.map((f) => fs.readFileSync(f, "utf8")).join("");

		this.async = {};

		const chunks =
			/-- (?<chunk>(?<type>INIT|EXEC|PREP): (?<name>\w+)\n(?<sql>.*?))($|(?=-- (INIT|EXEC|PREP):))/gs;

		const initChunks = [];
		const execChunks = [];
		const prepChunks = [];

		for (const chunk of code.matchAll(chunks)) {
			const { type } = chunk.groups;

			if (type === "INIT") initChunks.push(chunk.groups);
			if (type === "EXEC") execChunks.push(chunk.groups);
			if (type === "PREP") prepChunks.push(chunk.groups);
		}

		initChunks.forEach((init) => {
			db.exec(init.sql);
		});

		execChunks.forEach((exec) => {
			this[exec.name] = () => db.exec(exec.sql);
			this.async[exec.name] = async () => db.exec(exec.sql);
		});

		prepChunks.forEach((prep) => {
			this[prep.name] = db.prepare(prep.sql);

			this.async[prep.name] = {};

			this.async[prep.name].all = async (params = {}) =>
				this[prep.name].all(params);

			this.async[prep.name].get = async (params = {}) =>
				this[prep.name].get(params);

			this.async[prep.name].run = async (params = {}) =>
				this[prep.name].run(params);
		});
	}

	getFiles(dir) {
		const files = [];

		for (const item of fs.readdirSync(dir)) {
			const path = `${dir}/${item}`;

			if (fs.lstatSync(path).isDirectory()) files.push(...this.getFiles(path));
			else if (item.endsWith(".sql")) files.push(path);
		}

		return files.sort();
	}
}
