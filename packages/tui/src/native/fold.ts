/**
 * Whether folding a collapsible card would hide anything. A card whose body
 * already fits its collapsed preview draws the same folded and unfolded, so
 * it should not offer a chevron. Heights are upper bounds: anything this
 * cannot measure (markdown, media, trees, components, wrapping text of
 * unknown width) counts as able to hide.
 */
import type { NativeChild } from "./node";

/**
 * Cells a card's chrome may take from the surface width (card insets, run box
 * borders, code line numbers); wrapping is measured against what remains.
 */
const FOLD_CHROME_COLS = 16;
/** Leaf kinds that draw on one line (chips, clocks, bars). */
const ONE_LINE_KINDS: Partial<Record<string, true>> = {
	badge: true,
	kbd: true,
	icon: true,
	spinner: true,
	shimmer: true,
	elapsed: true,
	progress: true,
	rate: true,
	meter: true,
	rule: true,
	spacer: true,
};

/** A card's collapsed clamp: a line count (head or tail), the children's own previews, or none (`none`/`auto`/absent). */
export type FoldPreview = { lines: number } | { tail: number } | "children" | "none" | "auto" | undefined;

/**
 * Lines `value` draws when wrapping at `width` cells (stops past `limit`);
 * undefined when a non-empty line wraps at an unknown width. Lines wider than
 * `width` are word-wrapped (hard-breaking long words), which never yields
 * fewer rows than a character wrap, so word-break waste is counted.
 */
function textLines(value: string, wraps: boolean, width: number | undefined, limit: number): number | undefined {
	let lines = 0;
	for (const line of value.split("\n")) {
		if (!wraps) lines++;
		else {
			const cells = Bun.stringWidth(line);
			if (cells > 0 && width === undefined) return undefined;
			lines +=
				width === undefined || cells <= width
					? 1
					: Bun.wrapAnsi(line, width, { hard: true, wordWrap: true, trim: false }).split("\n").length;
		}
		if (lines > limit) break;
	}
	return lines;
}

/** Upper bound on the lines a node draws at `width` cells, or undefined when its height is unknown. */
function nodeLines(child: NativeChild, width: number | undefined, limit: number): number | undefined {
	if (!("k" in child)) return undefined;
	if (child.p?.hidden === true) return 0;
	switch (child.k) {
		case "col":
			return childLines(child.c, width, limit, "sum");
		case "row": {
			// Siblings share the row's width, so a wrapping child's own width is unknown.
			const shared = (child.c?.length ?? 0) > 1 ? undefined : width;
			return childLines(child.c, shared, limit, child.p?.wrap === true ? "sum" : "max");
		}
		case "text": {
			const p = child.p;
			const value = p?.text ?? (p?.spans ?? []).map(s => s.t).join("");
			const lines = textLines(value, p?.wrap !== "none" && p?.truncate === undefined, width, limit);
			if (p?.lines === undefined) return lines;
			return lines === undefined ? p.lines : Math.min(p.lines, lines);
		}
		case "code":
			return textLines(child.p?.text ?? "", child.p?.wrap !== false, width, limit);
		case "ansi":
			return textLines(child.p?.text ?? "", true, width, limit);
		default:
			return ONE_LINE_KINDS[child.k] ? 1 : undefined;
	}
}

/** Upper bound on the lines `children` draw stacked (`sum`) or side by side (`max`); stops past `limit`. */
function childLines(
	children: readonly NativeChild[] | undefined,
	width: number | undefined,
	limit: number,
	mode: "sum" | "max",
): number | undefined {
	let total = 0;
	for (const child of children ?? []) {
		const lines = nodeLines(child, width, limit);
		if (lines === undefined) return undefined;
		total = mode === "sum" ? total + lines : Math.max(total, lines);
		if (total > limit) break;
	}
	return total;
}

/** Whether a `code`/`ansi` block under `children` outgrows its own preview (the clamp `children` folding applies). */
function clipsOwnPreview(children: readonly NativeChild[] | undefined, width: number | undefined): boolean {
	for (const child of children ?? []) {
		if (!("k" in child)) return true;
		if (child.p?.hidden === true) continue;
		if (child.k === "code" || child.k === "ansi") {
			const preview = child.p?.preview;
			if (preview === undefined) continue;
			if (preview === "auto") return true;
			const wraps = child.k === "ansi" || child.p?.wrap !== false;
			const lines = textLines(child.p?.text ?? "", wraps, width, preview.lines);
			if (lines === undefined || lines > preview.lines) return true;
			continue;
		}
		// A nested card folds on its own; the outer fold does not clamp inside it.
		if (child.k === "card" || child.k === "section" || child.k === "tool") continue;
		if (clipsOwnPreview(child.c, child.k === "row" && (child.c?.length ?? 0) > 1 ? undefined : width)) return true;
	}
	return false;
}

/**
 * Whether collapsing a card with this `body` and `preview` hides any of it on
 * a surface `cols` cells wide (undefined: unknown, so any wrapping text may hide).
 */
export function foldHidesBody(body: readonly NativeChild[], preview: FoldPreview, cols: number | undefined): boolean {
	if (body.length === 0) return false;
	const width = cols === undefined ? undefined : Math.max(1, cols - FOLD_CHROME_COLS);
	if (preview === "children") return clipsOwnPreview(body, width);
	if (typeof preview !== "object") return true;
	const clamp = "lines" in preview ? preview.lines : preview.tail;
	const lines = childLines(body, width, clamp, "sum");
	return lines === undefined || lines > clamp;
}
