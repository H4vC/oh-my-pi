import { describe, expect, it } from "bun:test";
import { PptxConverter } from "@oh-my-pi/pi-coding-agent/markit/converters/pptx";
import { encodeArchive } from "@oh-my-pi/pi-utils/ar";

function slideXml(title: string): string {
	return `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
}

describe("PptxConverter", () => {
	it("falls back to numbered slide files when presentation relationships are missing", async () => {
		const deck = await encodeArchive("zip", [
			["ppt/presentation.xml", "<p:presentation><p:sldIdLst/></p:presentation>"],
			["ppt/slides/slide10.xml", slideXml("Tenth")],
			["ppt/slides/slide2.xml", slideXml("Second")],
			["ppt/slides/slide1.xml", slideXml("First")],
			["ppt/slides/_rels/slide1.xml.rels", "<Relationships/>"],
		]);

		const result = await new PptxConverter().convert(Buffer.from(deck), { extension: ".pptx" });

		expect(result.markdown).toBe(
			["<!-- Slide 1 -->\n# First", "<!-- Slide 2 -->\n# Second", "<!-- Slide 3 -->\n# Tenth"].join("\n\n"),
		);
	});
});
