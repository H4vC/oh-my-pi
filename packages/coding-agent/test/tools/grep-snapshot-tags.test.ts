import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getEditStore } from "@oh-my-pi/pi-coding-agent/edit/store";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { GrepTool } from "../../src/tools/grep";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

describe("grep hashline snapshot tags", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-grep-snapshot-tags-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("re-mints the tag when a file is rewritten with same-length content between searches", async () => {
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const filePath = path.join(cwd, "a.txt");
		await Bun.write(filePath, "needle one\nfiller\n");
		await Bun.write(path.join(cwd, "b.txt"), "needle two\n");
		const tool = new GrepTool(session);
		const tagOf = (text: string): string | undefined => /^#+ a\.txt#([0-9a-z]+)$/im.exec(text)?.[1];

		const first = tagOf(textOf(await tool.execute("first", { pattern: "needle", path: "." })));
		expect(first).toBeDefined();
		// Same byte length, different bytes: a stale (mtime, size) memo would replay the old tag.
		await Bun.write(filePath, "needle uno\nfiller\n");
		const second = tagOf(textOf(await tool.execute("second", { pattern: "needle", path: "." })));

		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		expect(getEditStore(session).headHash(filePath)).toBe(second!);
	});
});
