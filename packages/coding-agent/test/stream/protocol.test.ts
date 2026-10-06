import { describe, expect, it } from "bun:test";
import {
	decodeStreamFrame,
	isSessionFrame,
	isStreamerFrame,
	StreamLineReader,
} from "@oh-my-pi/pi-coding-agent/stream/protocol";

function collect(reader: StreamLineReader, chunks: Buffer[]): { lines: string[]; ok: boolean } {
	const lines: string[] = [];
	let ok = true;
	for (const chunk of chunks) {
		ok = reader.push(chunk, line => {
			lines.push(line);
			return true;
		});
		if (!ok) break;
	}
	return { lines, ok };
}

describe("StreamLineReader", () => {
	it("splits lines across chunks, strips CR, and keeps multi-byte characters intact", () => {
		const bytes = Buffer.from("first\r\nsé€ond\n\nthird line\n", "utf8");
		for (const size of [1, 2, 3, 5, bytes.length]) {
			const chunks: Buffer[] = [];
			for (let index = 0; index < bytes.length; index += size) chunks.push(bytes.subarray(index, index + size));
			expect(collect(new StreamLineReader(), chunks)).toEqual({
				lines: ["first", "sé€ond", "", "third line"],
				ok: true,
			});
		}
	});

	it("rejects a line over the cap whether or not it is terminated", () => {
		expect(collect(new StreamLineReader(8), [Buffer.from("123456789\n")]).ok).toBe(false);
		expect(collect(new StreamLineReader(8), [Buffer.from("12345"), Buffer.from("6789")]).ok).toBe(false);
		expect(collect(new StreamLineReader(8), [Buffer.from("1234"), Buffer.from("5678\nok\n")])).toEqual({
			lines: ["12345678", "ok"],
			ok: true,
		});
	});

	it("stops at the first line the handler rejects", () => {
		const seen: string[] = [];
		const ok = new StreamLineReader().push(Buffer.from("a\nb\nc\n"), line => {
			seen.push(line);
			return line !== "b";
		});
		expect(ok).toBe(false);
		expect(seen).toEqual(["a", "b"]);
	});

	it("reassembles a long line delivered in many small chunks", () => {
		const line = "x".repeat(200_000);
		const bytes = Buffer.from(`${line}\nnext\n`);
		const chunks: Buffer[] = [];
		for (let index = 0; index < bytes.length; index += 1000) chunks.push(bytes.subarray(index, index + 1000));
		expect(collect(new StreamLineReader(), chunks)).toEqual({ lines: [line, "next"], ok: true });
	});
});

describe("decodeStreamFrame", () => {
	it("accepts only frames for the receiving side", () => {
		const welcome = JSON.stringify({ t: "welcome", proto: 1, channel: "c", url: "u" });
		expect(decodeStreamFrame(welcome, isStreamerFrame)).toEqual({ t: "welcome", proto: 1, channel: "c", url: "u" });
		expect(decodeStreamFrame(welcome, isSessionFrame)).toBeUndefined();
		expect(decodeStreamFrame('{"t":"reset"}', isSessionFrame)).toEqual({ t: "reset" });
		expect(decodeStreamFrame('{"t":"chat","msg":{"id":1}}', isStreamerFrame)).toBeUndefined();
		expect(decodeStreamFrame("{not json", isStreamerFrame)).toBeUndefined();
	});
});
