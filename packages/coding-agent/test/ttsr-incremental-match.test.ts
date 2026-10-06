import { describe, expect, it } from "bun:test";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { TtsrManager, type TtsrMatchContext } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { type TtsrTool, TtsrToolInspector } from "@oh-my-pi/pi-coding-agent/session/ttsr-outputs";

function rule(name: string, condition: string): Rule {
	return {
		name,
		path: `${name}.md`,
		content: "reminder",
		condition: [condition],
		scope: ["text"],
		_source: { provider: "test", providerName: "test", path: `${name}.md`, level: "project" },
	};
}

const TEXT: TtsrMatchContext = { source: "text" };
/** Many complete lines: past the size where every check rescans the whole buffer. */
const FILLER = "const value = compute(input);\n".repeat(2_000);

function names(rules: Rule[]): string[] {
	return rules.map(match => match.name);
}

describe("TTSR incremental stream matching", () => {
	it("matches a single-line condition split across deltas deep into a long stream", () => {
		const manager = new TtsrManager({ enabled: true });
		manager.addRule(rule("forbidden", "FORBIDDEN_\\w+\\("));
		expect(manager.checkDelta(FILLER, TEXT)).toEqual([]);
		expect(manager.checkDelta("call FORBID", TEXT)).toEqual([]);
		expect(manager.checkDelta("DEN_api", TEXT)).toEqual([]);
		expect(names(manager.checkDelta("(1);\nnext", TEXT))).toEqual(["forbidden"]);
		// A match on a completed line stays reported as the stream grows.
		expect(names(manager.checkDelta(" line\n", TEXT))).toEqual(["forbidden"]);
	});

	it("finds a condition spanning lines on the final check of a long stream", () => {
		const manager = new TtsrManager({ enabled: true });
		manager.addRule(rule("begin-end", "BEGIN\\s+END"));
		manager.checkDelta(FILLER, TEXT);
		manager.checkDelta("BEGIN\n", TEXT);
		manager.checkDelta("END\n", TEXT);
		expect(names(manager.checkDelta("", TEXT, { final: true }))).toEqual(["begin-end"]);
	});

	it("scans growing snapshots incrementally and fully once final", () => {
		const manager = new TtsrManager({ enabled: true });
		manager.addRule(rule("forbidden", "FORBIDDEN"));
		manager.addRule(rule("begin-end", "BEGIN\\s+END"));
		let snapshot = FILLER;
		expect(manager.checkSnapshot(snapshot, TEXT, { final: false })).toEqual([]);
		snapshot += "BEGIN\nEND\nFORB";
		manager.checkSnapshot(snapshot, TEXT, { final: false });
		snapshot += "IDDEN";
		expect(names(manager.checkSnapshot(snapshot, TEXT, { final: false }))).toContain("forbidden");
		expect(names(manager.checkSnapshot(snapshot, TEXT)).sort()).toEqual(["begin-end", "forbidden"]);
		// A rewritten (non-extending) snapshot drops what the old one matched.
		expect(manager.checkSnapshot("clean", TEXT)).toEqual([]);
	});
});

describe("TTSR tool inspection cache", () => {
	it("re-inspects arguments an in-band stream grows in place", () => {
		const write: TtsrTool = {
			name: "write",
			matcherDigest: args =>
				args && typeof args === "object" && "content" in args && typeof args.content === "string"
					? args.content
					: undefined,
		};
		const inspector = new TtsrToolInspector(
			() => [write],
			() => "/repo",
		);
		const args: Record<string, unknown> = { path: "src/a", content: "safe" };
		const toolCall: ToolCall = { type: "toolCall", id: "call-1", name: "write", arguments: args };
		expect(inspector.digest(toolCall)).toBe("safe");
		expect(inspector.matchContext(toolCall, 0).filePaths).toContain("src/a");

		args.path = "src/a.ts";
		args.content = "safe FORBIDDEN";
		expect(inspector.digest(toolCall)).toBe("safe FORBIDDEN");
		expect(inspector.matchContext(toolCall, 0).filePaths).toContain("src/a.ts");
	});
});
