/**
 * Storage codec for `memory_embeddings`.
 *
 * Rows carry two encodings of the same vector:
 * - `embedding_json` (TEXT, NOT NULL): the raw provider vector as a JSON array. Still
 *   written on every insert so older readers of the same database file keep working.
 * - `embedding` (BLOB, nullable): little-endian Float32 bytes of the unit-normalised
 *   vector. Readers prefer it: decoding is a zero-copy view and cosine is a plain dot
 *   product. A zero-length BLOB marks a valid all-zero vector (cosine 0 everywhere).
 *
 * Rows written before the BLOB column existed — or rewritten by an older writer, whose
 * `INSERT OR REPLACE` leaves it NULL — fall back to the JSON text and are backfilled
 * lazily by {@link backfillEmbeddingBlobs}.
 */
import type { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";
import { transaction } from "../db";
import { tableHasColumn } from "../util/sqlite";

/** A stored embedding row as selected through {@link storedEmbeddingColumns}. */
export interface StoredEmbeddingRow {
	readonly memory_id: string;
	readonly embedding: Uint8Array | null;
	readonly embedding_json: string | null;
}

/** A legacy JSON row decoded during a read, pending its BLOB backfill. */
export interface LegacyEmbedding {
	readonly memoryId: string;
	readonly json: string;
	readonly blob: Uint8Array;
}

const EMPTY_VECTOR = new Float32Array(0);

/** Whether `memory_embeddings` has the `embedding` BLOB column (added by `initBeam`). */
export function hasEmbeddingBlobColumn(db: Database): boolean {
	return tableHasColumn(db, "memory_embeddings", "embedding");
}

/**
 * Parse a stored `embedding_json` value. Returns the parsed array itself (no copy) when
 * every element is a finite number, otherwise null.
 */
export function parseEmbeddingJson(raw: unknown): number[] | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	for (let i = 0; i < parsed.length; i += 1) {
		const value = parsed[i];
		if (typeof value !== "number" || !Number.isFinite(value)) return null;
	}
	return parsed as number[];
}

/**
 * Unit-normalise `values` into Float32. Returns an empty vector for a valid all-zero or
 * empty input (cosine 0 against anything) and null when any element is non-finite.
 */
export function unitFloat32(values: ArrayLike<number>): Float32Array | null {
	const length = values.length;
	let normSq = 0;
	for (let i = 0; i < length; i += 1) {
		const value = values[i] as number;
		if (!Number.isFinite(value)) return null;
		normSq += value * value;
	}
	if (normSq === 0) return EMPTY_VECTOR;
	const norm = Math.sqrt(normSq);
	const out = new Float32Array(length);
	for (let i = 0; i < length; i += 1) out[i] = (values[i] as number) / norm;
	return out;
}

/**
 * Unit-normalise a query vector in Float64. Non-finite elements count as 0 (the same
 * leniency as `cosineSimilarity`); returns null when the norm is 0.
 */
export function unitQuery(values: ArrayLike<number>): Float64Array | null {
	const length = values.length;
	const out = new Float64Array(length);
	let normSq = 0;
	for (let i = 0; i < length; i += 1) {
		const raw = values[i] as number;
		const value = Number.isFinite(raw) ? raw : 0;
		out[i] = value;
		normSq += value * value;
	}
	if (normSq === 0) return null;
	const norm = Math.sqrt(normSq);
	for (let i = 0; i < length; i += 1) out[i] = (out[i] as number) / norm;
	return out;
}

/** BLOB bytes for a raw vector, or null when it has non-finite elements. */
export function encodeEmbeddingBlob(values: ArrayLike<number>): Uint8Array | null {
	const unit = unitFloat32(values);
	return unit === null ? null : new Uint8Array(unit.buffer, unit.byteOffset, unit.byteLength);
}

/**
 * View BLOB bytes as Float32. Zero-copy when the bytes are 4-byte aligned, copied
 * otherwise. Null for a missing or malformed BLOB.
 */
export function decodeEmbeddingBlob(blob: unknown): Float32Array | null {
	if (!(blob instanceof Uint8Array) || blob.byteLength % 4 !== 0) return null;
	if (blob.byteLength === 0) return EMPTY_VECTOR;
	if (blob.byteOffset % 4 === 0) return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength >> 2);
	return new Float32Array(blob.slice().buffer);
}

/** Dot product over the shared prefix; for unit vectors this is cosine with zero-padding. */
export function dotProduct(a: ArrayLike<number>, b: ArrayLike<number>): number {
	const length = a.length < b.length ? a.length : b.length;
	let dot = 0;
	for (let i = 0; i < length; i += 1) dot += (a[i] as number) * (b[i] as number);
	return dot;
}

/**
 * SELECT-list fragment for a `memory_embeddings` alias producing {@link StoredEmbeddingRow}
 * columns. The JSON text is only materialised for rows without a BLOB.
 */
export function storedEmbeddingColumns(db: Database, alias: string): string {
	const prefix = alias.length === 0 ? "" : `${alias}.`;
	return hasEmbeddingBlobColumn(db)
		? `${prefix}memory_id AS memory_id, ${prefix}embedding AS embedding, CASE WHEN ${prefix}embedding IS NULL THEN ${prefix}embedding_json END AS embedding_json`
		: `${prefix}memory_id AS memory_id, NULL AS embedding, ${prefix}embedding_json AS embedding_json`;
}

/**
 * Unit vector for a stored row: the BLOB when present, else the parsed JSON. A decoded
 * JSON row is queued on `legacy` for {@link backfillEmbeddingBlobs}. Returns an empty
 * vector for a valid all-zero embedding and null for an unusable row.
 */
export function storedUnitEmbedding(row: StoredEmbeddingRow, legacy?: LegacyEmbedding[]): Float32Array | null {
	if (row.embedding !== null && row.embedding !== undefined) {
		const fromBlob = decodeEmbeddingBlob(row.embedding);
		if (fromBlob !== null) return fromBlob;
	}
	const json = row.embedding_json;
	const parsed = parseEmbeddingJson(json);
	if (parsed === null || json === null) return null;
	const unit = unitFloat32(parsed);
	if (unit === null) return null;
	legacy?.push({
		memoryId: row.memory_id,
		json,
		blob: new Uint8Array(unit.buffer, unit.byteOffset, unit.byteLength),
	});
	return unit;
}

/**
 * Persist BLOBs for legacy rows decoded during a read. Only fills rows whose BLOB is
 * still NULL and whose JSON is unchanged, so a concurrent rewrite is never clobbered.
 * Best-effort: read-only connections and closed handles are ignored.
 */
export function backfillEmbeddingBlobs(db: Database, legacy: readonly LegacyEmbedding[]): void {
	if (legacy.length === 0 || !hasEmbeddingBlobColumn(db)) return;
	const write = (): void => {
		const update = db.query(
			"UPDATE memory_embeddings SET embedding = ? WHERE memory_id = ? AND embedding IS NULL AND embedding_json = ?",
		);
		for (const item of legacy) update.run(item.blob, item.memoryId, item.json);
	};
	try {
		if (db.inTransaction) write();
		else transaction(db, write);
	} catch (error) {
		logger.debug("mnemopi: embedding BLOB backfill skipped", { count: legacy.length, error: String(error) });
	}
}
