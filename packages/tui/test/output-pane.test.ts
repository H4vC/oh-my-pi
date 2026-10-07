import { beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { EvalExecutionComponent } from "@oh-my-pi/pi-tui/chat/eval-execution";
import { formatOutputPaneLines, OutputPane } from "@oh-my-pi/pi-tui/render/output-pane";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";

let theme: Theme;

beforeAll(async () => {
	theme = (await getThemeByName("dark"))!;
	setThemeInstance(theme);
});

describe("OutputPane", () => {
	it("keeps getText equal to the settled stream across chunked CR/LF appends and clamping", () => {
		const pane = new OutputPane(theme, { expanded: false, collapsedMaxLines: 3, maxStoredLines: 4 });
		for (const chunk of ["a\nb", "\r", "\nc\rC", "\n", "d\ne\nf", "\r", "g"]) {
			pane.append(chunk);
			pane.getText();
		}
		pane.finish();
		expect(pane.getText()).toBe("C\nd\ne\ng");
		pane.configure({ maxStoredLines: undefined });
		pane.append("\nh");
		expect(pane.getText()).toBe("C\nd\ne\ng\nh");
	});

	it("re-renders after an append even when the width is unchanged", () => {
		const pane = new OutputPane(theme, {
			expanded: false,
			collapsedMaxLines: 2,
			edge: "tail",
			visual: true,
			showHiddenMarker: false,
		});
		pane.append("one\ntwo");
		expect(pane.render(20).map(row => row.trimEnd())).toEqual(["one", "two"]);
		pane.append("\nthree");
		expect(pane.render(20).map(row => row.trimEnd())).toEqual(["two", "three"]);
	});
});

describe("formatOutputPaneLines visual tail", () => {
	it("counts hidden logical rows, including a partially shown one", () => {
		const result = formatOutputPaneLines(
			{
				lines: ["first", "second", "x".repeat(25)],
				expanded: false,
				collapsedMaxLines: 2,
				edge: "tail",
				visual: true,
				width: 10,
				showHiddenMarker: false,
			},
			theme,
		);
		expect(result.lines.map(row => row.trimEnd())).toEqual(["x".repeat(10), "x".repeat(5)]);
		expect(result.hiddenCount).toBe(3);
	});

	it("carries SGR state opened on a hidden row into the visible tail", () => {
		const result = formatOutputPaneLines(
			{
				lines: ["\x1b[31mred starts", "still red", "red ends\x1b[0m"],
				expanded: false,
				collapsedMaxLines: 1,
				edge: "tail",
				visual: true,
				width: 20,
				showHiddenMarker: false,
			},
			theme,
		);
		expect(result.lines).toHaveLength(1);
		expect(result.lines[0]!.startsWith("\x1b[31m")).toBe(true);
		expect(Bun.stripANSI(result.lines[0]!).trimEnd()).toBe("red ends");
	});
});

describe("EvalExecutionComponent", () => {
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	it("keeps every row when a transcript rebuild appends settled output", () => {
		const output = Array.from({ length: 200 }, (_, index) => `row ${index}`).join("\n");
		const cell = new EvalExecutionComponent("print(1)", ui);
		cell.appendOutput(output);
		cell.setComplete(0, false);
		expect(cell.getOutput()).toBe(output);
	});

	it("keeps every streamed row when a cell that rendered mid-stream fails", () => {
		const output = Array.from({ length: 200 }, (_, index) => `row ${index}`).join("\n");
		const cell = new EvalExecutionComponent("print(1)", ui);
		cell.appendOutput(output);
		cell.render(80);
		cell.setComplete(undefined, false);
		expect(cell.getOutput()).toBe(output);
	});
});
