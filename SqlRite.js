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

		this.close = () => db.close();

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
			const stmt = db.prepare(prep.sql);
			this[prep.name] = {};

			this[prep.name].all = (params = {}) => stmt.all(this.doJsonify(params));
			this[prep.name].get = (params = {}) => stmt.get(this.doJsonify(params));
			this[prep.name].run = (params = {}) => stmt.run(this.doJsonify(params));

			this.async[prep.name] = {};

			this.async[prep.name].all = async (params = {}) => {
				return stmt.all(this.doJsonify(params));
			};

			this.async[prep.name].get = async (params = {}) => {
				return stmt.get(this.doJsonify(params));
			};

			this.async[prep.name].run = async (params = {}) => {
				return stmt.run(this.doJsonify(params));
			};
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

	doJsonify(params) {
		for (const param in params) {
			if (Array.isArray(params[param])) {
				params[param] = JSON.stringify(params[param]);
			}
		}

		return params;
	}
}
