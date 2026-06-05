import { describe, expect, it } from "bun:test";
import { getTerminalInfo, TERMINAL } from "../src/terminal-capabilities";
import { type Component, type NativeScrollbackLiveRegion, TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

class LineList implements Component, NativeScrollbackLiveRegion {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	setLines(lines: string[]): void {
		this.#lines = lines;
	}

	invalidate(): void {}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return 0;
	}

	render(_width: number): string[] {
		return this.#lines;
	}
}

class LineListSealed implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return this.#lines;
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await term.waitForRender();
}

function overrideProbe(term: VirtualTerminal, answer: boolean | undefined): void {
	(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () => answer;
}

type MutableTerminalInfo = { eagerEraseScrollbackRisk: boolean };
const MUX_KEYS = ["TMUX", "STY", "ZELLIJ"] as const;
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

async function withGhostty(run: () => Promise<void>): Promise<void> {
	const terminalInfo = TERMINAL as unknown as MutableTerminalInfo;
	const savedRisk = terminalInfo.eagerEraseScrollbackRisk;
	const savedEnv: Record<string, string | undefined> = {};
	for (const key of MUX_KEYS) {
		savedEnv[key] = Bun.env[key];
		delete (Bun.env as Record<string, string | undefined>)[key];
	}
	terminalInfo.eagerEraseScrollbackRisk = getTerminalInfo("ghostty").eagerEraseScrollbackRisk;
	try {
		await run();
	} finally {
		terminalInfo.eagerEraseScrollbackRisk = savedRisk;
		for (const key of MUX_KEYS) {
			if (savedEnv[key] === undefined) delete (Bun.env as Record<string, string | undefined>)[key];
			else (Bun.env as Record<string, string | undefined>)[key] = savedEnv[key];
		}
	}
}

function duplicateNonblank(lines: string[]): string[] {
	const seen = new Set<string>();
	const duplicates: string[] = [];
	for (const line of lines.map(line => line.trimEnd())) {
		if (line.length === 0) continue;
		if (seen.has(line)) duplicates.push(line);
		seen.add(line);
	}
	return duplicates;
}

describeOnPosix("foreground-stream scrollback duplication on ED3-risk ghostty", () => {
	it("does not duplicate history rows when overflowing content then shrinks", async () => {
		await withGhostty(async () => {
			const term = new VirtualTerminal(20, 4);
			overrideProbe(term, undefined);
			const tui = new TUI(term);
			const list = new LineList([]);
			tui.addChild(list);
			try {
				tui.start();
				await settle(term);
				tui.setEagerNativeScrollbackRebuild(true);

				const grown = Array.from({ length: 10 }, (_value, index) => `row-${index}`);
				list.setLines(grown);
				tui.requestRender();
				await settle(term);

				const shrunk = Array.from({ length: 7 }, (_value, index) => `row-${index}`);
				list.setLines(shrunk);
				tui.requestRender();
				await settle(term);
				expect(duplicateNonblank(term.getScrollBuffer())).toEqual([]);

				tui.setEagerNativeScrollbackRebuild(false);
				tui.requestRender();
				await settle(term);
				expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(true);
				await settle(term);
				const checkpointBuffer = term.getScrollBuffer();
				expect(checkpointBuffer.map(line => line.trimEnd())).toEqual(shrunk);
				expect(duplicateNonblank(checkpointBuffer)).toEqual([]);
			} finally {
				tui.stop();
			}
		});
	});

	it("never emits a full-screen erase while pinning the live region", async () => {
		await withGhostty(async () => {
			const term = new VirtualTerminal(20, 4);
			overrideProbe(term, undefined);
			let captured = "";
			const realWrite = term.write.bind(term);
			(term as unknown as { write: (s: string) => void }).write = (data: string) => {
				captured += data;
				realWrite(data);
			};
			const tui = new TUI(term);
			const list = new LineList([]);
			tui.addChild(list);
			try {
				tui.start();
				await settle(term);
				tui.setEagerNativeScrollbackRebuild(true);
				captured = "";

				const lines: string[] = [];
				for (let n = 1; n <= 24; n++) {
					lines.push(`line-${n}`);
					list.setLines([...lines]);
					tui.requestRender();
					await settle(term);
				}
				list.setLines(lines.slice(0, 18));
				tui.requestRender();
				await settle(term);

				expect(captured.includes("\x1b[2J")).toBe(false);
				expect(captured.includes("\x1b[3J")).toBe(false);
				expect(tui.fullRedraws).toBeGreaterThan(0);
			} finally {
				tui.stop();
			}
		});
	});

	it("keeps a scrolled reader's viewport fixed while the live region streams", async () => {
		await withGhostty(async () => {
			const term = new VirtualTerminal(20, 4);
			overrideProbe(term, undefined);
			const tui = new TUI(term);
			const sealed = new LineListSealed(Array.from({ length: 12 }, (_value, index) => `prior-${index}`));
			const live = new LineList([]);
			tui.addChild(sealed);
			tui.addChild(live);
			try {
				tui.start();
				await settle(term);
				expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(false);
				tui.setEagerNativeScrollbackRebuild(true);
				live.setLines(Array.from({ length: 6 }, (_value, index) => `think-${index}`));
				tui.requestRender();
				await settle(term);
				term.scrollLines(-3);
				const before = term.getBufferPosition().viewportY;
				for (let n = 7; n <= 20; n++) {
					live.setLines(Array.from({ length: n }, (_value, index) => `think-${index}`));
					tui.requestRender();
					await settle(term);
				}
				expect(term.getBufferPosition().viewportY).toBe(before);
			} finally {
				tui.stop();
			}
		});
	});
});
