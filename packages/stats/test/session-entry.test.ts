import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionEntry } from "@oh-my-pi/omp-stats/parser";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-entry-");

const entries = [
	{ type: "session", id: "s1", cwd: "/tmp" },
	// Mentions the target id inside its payload: must not be mistaken for it.
	{ type: "message", id: "a0", message: { role: "assistant", content: [{ type: "toolCall", id: "a1", name: "x" }] } },
	{ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "found" }] } },
];

async function writeTranscript(lines: string[]): Promise<string> {
	const dir = path.join(getSessionsDir(), "--tmp--entry");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, "session.jsonl");
	await Bun.write(file, `${lines.join("\n")}\n`);
	return file;
}

describe("getSessionEntry", () => {
	it("returns the top-level entry with the id, skipping payload mentions", async () => {
		const file = await writeTranscript(entries.map(entry => JSON.stringify(entry)));
		expect(await getSessionEntry(file, "a1")).toMatchObject({ id: "a1", message: { content: [{ text: "found" }] } });
		expect(await getSessionEntry(file, "missing")).toBeNull();
	});

	it("reads a transcript gc compressed to .jsonl.gz under its original path", async () => {
		const file = await writeTranscript(entries.map(entry => JSON.stringify(entry)));
		await Bun.write(`${file}.gz`, Bun.gzipSync(await Bun.file(file).bytes()));
		await fs.rm(file);
		expect(await getSessionEntry(file, "a1")).toMatchObject({ id: "a1" });
		expect(await getSessionEntry(`${file}.gz`, "a1")).toMatchObject({ id: "a1" });
	});

	it("falls back to a line scan for non-compact JSON", async () => {
		const file = await writeTranscript(entries.map(entry => JSON.stringify(entry, null, 1).replaceAll("\n", "")));
		expect(await getSessionEntry(file, "a1")).toMatchObject({ id: "a1" });
	});
});
