import { Database, DatabaseSync, Statement } from 'node:sqlite';

interface SqlRiteOptions {
	path?: string;
	dir?: string;
}

interface SqlRiteAsyncPreparedStatements {
	all: (params?: Record<string, any>) => Promise<any[]>;
	get: (params?: Record<string, any>) => Promise<any>;
	run: (params?: Record<string, any>) => Promise<void>;
}

interface SqlRiteAsyncMethods {
	[key: string]: (() => Promise<void>) | SqlRiteAsyncPreparedStatements;
}

export default class SqlRite {
	constructor(options?: SqlRiteOptions);
	async: SqlRiteAsyncMethods;
	[key: string]: (() => void) | Statement | SqlRiteAsyncMethods | any;
}
