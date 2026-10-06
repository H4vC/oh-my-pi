import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { closeDb, initDb } from "@oh-my-pi/omp-stats/db";
import { getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-schema-");

const USER_MESSAGE_INDEXES = [
	"idx_user_messages_timestamp",
	"idx_user_messages_entry_timestamp",
	"idx_user_messages_timestamp_model",
	"idx_user_messages_prose_hash",
];

/** Create a stats DB whose `user_messages` table has the given (legacy) metric columns. */
async function seedLegacyUserMessages(metricColumns: string): Promise<void> {
	const dbPath = getStatsDbPath();
	await fs.mkdir(path.dirname(dbPath), { recursive: true });
	const legacy = new Database(dbPath);
	legacy.run(`
		CREATE TABLE user_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			model TEXT,
			provider TEXT,
			chars INTEGER NOT NULL,
			words INTEGER NOT NULL,
			${metricColumns},
			UNIQUE(session_file, entry_id)
		);
		CREATE INDEX idx_user_messages_timestamp ON user_messages(timestamp);
	`);
	legacy.close();
}

async function userMessagesSchema(): Promise<{ columns: string[]; indexes: string[] }> {
	const database = await initDb();
	const columns = (database.query("PRAGMA table_info(user_messages)").all() as { name: string }[]).map(c => c.name);
	const indexes = (database.query("PRAGMA index_list(user_messages)").all() as { name: string }[]).map(i => i.name);
	closeDb();
	return { columns, indexes };
}

describe("user_messages schema migration", () => {
	it("rebuilds a v8 table without judge prose with every current index", async () => {
		await seedLegacyUserMessages(`yelling INTEGER NOT NULL, profanity INTEGER NOT NULL, anguish INTEGER NOT NULL,
			negation INTEGER NOT NULL DEFAULT 0, repetition INTEGER NOT NULL DEFAULT 0, blame INTEGER NOT NULL DEFAULT 0`);

		const { columns, indexes } = await userMessagesSchema();

		expect(columns).toContain("prose");
		expect(columns).toContain("prose_hash");
		expect(indexes).toEqual(expect.arrayContaining(USER_MESSAGE_INDEXES));
	});

	it("rebuilds a table carrying stale metric columns", async () => {
		await seedLegacyUserMessages("caps_words INTEGER NOT NULL, drama_runs INTEGER NOT NULL");

		const { columns, indexes } = await userMessagesSchema();

		expect(columns).not.toContain("caps_words");
		expect(columns).toContain("negation");
		expect(indexes).toEqual(expect.arrayContaining(USER_MESSAGE_INDEXES));
	});
});
