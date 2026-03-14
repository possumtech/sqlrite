export interface SqlRiteOptions {
	path?: string;
	dir?: string | string[];
}

export interface SqlRitePreparedStatements {
	all: (params?: Record<string, any>) => Promise<any[]>;
	get: (params?: Record<string, any>) => Promise<any>;
	run: (params?: Record<string, any>) => Promise<any>;
}

export interface SqlRiteSyncPreparedStatements {
	all: (params?: Record<string, any>) => any[];
	get: (params?: Record<string, any>) => any;
	run: (params?: Record<string, any>) => any;
}

export class SqlRiteSync {
	constructor(options?: SqlRiteOptions);
	close(): void;
	[key: string]:
		| ((params?: Record<string, any>) => void)
		| SqlRiteSyncPreparedStatements
		| any;
}

export default class SqlRite {
	private constructor(options?: SqlRiteOptions, token?: symbol);
	static open(options?: SqlRiteOptions): Promise<SqlRite>;
	ready(): Promise<SqlRite>;
	close(): Promise<void>;
	[key: string]:
		| ((params?: Record<string, any>) => Promise<void>)
		| SqlRitePreparedStatements
		| any;
}
