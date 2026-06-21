import { describe, expect, it } from "bun:test";
import { installPatchrightBunPipeSpawnPatch } from "@oh-my-pi/pi-coding-agent/tools/browser/patchright-bun-pipe";

describe("installPatchrightBunPipeSpawnPatch", () => {
	it("is a no-op outside the Bun Patchright pipe launch seam", () => {
		expect(() => installPatchrightBunPipeSpawnPatch()).not.toThrow();
	});
});
