#!/usr/bin/env bun
/**
 * `bun run gen:models-interned` — derives `src/models.interned.json` from the
 * committed `src/models.json` without touching the network.
 *
 * `models.json` stays the public, fully-expanded export
 * (`@oh-my-pi/pi-catalog/models.json`). Most of its bytes are repeated
 * `compat` / `thinking` / `identity` records (5.6k rows share a few hundred
 * distinct values), so the runtime (`src/models.ts`) loads this interned form
 * instead: each repeated record is stored once in `profiles.<field>` and rows
 * carry its index. `generate-models.ts` runs this after every regeneration.
 */
import * as path from "node:path";

/** Row fields whose values repeat across many rows; stored once and referenced by index. */
export const INTERNED_MODEL_FIELDS = ["compat", "thinking", "identity"] as const;
export type InternedModelField = (typeof INTERNED_MODEL_FIELDS)[number];

export interface InternedModels {
	profiles: Record<InternedModelField, unknown[]>;
	models: Record<string, Record<string, Record<string, unknown>>>;
}

/** Intern repeated row records. Deterministic: profiles are numbered in first-seen row order. */
export function internModels(models: Record<string, Record<string, Record<string, unknown>>>): InternedModels {
	const profiles = {} as Record<InternedModelField, unknown[]>;
	const indexes = {} as Record<InternedModelField, Map<string, number>>;
	for (const field of INTERNED_MODEL_FIELDS) {
		profiles[field] = [];
		indexes[field] = new Map();
	}
	const out: InternedModels["models"] = {};
	for (const provider in models) {
		const rows = models[provider]!;
		const internedRows: Record<string, Record<string, unknown>> = {};
		for (const id in rows) {
			const row = { ...rows[id]! };
			for (const field of INTERNED_MODEL_FIELDS) {
				const value = row[field];
				if (value === undefined) continue;
				const key = JSON.stringify(value);
				let index = indexes[field].get(key);
				if (index === undefined) {
					index = profiles[field].length;
					profiles[field].push(value);
					indexes[field].set(key, index);
				}
				row[field] = index;
			}
			internedRows[id] = row;
		}
		out[provider] = internedRows;
	}
	return { profiles, models: out };
}

const srcDir = path.join(import.meta.dir, "../src");

/** Rewrite `src/models.interned.json` from `src/models.json`. */
export async function writeInternedModels(): Promise<void> {
	const models = (await Bun.file(path.join(srcDir, "models.json")).json()) as Parameters<typeof internModels>[0];
	await Bun.write(path.join(srcDir, "models.interned.json"), JSON.stringify(internModels(models)));
}

if (import.meta.main) {
	await writeInternedModels();
	console.log("Generated src/models.interned.json");
}
