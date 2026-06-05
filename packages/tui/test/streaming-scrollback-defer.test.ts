import { describe, expect, it } from "bun:test";
import { type Component, type NativeScrollbackLiveRegion, TERMINAL, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class LineList implements Component, NativeScrollbackLiveRegion {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return 0;
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await Bun.sleep(20);
	await term.flush();
}

function capture(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	(term as unknown as { write: (s: string) => void }).write = (data: string) => {
		writes.push(data);
		realWrite(data);
	};
	return writes;
}

function overrideProbe(term: VirtualTerminal, answer: boolean | undefined): void {
	(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () => answer;
}

type MutableTerminalInfo = {
	eagerEraseScrollbackRisk: boolean;
};

const mutableTerminalInfo = TERMINAL as unknown as MutableTerminalInfo;
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

async function withTerminalRisk<T>(risk: boolean, run: () => T | Promise<T>): Promise<T> {
	const saved = TERMINAL.eagerEraseScrollbackRisk;
	setTerminalRisk(risk);
	try {
		return await run();
	} finally {
		setTerminalRisk(saved);
	}
}

const ERASE_SCROLLBACK = /\x1b\[3J/g;

function eraseScrollbackCount(writes: string[]): number {
	return writes.join("").match(ERASE_SCROLLBACK)?.length ?? 0;
}

function setTerminalRisk(risk: boolean): void {
	mutableTerminalInfo.eagerEraseScrollbackRisk = risk;
}

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

describe("streaming scrollback defer", () => {
	it("keeps live streaming viewport current on safe terminals", async () => {
		await withTerminalRisk(false, async () => {
			const term = new VirtualTerminal(40, 10);
			overrideProbe(term, undefined);
			const tui = new TUI(term);
			const component = new LineList([...rows("init-", 10), "prompt"]);

			try {
				tui.addChild(component);
				tui.start();
				await settle(term);

				const writes = capture(term);
				tui.setEagerNativeScrollbackRebuild(true);
				component.setLines([...rows("stream-", 10), ...rows("more-", 50), "prompt"]);
				tui.requestRender();
				await settle(term);

				expect(eraseScrollbackCount(writes)).toBe(0);
				expect(
					term
						.getViewport()
						.map(line => line.trim())
						.at(-1),
				).toBe("prompt");
			} finally {
				tui.stop();
			}
		});
	});

	it("does not emit ED3 during streaming on ED3-risk terminals", async () => {
		if (process.platform === "win32") return;
		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(40, 10);
			overrideProbe(term, undefined);
			const tui = new TUI(term);
			const component = new LineList([...rows("init-", 10), "prompt"]);

			try {
				tui.addChild(component);
				tui.start();
				await settle(term);

				const writes = capture(term);

				tui.setEagerNativeScrollbackRebuild(true);
				component.setLines([...rows("grow-", 30), "prompt"]);
				tui.requestRender();
				await settle(term);

				expect(eraseScrollbackCount(writes)).toBe(0);

				tui.setEagerNativeScrollbackRebuild(false);
				tui.requestRender();
				await settle(term);

				expect(eraseScrollbackCount(writes)).toBe(0);
				expect(
					term
						.getViewport()
						.map(line => line.trim())
						.at(-1),
				).toBe("prompt");
			} finally {
				tui.stop();
			}
		});
	});

	describeOnPosix("ED3-risk checkpoint replay", () => {
		it("keeps dirty scrollback when ED3-risk streaming ends without replay", async () => {
			await withTerminalRisk(true, async () => {
				const term = new VirtualTerminal(40, 10);
				overrideProbe(term, undefined);
				const tui = new TUI(term);
				const component = new LineList([...rows("init-", 10), "prompt"]);

				try {
					tui.addChild(component);
					tui.start();
					await settle(term);

					tui.setEagerNativeScrollbackRebuild(true);
					component.setLines([...rows("grow-", 30), "prompt"]);
					tui.requestRender();
					await settle(term);

					tui.setEagerNativeScrollbackRebuild(false);
					tui.requestRender();
					await settle(term);

					const checkpointWrites = capture(term);
					setTerminalRisk(false);

					expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(true);
					expect(eraseScrollbackCount(checkpointWrites)).toBe(1);
				} finally {
					tui.stop();
				}
			});
		});
	});
});
