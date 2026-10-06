import { Text } from "../components/text";
import { ansi } from "../native/describe";
import type { DescribeContext, NativeNode } from "../native/node";
import { ImageProtocol, TERMINAL } from "../terminal-capabilities";
import { getThemeEpoch, type Theme } from "../theme/theme";
import type { Component } from "../tui";
import { getPaddingX, getWidthConfigEpoch, padding, visibleWidth, wrapTextWithAnsi } from "../utils";
import { getSixelLineMask } from "./sixel";
import { formatExpandHint, replaceTabs } from "./render-utils";

/** Which side of an output stream remains visible when the pane is capped. */
export type OutputPaneEdge = "head" | "tail";

/** Inputs for the shared output capping and styling algorithm. */
export interface OutputPaneFormatOptions {
	lines: readonly string[];
	expanded: boolean;
	collapsedMaxLines: number;
	expandedMaxLines?: number;
	edge?: OutputPaneEdge;
	/** Apply the cap after terminal-width wrapping instead of to logical rows. */
	visual?: boolean;
	/** Content width used by visual capping. Required when `visual` is true. */
	width?: number;
	styleLine?: (line: string, index: number) => string;
	/** Keep sixel payload rows byte-for-byte and show the complete payload. */
	uncapSixel?: boolean;
	showHiddenMarker?: boolean;
	showExpandHint?: boolean;
	showExpandHintWhenUncapped?: boolean;
	formatHidden?: (hidden: number, shown: number, total: number, edge: OutputPaneEdge) => string;
}

/** Result of formatting one bounded output pane. */
export interface OutputPaneFormatResult {
	lines: readonly string[];
	hiddenCount: number;
	hasSixel: boolean;
}

/**
 * Split terminal text without allowing carriage-return progress updates to
 * corrupt following TUI rows. The final segment after a bare CR wins, matching
 * a terminal cursor-return overwrite.
 */
export function splitTerminalOutputLines(text: string): string[] {
	return text.split(/\r?\n/u).map(line => {
		const carriageReturn = line.lastIndexOf("\r");
		return carriageReturn < 0 ? line : line.slice(carriageReturn + 1);
	});
}

function defaultHiddenLabel(hidden: number, shown: number, total: number, edge: OutputPaneEdge): string {
	return edge === "tail"
		? `… (${hidden} earlier lines, showing ${shown} of ${total})`
		: `… ${hidden} more line${hidden === 1 ? "" : "s"}`;
}

/**
 * Visual-row tail cap that styles and wraps only the trailing logical rows
 * needed to fill `limit` rows (each logical row wraps to at least one).
 * `hiddenCount` counts logical rows not fully shown. Rows match a `Text`
 * render of the window: tabs expanded, padded to `width`.
 */
function formatVisualTail(
	total: number,
	styleAt: (index: number) => string,
	limit: number,
	width: number,
): { lines: string[]; hiddenCount: number } {
	const window: string[] = [];
	let start = total;
	let rowCount = 0;
	while (start > 0 && rowCount < limit) {
		start--;
		const line = replaceTabs(styleAt(start));
		window.push(line);
		rowCount += wrapTextWithAnsi(line, width).length;
	}
	window.reverse();
	const windowText = window.join("\n");
	if (windowText.trim() === "") {
		// A blank stream renders nothing, matching an empty `Text`.
		let index = start - 1;
		while (index >= 0 && styleAt(index).trim() === "") index--;
		if (index < 0) return { lines: [], hiddenCount: 0 };
	}
	// Re-wrap the window as one text so SGR state carries across its rows.
	const wrapped = wrapTextWithAnsi(windowText, width);
	const skippedRows = Math.max(0, wrapped.length - limit);
	const lines: string[] = [];
	for (let index = skippedRows; index < wrapped.length; index++) {
		const row = wrapped[index]!;
		lines.push(row + padding(width - visibleWidth(row)));
	}
	return { lines, hiddenCount: start + (skippedRows > 0 ? 1 : 0) };
}

/**
 * Style and cap output rows for code cells, tool cards, and live execution
 * panes. Sixel rows are never styled or split; with `uncapSixel`, the complete
 * payload is retained so terminal image protocols remain valid.
 */
export function formatOutputPaneLines(options: OutputPaneFormatOptions, theme: Theme): OutputPaneFormatResult {
	const edge = options.edge ?? "head";
	const rawLines = options.lines;
	const total = rawLines.length;
	const sixelMask =
		TERMINAL.imageProtocol === ImageProtocol.Sixel && total > 0 ? getSixelLineMask(rawLines) : undefined;
	const hasSixel = sixelMask?.some(Boolean) ?? false;
	// Styling runs only on rows that can become visible; `index` stays the
	// row's position in the full stream.
	const styleLine = options.styleLine;
	const styleAt = (index: number): string => {
		const line = rawLines[index]!;
		return sixelMask?.[index] || !styleLine ? line : (styleLine(line, index) ?? line);
	};
	const styleRange = (start: number, end: number): string[] => {
		const styled: string[] = [];
		for (let index = start; index < end; index++) styled.push(styleAt(index));
		return styled;
	};

	const configuredLimit = options.expanded ? options.expandedMaxLines : options.collapsedMaxLines;
	const limit = hasSixel && options.uncapSixel ? undefined : configuredLimit;
	let lines: string[];
	let hiddenCount = 0;

	if (limit === undefined || !Number.isFinite(limit)) {
		lines = styleRange(0, total);
	} else {
		const boundedLimit = Math.max(0, Math.floor(limit));
		const width = Math.max(1, options.width ?? 1);
		if (boundedLimit === 0) {
			lines = [];
			hiddenCount = total;
		} else if (options.visual && edge === "tail") {
			({ lines, hiddenCount } = formatVisualTail(total, styleAt, boundedLimit, width));
		} else if (options.visual) {
			const rendered = new Text(styleRange(0, total).join("\n"), 0, 0).render(width);
			lines = rendered.slice(0, boundedLimit);
			hiddenCount = Math.max(0, rendered.length - lines.length);
		} else if (total > boundedLimit) {
			hiddenCount = total - boundedLimit;
			lines = edge === "tail" ? styleRange(total - boundedLimit, total) : styleRange(0, boundedLimit);
		} else {
			lines = styleRange(0, total);
		}
	}

	if (hiddenCount > 0 && options.showHiddenMarker !== false) {
		const label = (options.formatHidden ?? defaultHiddenLabel)(
			hiddenCount,
			lines.length,
			hiddenCount + lines.length,
			edge,
		);
		const hint = options.showExpandHint === false ? "" : formatExpandHint(theme, options.expanded, true);
		const marker = theme.fg("dim", `${label}${hint ? ` ${hint}` : ""}`);
		if (edge === "tail") lines.unshift(marker);
		else lines.push(marker);
	} else if (!options.expanded && options.showExpandHintWhenUncapped) {
		const hint = formatExpandHint(theme, false, true);
		if (hint) lines.push(hint);
	}

	return { lines, hiddenCount, hasSixel };
}

/** Display policy for {@link describeOutputLines}. */
export interface NativeOutputOptions {
	expanded: boolean;
	collapsedMaxLines: number;
	expandedMaxLines?: number;
	edge?: OutputPaneEdge;
	key?: string;
}

/**
 * Raw output rows as a native `ansi` mini-terminal: the terminal wraps and
 * styles them. The row cap becomes a `preview` clamp (with its own "N more"
 * affordance); a tail edge follows the stream.
 */
export function describeOutputLines(lines: readonly string[], options: NativeOutputOptions): NativeNode {
	return describeOutputText(lines.join("\n"), options);
}

function describeOutputText(text: string, options: NativeOutputOptions): NativeNode {
	const limit = options.expanded ? options.expandedMaxLines : options.collapsedMaxLines;
	const preview =
		limit !== undefined && Number.isFinite(limit) ? { lines: Math.max(0, Math.floor(limit)) } : undefined;
	const described = ansi(text, { follow: options.edge === "tail" ? true : undefined, preview });
	return options.key === undefined ? described : { ...described, key: options.key };
}

/** Mutable options for a live {@link OutputPane}. */
export interface OutputPaneOptions extends Omit<OutputPaneFormatOptions, "lines"> {
	paddingX?: number;
	leadingBlank?: boolean;
	maxStoredLines?: number;
	/** Normalize each logical row before it enters the retained stream. */
	normalizeLine?: (line: string) => string;
}

/**
 * Stateful, cached output viewport. Streaming callers append chunks while
 * settled callers may replace all rows. Renders are memoized on a content
 * version plus width and theme/width-config epochs, so unchanged frames do
 * no formatting work and preserve array identity.
 */
export class OutputPane implements Component {
	readonly #theme: Theme;
	#options: OutputPaneOptions;
	#lines: string[] = [];
	// `#lines` minus its last row, joined by "\n"; extended incrementally as
	// rows complete so streamed text is never re-joined. `undefined` = stale.
	#head: string | undefined;
	#pendingCarriageReturn = false;
	#text: Text;
	// Bumped by every content or presentation change.
	#version = 0;
	#renderedVersion = -1;
	#renderedWidth = -1;
	#renderedContentWidth = -1;
	#renderedThemeEpoch = -1;
	#renderedWidthEpoch = -1;
	#native: NativeNode | undefined;

	constructor(theme: Theme, options: OutputPaneOptions, text = "") {
		this.#theme = theme;
		this.#options = { ...options };
		this.#text = new Text("", options.paddingX ?? 0, 0);
		if (text) this.setText(text);
	}

	/** Replace the complete output snapshot. */
	setText(text: string): void {
		this.setLines(text ? splitTerminalOutputLines(text) : []);
	}

	/** Replace the complete output snapshot with caller-owned immutable rows. */
	setLines(lines: readonly string[]): void {
		const normalizeLine = this.#options.normalizeLine;
		this.#lines = normalizeLine ? lines.map(line => normalizeLine(line)) : [...lines];
		this.#head = undefined;
		this.#clampStoredLines();
		this.#pendingCarriageReturn = false;
		this.invalidate();
	}

	/**
	 * Append a streaming chunk. Bare CR overwrites the current logical row;
	 * a CRLF split across chunks remains a newline, so chunked and whole-text
	 * ingestion produce the same settled rows.
	 */
	append(chunk: string): void {
		if (!chunk) return;
		let index = 0;
		if (this.#pendingCarriageReturn) {
			this.#pendingCarriageReturn = false;
			if (chunk[0] === "\n") {
				this.#startLine();
				index = 1;
			} else {
				this.#replaceTail("");
			}
		}

		let segmentStart = index;
		while (index < chunk.length) {
			const char = chunk[index];
			if (char !== "\r" && char !== "\n") {
				index++;
				continue;
			}
			this.#appendToTail(chunk.slice(segmentStart, index));
			if (char === "\n") {
				this.#startLine();
			} else if (index + 1 < chunk.length) {
				if (chunk[index + 1] === "\n") {
					this.#startLine();
					index++;
				} else {
					this.#replaceTail("");
				}
			} else {
				this.#pendingCarriageReturn = true;
			}
			index++;
			segmentStart = index;
		}
		this.#appendToTail(chunk.slice(segmentStart));
		this.#clampStoredLines();
		this.invalidate();
	}

	/** Settle a trailing bare carriage return once no later LF can pair with it. */
	finish(): void {
		if (!this.#pendingCarriageReturn) return;
		this.#pendingCarriageReturn = false;
		this.#replaceTail("");
		this.invalidate();
	}

	/** Update presentation without replacing streamed content. */
	configure(options: Partial<OutputPaneOptions>): void {
		const previousPadding = this.#options.paddingX ?? 0;
		this.#options = { ...this.#options, ...options };
		const nextPadding = this.#options.paddingX ?? 0;
		if (previousPadding !== nextPadding) this.#text = new Text("", nextPadding, 0);
		this.#clampStoredLines();
		this.invalidate();
	}

	setExpanded(expanded: boolean): void {
		if (this.#options.expanded === expanded) return;
		this.#options = { ...this.#options, expanded };
		this.invalidate();
	}

	get lineCount(): number {
		return this.#lines.length;
	}

	get hasSixel(): boolean {
		if (TERMINAL.imageProtocol !== ImageProtocol.Sixel || this.#lines.length === 0) return false;
		return getSixelLineMask(this.#lines).some(Boolean);
	}

	getText(): string {
		const lines = this.#lines;
		if (lines.length <= 1) return lines[0] ?? "";
		this.#head ??= lines.slice(0, -1).join("\n");
		return `${this.#head}\n${lines[lines.length - 1]}`;
	}

	/** The retained rows as an `ansi` node; streamed appends grow its text, so the reconciler sends `text append`. */
	describe(_cx: DescribeContext): NativeNode {
		this.#native ??= describeOutputText(this.getText(), {
			expanded: this.#options.expanded,
			collapsedMaxLines: this.#options.collapsedMaxLines,
			expandedMaxLines: this.#options.expandedMaxLines,
			edge: this.#options.edge,
		});
		return this.#native;
	}

	render(width: number): readonly string[] {
		const paddingX = getPaddingX(this.#options.paddingX ?? 0);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const themeEpoch = getThemeEpoch();
		const widthEpoch = getWidthConfigEpoch();
		if (
			this.#renderedVersion !== this.#version ||
			this.#renderedWidth !== width ||
			this.#renderedContentWidth !== contentWidth ||
			this.#renderedThemeEpoch !== themeEpoch ||
			this.#renderedWidthEpoch !== widthEpoch
		) {
			const formatted = formatOutputPaneLines(
				{
					...this.#options,
					lines: this.#lines,
					width: contentWidth,
				},
				this.#theme,
			);
			this.#text.setText(
				`${this.#options.leadingBlank && formatted.lines.length > 0 ? "\n" : ""}${formatted.lines.join("\n")}`,
			);
			this.#renderedVersion = this.#version;
			this.#renderedWidth = width;
			this.#renderedContentWidth = contentWidth;
			this.#renderedThemeEpoch = themeEpoch;
			this.#renderedWidthEpoch = widthEpoch;
		}
		return this.#text.render(width);
	}

	invalidate(): void {
		this.#version++;
		this.#native = undefined;
		this.#text.invalidate();
	}

	#appendToTail(text: string): void {
		if (!text) return;
		if (this.#lines.length === 0) this.#lines.push("");
		const last = this.#lines.length - 1;
		this.#replaceTail(`${this.#lines[last]}${text}`);
	}

	#replaceTail(text: string): void {
		const normalizeLine = this.#options.normalizeLine;
		const normalized = normalizeLine ? normalizeLine(text) : text;
		if (this.#lines.length === 0) this.#lines.push(normalized);
		else this.#lines[this.#lines.length - 1] = normalized;
	}

	#startLine(): void {
		const lines = this.#lines;
		if (lines.length === 0) lines.push("");
		// The completed row joins the head; it is no longer the mutable tail.
		if (lines.length === 1) this.#head = lines[0];
		else if (this.#head !== undefined) this.#head = `${this.#head}\n${lines[lines.length - 1]}`;
		lines.push("");
	}

	#clampStoredLines(): void {
		const maxStoredLines = this.#options.maxStoredLines;
		if (maxStoredLines === undefined || this.#lines.length <= maxStoredLines) return;
		const boundedMax = Math.max(0, Math.floor(maxStoredLines));
		this.#lines = boundedMax === 0 ? [] : this.#lines.slice(-boundedMax);
		this.#head = undefined;
	}
}

/** Default styling for plain tool output while preserving existing ANSI. */
export function styleToolOutputLine(line: string, theme: Theme): string {
	const normalized = replaceTabs(line);
	return normalized.includes("\x1b[") ? normalized : theme.fg("toolOutput", normalized);
}
