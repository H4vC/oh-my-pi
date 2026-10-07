/**
 * `memory_embeddings.embedding` BLOB storage stays compatible with databases written
 * before the column existed (or by older writers that only fill `embedding_json`):
 * those rows are still scored from the JSON text and lazily backfilled to the BLOB.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import "./setup";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { recall } from "@oh-my-pi/pi-mnemopi/core/beam/recall";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import { PolyphonicRecallEngine } from "@oh-my-pi/pi-mnemopi/core/polyphonic-recall";
import { decodeEmbeddingBlob } from "@oh-my-pi/pi-mnemopi/core/stored-embeddings";

interface StoredRow {
	readonly embedding_json: string;
	readonly embedding: Uint8Array | null;
}

function storedRow(db: Database, memoryId: string): StoredRow | null {
	return db
		.query("SELECT embedding_json, embedding FROM memory_embeddings WHERE memory_id = ?")
		.get(memoryId) as StoredRow | null;
}

function insertWorking(beam: BeamMemory, id: string, content: string): void {
	beam.db.run(
		"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance) VALUES (?, ?, 'test', datetime('now'), ?, 0.5)",
		[id, content, beam.sessionId],
	);
}

/** Simulates a row written by a pre-BLOB omp version: JSON only, BLOB left NULL. */
function insertLegacyEmbedding(db: Database, memoryId: string, vector: readonly number[]): void {
	db.run("INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'legacy')", [
		memoryId,
		JSON.stringify(vector),
	]);
}

describe("memory_embeddings BLOB storage", () => {
	it("adds the BLOB column to a pre-existing JSON-only table", () => {
		const db = new Database(":memory:");
		try {
			db.run(
				"CREATE TABLE memory_embeddings (memory_id TEXT PRIMARY KEY, embedding_json TEXT NOT NULL, model TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
			);
			insertLegacyEmbedding(db, "old", [3, 4]);
			initBeam(db);
			const columns = (db.query("PRAGMA table_info(memory_embeddings)").all() as { name: string }[]).map(
				row => row.name,
			);
			expect(columns).toContain("embedding");
			expect(storedRow(db, "old")).toEqual({ embedding_json: "[3,4]", embedding: null });
		} finally {
			db.close();
		}
	});

	it("scores legacy embedding_json rows in recall and lazily backfills the BLOB", async () => {
		const beam = new BeamMemory({ sessionId: "blob-recall", dbPath: ":memory:" });
		try {
			insertWorking(beam, "near", "quarterly planning notes");
			insertWorking(beam, "far", "unrelated grocery list");
			insertLegacyEmbedding(beam.db, "near", [3, 4]);
			insertLegacyEmbedding(beam.db, "far", [-4, 3]);

			const query = [0.6, 0.8];
			const first = await recall(beam, "zzz", 5, { queryEmbedding: query, updateRecallCounts: false });
			expect(first.find(result => result.id === "near")?.dense_score).toBe(1);

			const backfilled = storedRow(beam.db, "near");
			expect(backfilled?.embedding_json).toBe("[3,4]");
			const unit = decodeEmbeddingBlob(backfilled?.embedding);
			expect(unit === null ? null : Array.from(unit)).toEqual([Math.fround(0.6), Math.fround(0.8)]);
			expect(storedRow(beam.db, "far")?.embedding).toBeInstanceOf(Uint8Array);

			// Second recall reads the BLOBs and ranks identically.
			const second = await recall(beam, "zzz", 5, { queryEmbedding: query, updateRecallCounts: false });
			expect(second.map(result => [result.id, result.dense_score])).toEqual(
				first.map(result => [result.id, result.dense_score]),
			);
		} finally {
			beam.close();
		}
	});

	it("falls back to JSON when an older writer replaced the row after a backfill", async () => {
		const beam = new BeamMemory({ sessionId: "blob-stale", dbPath: ":memory:" });
		try {
			insertWorking(beam, "m", "memory row");
			insertLegacyEmbedding(beam.db, "m", [1, 0]);
			await recall(beam, "zzz", 5, { queryEmbedding: [1, 0], updateRecallCounts: false });
			expect(storedRow(beam.db, "m")?.embedding).toBeInstanceOf(Uint8Array);

			// An older omp rewrites the vector via INSERT OR REPLACE, which drops the BLOB.
			insertLegacyEmbedding(beam.db, "m", [0, 1]);
			const results = await recall(beam, "memory", 5, { queryEmbedding: [0, 1], updateRecallCounts: false });
			expect(results.find(result => result.id === "m")?.dense_score).toBe(1);
			const unit = decodeEmbeddingBlob(storedRow(beam.db, "m")?.embedding);
			expect(unit === null ? null : Array.from(unit)).toEqual([0, 1]);
		} finally {
			beam.close();
		}
	});

	it("backfills legacy rows read by the polyphonic vector voice", () => {
		const beam = new BeamMemory({ sessionId: "blob-voice", dbPath: ":memory:" });
		try {
			insertWorking(beam, "wm-1", "working row");
			insertLegacyEmbedding(beam.db, "wm-1", [2, 0]);
			const engine = new PolyphonicRecallEngine({ db: beam.db });
			const hits = engine.vectorVoice([1, 0]);
			expect(hits.map(hit => hit.memoryId)).toEqual(["wm-1"]);
			expect(hits[0]?.metadata.cosine_similarity).toBe(1);
			const unit = decodeEmbeddingBlob(storedRow(beam.db, "wm-1")?.embedding);
			expect(unit === null ? null : Array.from(unit)).toEqual([1, 0]);
		} finally {
			beam.close();
		}
	});

	it("writes both embedding_json (for older readers) and the BLOB on new embeddings", async () => {
		const memory = new Mnemopi({
			db: new Database(":memory:"),
			embeddings: {
				provider: async function* (texts: readonly string[]) {
					yield texts.map(() => [0, 3, 4]);
				},
			},
		});
		try {
			const id = memory.remember("fresh memory", { source: "test" });
			await memory.flushExtractions();
			const row = storedRow(memory.conn, id);
			expect(JSON.parse(row?.embedding_json ?? "null")).toEqual([0, 3, 4]);
			const unit = decodeEmbeddingBlob(row?.embedding);
			expect(unit === null ? null : Array.from(unit)).toEqual([0, Math.fround(0.6), Math.fround(0.8)]);
		} finally {
			memory.close();
		}
	});
});
