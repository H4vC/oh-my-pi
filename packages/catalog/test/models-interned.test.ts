import { describe, expect, it } from "bun:test";
import { getBundledModels, getBundledProviders } from "../src/models";
import INTERNED from "../src/models.interned.json";
import MODELS from "../src/models.json";
import { internModels } from "../scripts/intern-models";

type Rows = Record<string, Record<string, Record<string, unknown>>>;

describe("models.interned.json", () => {
	it("is regenerated together with models.json (bun run gen:models-interned)", () => {
		expect(INTERNED as unknown).toEqual(internModels(MODELS as unknown as Parameters<typeof internModels>[0]));
	});

	it("rehydrates rows identical to the public models.json export", () => {
		const models = MODELS as unknown as Rows;
		expect(getBundledProviders() as string[]).toEqual(Object.keys(models));
		for (const provider of getBundledProviders()) {
			const expected = Object.values(models[provider]!).map(row =>
				row.identity === undefined ? { ...row, identity: expect.anything() } : row,
			);
			expect(getBundledModels(provider as never)).toEqual(expected as never);
		}
	});
});
