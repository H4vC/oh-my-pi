import type { Database } from "bun:sqlite";

/**
 * Per-connection schema probe memo, keyed on `PRAGMA schema_version`.
 *
 * Recall and store paths probe `sqlite_master` / `PRAGMA table_info` on every call to
 * tolerate partially-initialised banks. The schema almost never changes after open, so
 * each probe result is cached until SQLite bumps the schema cookie (any CREATE, DROP or
 * ALTER, from this or another connection). Reading the cookie is a header read, far
 * cheaper than scanning `sqlite_master`. WeakMap keeps no Database alive.
 */
interface SchemaMemo {
	readonly version: number;
	readonly tables: Map<string, boolean>;
	readonly columns: Map<string, ReadonlySet<string>>;
}

const schemaMemos = new WeakMap<Database, SchemaMemo>();

function schemaMemo(db: Database): SchemaMemo {
	const row = db.query("PRAGMA schema_version").get() as { schema_version: number } | null;
	const version = row?.schema_version ?? -1;
	const cached = schemaMemos.get(db);
	if (cached !== undefined && cached.version === version) return cached;
	const memo: SchemaMemo = { version, tables: new Map(), columns: new Map() };
	schemaMemos.set(db, memo);
	return memo;
}

/** Whether `table` (plain or virtual) exists. Returns false when the connection is unusable. */
export function tableExists(db: Database, table: string): boolean {
	try {
		const memo = schemaMemo(db);
		const cached = memo.tables.get(table);
		if (cached !== undefined) return cached;
		const exists =
			db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table) !== null;
		memo.tables.set(table, exists);
		return exists;
	} catch {
		return false;
	}
}

/** Column names of `table` (empty when it does not exist or the connection is unusable). */
export function tableColumns(db: Database, table: string): ReadonlySet<string> {
	try {
		const memo = schemaMemo(db);
		const cached = memo.columns.get(table);
		if (cached !== undefined) return cached;
		const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
		const columns = new Set(rows.map(row => row.name));
		memo.columns.set(table, columns);
		return columns;
	} catch {
		return new Set();
	}
}

export function tableHasColumn(db: Database, table: string, column: string): boolean {
	return tableColumns(db, table).has(column);
}

/** `?,?,…` bind list for an `IN (…)` clause with `count` parameters. */
export function sqlPlaceholders(count: number): string {
	return count <= 0 ? "" : `${"?,".repeat(count - 1)}?`;
}
