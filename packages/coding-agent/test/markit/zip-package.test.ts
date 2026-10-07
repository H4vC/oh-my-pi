import { describe, expect, it } from "bun:test";
import { ZipPackage } from "@oh-my-pi/pi-coding-agent/markit/zip-package";
import { ArchiveError, encodeArchive } from "@oh-my-pi/pi-utils/ar";

describe("ZipPackage", () => {
	it("caps the bytes inflated across all member reads, not just per member", async () => {
		const zip = await ZipPackage.open(
			await encodeArchive("zip", [
				["a.xml", "a".repeat(600)],
				["b.xml", "b".repeat(600)],
			]),
			1000,
		);

		expect(await zip.readText("a.xml")).toBe("a".repeat(600));
		await expect(zip.readBytes("b.xml")).rejects.toThrow(ArchiveError);
	});
});
