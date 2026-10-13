/**
 * Whether folding a collapsible card would hide anything. A card whose body
 * already fits its collapsed preview draws the same folded and unfolded, so
 * it should not offer a chevron. Heights are upper bounds: anything this
 * cannot measure (markdown, media, trees, components) counts as able to hide.
 */
import type { NativeChild } from "./node";

/** Narrowest pane the fold check assumes: a wrapping line wider than this may take several lines. */
const FOLD_MIN_COLS = 40;
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

/** Lines `value` draws, counting a wrapping line as wide as {@link FOLD_MIN_COLS}; stops past `limit`. */
function textLines(value: string, wraps: boolean, limit: number): number {
	let lines = 0;
	for (const line of value.split("\n")) {
		lines += wraps ? Math.max(1, Math.ceil(Bun.stringWidth(line) / FOLD_MIN_COLS)) : 1;
		if (lines > limit) break;
	}
	return lines;
}

/** Upper bound on the lines a node draws, or undefined when its height is unknown. */
function nodeLines(child: NativeChild, limit: number): number | undefined {
	if (!("k" in child)) return undefined;
	if (child.p?.hidden === true) return 0;
	switch (child.k) {
		case "col":
			return childLines(child.c, limit, "sum");
		case "row":
			return childLines(child.c, limit, child.p?.wrap === true ? "sum" : "max");
		case "text": {
			const p = child.p;
			const value = p?.text ?? (p?.spans ?? []).map(s => s.t).join("");
			const lines = textLines(value, p?.wrap !== "none" && p?.truncate === undefined, limit);
			return p?.lines !== undefined ? Math.min(p.lines, lines) : lines;
		}
		case "code":
			return textLines(child.p?.text ?? "", child.p?.wrap !== false, limit);
		case "ansi":
			return textLines(child.p?.text ?? "", true, limit);
		default:
			return ONE_LINE_KINDS[child.k] ? 1 : undefined;
	}
}

/** Upper bound on the lines `children` draw stacked (`sum`) or side by side (`max`); stops past `limit`. */
function childLines(
	children: readonly NativeChild[] | undefined,
	limit: number,
	mode: "sum" | "max",
): number | undefined {
	let total = 0;
	for (const child of children ?? []) {
		const lines = nodeLines(child, limit);
		if (lines === undefined) return undefined;
		total = mode === "sum" ? total + lines : Math.max(total, lines);
		if (total > limit) break;
	}
	return total;
}

/** Whether a `code`/`ansi` block under `children` outgrows its own preview (the clamp `children` folding applies). */
function clipsOwnPreview(children: readonly NativeChild[] | undefined): boolean {
	for (const child of children ?? []) {
		if (!("k" in child)) return true;
		if (child.p?.hidden === true) continue;
		if (child.k === "code" || child.k === "ansi") {
			const preview = child.p?.preview;
			if (preview === undefined) continue;
			if (preview === "auto") return true;
			const wraps = child.k === "ansi" || child.p?.wrap !== false;
			if (textLines(child.p?.text ?? "", wraps, preview.lines) > preview.lines) return true;
			continue;
		}
		// A nested card folds on its own; the outer fold does not clamp inside it.
		if (child.k === "card" || child.k === "section" || child.k === "tool") continue;
		if (clipsOwnPreview(child.c)) return true;
	}
	return false;
}

/** Whether collapsing a card with this `body` and `preview` hides any of it. */
export function foldHidesBody(body: readonly NativeChild[], preview: FoldPreview): boolean {
	if (body.length === 0) return false;
	if (preview === "children") return clipsOwnPreview(body);
	if (typeof preview !== "object") return true;
	const clamp = "lines" in preview ? preview.lines : preview.tail;
	const lines = childLines(body, clamp, "sum");
	return lines === undefined || lines > clamp;
}
