/**
 * Artifact browser: one session's artifacts directory (spilled tool output,
 * subagent results and transcripts, `local://` files) as a native Tern `prefs`
 * page. Over a live session the page docks at the pane's right edge with the
 * transcript beside it, exactly like `/settings`, and Tern draws it in omp's
 * theme.
 *
 * Pages are the artifact kinds, rows the files (URL, size and age as the
 * hint). The page shows no file contents: the selected file always shows in a
 * Tern block beside the pane (the host's `show`), following the selection,
 * and a double click or Enter opens it in a new block of its own. Images also
 * get thumbnails in a gallery after the list. Typing searches every kind;
 * `ctrl+y` copies the selected file's URL; `esc` leaves the search, then
 * closes the page.
 */
import * as path from "node:path";
import { formatBytes } from "@oh-my-pi/pi-utils";
import type { TspPrefsProps, TspPrefsRow } from "@oh-my-pi/pi-wire";
import { Input } from "../components/input";
import { matchesKey } from "../keys";
import { registerNativeBlob } from "../native/blobs";
import { card, col, node, span } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { pickerAge } from "../native/picker";
import type { ImageDimensions } from "../terminal-capabilities";
import type { Component } from "../tui";

/** One file under the session's artifacts directory. */
export interface ArtifactEntry {
	/** Stable id within the session (the relative path). */
	id: string;
	/** Kind the entry is listed under ("Tool output", "Subagents", …); one page each. */
	group: string;
	label: string;
	/** Addressable URL (`artifact://3`, `agent://Foo`, `local://x.md`), when one exists. */
	url?: string;
	path: string;
	size: number;
	mtime: number;
	/** Nesting depth for nested subagent output. */
	depth?: number;
	/** An image file: it gets a thumbnail in the gallery. */
	image?: boolean;
}

/** An image artifact's bytes for its thumbnail; `size` is the pixel size when the header was readable. */
export interface ArtifactImage {
	bytes: Uint8Array;
	mime: string;
	size?: ImageDimensions;
}

/** Filesystem and terminal capabilities the browser drives, bound to one session. */
export interface ArtifactBrowserHost {
	/** The session's name, for the page lead. */
	readonly sessionLabel: string;
	listEntries(): Promise<ArtifactEntry[]>;
	/** The image's bytes for a thumbnail, or undefined when it cannot be shown. */
	loadImage(entry: ArtifactEntry): Promise<ArtifactImage | undefined>;
	/** Show the entry in the Tern block beside the browser that follows the selection, keeping focus here. */
	show(entry: ArtifactEntry): Promise<void>;
	/** Open the entry in a new Tern block of its own. */
	open(entry: ArtifactEntry): Promise<void>;
	copy(text: string): Promise<void>;
}

/** Callbacks wiring the component into its TUI. */
export interface ArtifactBrowserOptions {
	host: ArtifactBrowserHost;
	onUpdate: () => void;
	onExit: () => void;
}

const REFRESH_MS = 2_000;
/** The beside block follows the selection once it rests this long (holding ↓ doesn't spawn a `tern` per row). */
const SHOW_SETTLE_MS = 120;
/**
 * Two clicks on one row this close together open it: a `prefs` row reports
 * each click as `select` (it has no double-click event of its own).
 */
const DOUBLE_CLICK_MS = 450;
/**
 * Image thumbnails the gallery shows. A `prefs` row has no image slot, so the
 * images sit as tiles in the page's extra content, after its sections.
 */
const MAX_THUMBS = 24;
const THUMB_WIDTH = "18ch";
const THUMB_HEIGHT = "6lines";
/** A gallery tile's click action (select its image), sent back as an `action` event from the tile's keypath. */
const SELECT_ACTION = "artifact.select";
/** A gallery image's double-click action: open the image in a new Tern block, like its row's double click. */
const OPEN_ACTION = "artifact.open";
/** Key prefix of gallery tiles: `${TILE_KEY}${index}` into the gallery's entries. */
const TILE_KEY = "img";
/** Page icons, from the ones `/settings` and the advisor page use: the docked sheet shows pages as an icon strip. */
const PAGE_ICONS: Record<string, string> = {
	"Tool output": "shell",
	Subagents: "tasks",
	Local: "files",
	Other: "doc",
};
const NOT_NATIVE = ["The artifact browser needs Tern (Tern Surface Protocol). Press esc to close."];

const DAY_MS = 86_400_000;

/** The day group of a modification time, relative to local midnight today (newest-first lists stay contiguous). */
function dayBucket(mtime: number, midnight: number): { id: string; title: string } {
	if (mtime >= midnight) return { id: "today", title: "Today" };
	if (mtime >= midnight - DAY_MS) return { id: "yesterday", title: "Yesterday" };
	if (mtime >= midnight - 6 * DAY_MS) return { id: "week", title: "This week" };
	return { id: "earlier", title: "Earlier" };
}

/** Identity of an entry's current contents: its id at its mtime. */
function entryState(entry: ArtifactEntry): string {
	return `${entry.id}\n${entry.mtime}`;
}

/** Signature of a listing, so a poll that found nothing new keeps every cached node. */
function listingSignature(entries: readonly ArtifactEntry[]): string {
	let sig = "";
	for (const entry of entries) sig += `${entry.id}:${entry.size}:${entry.mtime}\n`;
	return sig;
}

/** A gallery thumbnail: the image small; a click selects it, a double click opens it in a new Tern block. */
function thumbnailNode(entry: ArtifactEntry, image: ArtifactImage): NativeNode {
	return node("image", {
		blob: registerNativeBlob(image.bytes, image.mime),
		alt: entry.label,
		...(image.size ? { w: image.size.widthPx, h: image.size.heightPx } : {}),
		max: { w: THUMB_WIDTH, h: THUMB_HEIGHT },
		actions: { click: SELECT_ACTION, dblclick: OPEN_ACTION },
	});
}

/**
 * One gallery tile: the thumbnail over its name. Tern draws no selection or
 * hover state for cards and images in a `prefs` page, so the selected image's
 * name carries it: the row cursor's `❯` in the accent, then the name in bold.
 */
function galleryTile(entry: ArtifactEntry, thumbnail: NativeNode, selected: boolean): NativeNode {
	return card({ inset: true }, [
		col(
			[
				thumbnail,
				node("text", {
					spans: selected
						? [span("❯ ", "accent strong"), span(path.basename(entry.label), "strong")]
						: [span(path.basename(entry.label), "link")],
					truncate: "middle",
					lines: 1,
					actions: { click: SELECT_ACTION },
				}),
			],
			{ gap: "xs", max: { w: THUMB_WIDTH } },
		),
	]);
}

export class ArtifactBrowserComponent implements Component {
	readonly #opts: ArtifactBrowserOptions;
	readonly #search = new Input();
	#entries: ArtifactEntry[] = [];
	#signature = "";
	/** Entries the search matches (all of them while not searching). */
	#matches: ArtifactEntry[] = [];
	#page: string | undefined;
	#selectedId: string | undefined;
	#loading = true;
	#notice: { text: string; tone: "success" | "error" } | undefined;
	/** The entry state the beside block shows (or was last asked to). */
	#shown: string | undefined;
	#showTimer: NodeJS.Timeout | undefined;
	#refreshTimer: NodeJS.Timeout | undefined;
	/** Gallery thumbnails by entry id, for the mtime they were read at (undefined: could not be read). */
	#thumbs = new Map<string, { mtime: number; node: NativeNode | undefined }>();
	#thumbsLoading = new Set<string>();
	/** Entry ids of the gallery's tiles as last described, by tile index. */
	#galleryIds: string[] = [];
	/** The last row click, to tell a double click (see {@link DOUBLE_CLICK_MS}). */
	#lastClick: { id: string; at: number } | undefined;
	#disposed = false;
	#version = 0;
	#native: { version: number; node: NativeNode } | undefined;

	constructor(opts: ArtifactBrowserOptions) {
		this.#opts = opts;
		this.#search.prompt = "";
		void this.#refresh().then(() => {
			this.#loading = false;
			this.#changed();
		});
		this.#refreshTimer = setInterval(() => void this.#refresh(), REFRESH_MS);
	}

	dispose(): void {
		this.#disposed = true;
		clearInterval(this.#refreshTimer);
		clearTimeout(this.#showTimer);
	}

	// ── data ────────────────────────────────────────────────────────────────

	get #searching(): boolean {
		return this.#search.getValue().trim().length > 0;
	}

	/** The rows the keyboard walks: every match while searching, else the current page's. */
	get #rows(): ArtifactEntry[] {
		return this.#searching ? this.#matches : this.#entries.filter(entry => entry.group === this.#page);
	}

	get #selected(): ArtifactEntry | undefined {
		return this.#entries.find(entry => entry.id === this.#selectedId);
	}

	#changed(): void {
		this.#version++;
		if (!this.#disposed) this.#opts.onUpdate();
	}

	async #refresh(): Promise<void> {
		if (this.#disposed) return;
		let entries: ArtifactEntry[];
		try {
			entries = await this.#opts.host.listEntries();
		} catch (error) {
			this.#notice = { text: error instanceof Error ? error.message : String(error), tone: "error" };
			this.#changed();
			return;
		}
		const signature = listingSignature(entries);
		if (signature === this.#signature) return;
		this.#signature = signature;
		this.#entries = entries;
		this.#applySearch();
		this.#followSelection(true);
		this.#changed();
	}

	#applySearch(): void {
		const tokens = this.#search.getValue().toLowerCase().split(/\s+/).filter(Boolean);
		this.#matches =
			tokens.length === 0
				? this.#entries
				: this.#entries.filter(entry => {
						const hay = `${entry.label} ${entry.url ?? ""} ${entry.id}`.toLowerCase();
						return tokens.every(token => hay.includes(token));
					});
		if (!this.#page || !this.#entries.some(entry => entry.group === this.#page)) this.#page = this.#entries[0]?.group;
		const rows = this.#rows;
		if (!rows.some(entry => entry.id === this.#selectedId)) this.#selectedId = rows[0]?.id;
	}

	/** Select `id`; `immediate` (a click) shows it beside at once, arrow keys wait for the selection to rest. */
	#select(id: string | undefined, immediate = false): void {
		const entry = this.#entries.find(candidate => candidate.id === id);
		if (!entry) return;
		this.#selectedId = entry.id;
		if (!this.#searching) this.#page = entry.group;
		this.#followSelection(immediate);
	}

	#moveBy(delta: number): void {
		const rows = this.#rows;
		if (rows.length === 0) return;
		const index = rows.findIndex(entry => entry.id === this.#selectedId);
		this.#select(rows[Math.max(0, Math.min(rows.length - 1, (index < 0 ? 0 : index) + delta))]?.id);
	}

	#showPage(page: string): void {
		if (this.#searching) {
			this.#search.setValue("");
			this.#applySearch();
		}
		this.#page = page;
		this.#selectedId = this.#entries.find(entry => entry.group === page)?.id;
		this.#followSelection();
	}

	#cyclePage(delta: number): void {
		const pages = this.#pageIds();
		if (pages.length < 2) return;
		const index = pages.indexOf(this.#page ?? "");
		this.#showPage(pages[(index + delta + pages.length) % pages.length]!);
	}

	#pageIds(): string[] {
		const pages: string[] = [];
		for (const entry of this.#entries) if (!pages.includes(entry.group)) pages.push(entry.group);
		return pages;
	}

	/**
	 * Keep the beside block on the selection: at once for a click (or the
	 * first selection), after it rests {@link SHOW_SETTLE_MS} for arrow keys;
	 * a file that changed since it was shown is shown again.
	 */
	#followSelection(immediate = false): void {
		this.#loadThumbs();
		const entry = this.#selected;
		if (!entry) return;
		const state = entryState(entry);
		if (this.#shown === state) return;
		clearTimeout(this.#showTimer);
		const show = (): void => {
			if (this.#disposed || this.#selected?.id !== entry.id) return;
			this.#shown = state;
			void this.#opts.host.show(entry).catch((error: unknown) => {
				this.#notice = { text: error instanceof Error ? error.message : String(error), tone: "error" };
				this.#changed();
			});
		};
		if (immediate || this.#shown === undefined) show();
		else this.#showTimer = setTimeout(show, SHOW_SETTLE_MS);
	}

	/** The image entries the gallery shows: every page's, so it doubles as navigation, newest first. */
	#galleryEntries(): ArtifactEntry[] {
		return this.#entries.filter(entry => entry.image).slice(0, MAX_THUMBS);
	}

	/** Read the gallery's images that have no thumbnail for their current mtime yet. */
	#loadThumbs(): void {
		for (const entry of this.#galleryEntries()) {
			if (this.#thumbs.get(entry.id)?.mtime === entry.mtime || this.#thumbsLoading.has(entry.id)) continue;
			this.#thumbsLoading.add(entry.id);
			void this.#opts.host
				.loadImage(entry)
				.catch(() => undefined)
				.then(image => {
					this.#thumbsLoading.delete(entry.id);
					this.#thumbs.set(entry.id, { mtime: entry.mtime, node: image && thumbnailNode(entry, image) });
					this.#changed();
				});
		}
	}

	/** The gallery entry whose tile holds the node at `keypath`. */
	#tileEntry(keypath: string): ArtifactEntry | undefined {
		const tile = keypath
			.split("/")
			.map(segment => /^\^?img(\d+)$/.exec(segment))
			.find(match => match !== null);
		const id = tile ? this.#galleryIds[Number(tile[1])] : undefined;
		return this.#entries.find(entry => entry.id === id);
	}

	/** A gallery tile's click: select its image (leaving a search that hides it), showing it beside. */
	#selectFromGallery(entry: ArtifactEntry): void {
		if (this.#searching && !this.#matches.some(match => match.id === entry.id)) {
			this.#search.setValue("");
			this.#applySearch();
		}
		this.#notice = undefined;
		this.#select(entry.id, true);
		this.#changed();
	}

	async #run(action: "open" | "copy", id?: string): Promise<void> {
		if (id) this.#select(id, true);
		const entry = this.#selected;
		if (!entry) return;
		try {
			if (action === "copy") {
				const value = entry.url ?? entry.path;
				await this.#opts.host.copy(value);
				this.#notice = { text: `Copied ${value}`, tone: "success" };
			} else {
				await this.#opts.host.open(entry);
				this.#notice = undefined;
			}
		} catch (error) {
			this.#notice = { text: error instanceof Error ? error.message : String(error), tone: "error" };
		}
		this.#changed();
	}

	// ── input ───────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		this.#notice = undefined;
		if (matchesKey(data, "ctrl+c")) return this.#opts.onExit();
		if (matchesKey(data, "escape")) {
			if (!this.#searching) return this.#opts.onExit();
			this.#search.setValue("");
			this.#applySearch();
			this.#followSelection();
		} else if (matchesKey(data, "up")) this.#moveBy(-1);
		else if (matchesKey(data, "down")) this.#moveBy(1);
		else if (matchesKey(data, "pageUp")) this.#moveBy(-10);
		else if (matchesKey(data, "pageDown")) this.#moveBy(10);
		else if (matchesKey(data, "tab")) this.#cyclePage(1);
		else if (matchesKey(data, "shift+tab")) this.#cyclePage(-1);
		else if (matchesKey(data, "enter")) void this.#run("open");
		else if (matchesKey(data, "ctrl+y")) void this.#run("copy");
		else {
			const before = this.#search.getValue();
			this.#search.handleInput(data);
			if (this.#search.getValue() !== before) {
				this.#applySearch();
				this.#followSelection();
			}
		}
		this.#changed();
	}

	/**
	 * Pointer actions run the keys' paths: a page click shows that kind
	 * (leaving a search), a row or gallery click selects it (shown beside, like
	 * the arrows), a double click opens it in a new Tern block (Enter), and
	 * closing the page closes it (Esc).
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && (event.act === SELECT_ACTION || event.act === OPEN_ACTION)) {
			const entry = this.#tileEntry(event.key);
			if (entry && event.act === SELECT_ACTION) this.#selectFromGallery(entry);
			else if (entry) void this.#run("open", entry.id);
			return;
		}
		if (event.key !== "") return;
		this.#notice = undefined;
		switch (event.type) {
			case "action":
				if (event.act === "page" && event.value) this.#showPage(event.value);
				else if (event.act === "close") this.#opts.onExit();
				break;
			case "select": {
				const now = Date.now();
				const last = this.#lastClick;
				if (last?.id === event.item && now - last.at <= DOUBLE_CLICK_MS) {
					this.#lastClick = undefined;
					void this.#run("open", event.item);
				} else {
					this.#lastClick = { id: event.item, at: now };
					this.#select(event.item, true);
				}
				break;
			}
			case "activate":
				void this.#run("open", event.item);
				break;
			default:
				return;
		}
		this.#changed();
	}

	// ── native ──────────────────────────────────────────────────────────────

	/** Docks as a side sheet beside the transcript, like `/settings`, when the terminal draws `prefs` with `aside`. */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("prefs") && cx.feature("aside");
	}

	describe(cx: DescribeContext): NativeNode | null {
		if (!cx.supports("prefs")) return null;
		if (this.#native?.version === this.#version) return this.#native.node;
		const described = this.#describePrefs();
		this.#native = { version: this.#version, node: described };
		return described;
	}

	#row(entry: ArtifactEntry, now: number): TspPrefsRow {
		const facts = [entry.url, formatBytes(entry.size), pickerAge(entry.mtime, now)].filter(Boolean);
		return {
			id: entry.id,
			label: `${"  ".repeat(entry.depth ?? 0)}${entry.label}`,
			hint: facts.join(" · "),
		};
	}

	/**
	 * The sections of the page. While searching, one per kind with matches
	 * (titled by kind, under Tern's search heading); otherwise the page's
	 * files by day, since Tern's page heading already names the kind.
	 */
	#sections(now: number): TspPrefsProps["sections"][number][] {
		if (this.#searching) {
			return this.#pageIds().flatMap(id => {
				const entries = this.#matches.filter(entry => entry.group === id);
				return entries.length > 0
					? [{ id, title: id, page: id, rows: entries.map(entry => this.#row(entry, now)) }]
					: [];
			});
		}
		const midnight = new Date(now).setHours(0, 0, 0, 0);
		const sections: { id: string; title: string; rows: TspPrefsRow[] }[] = [];
		for (const entry of this.#entries) {
			if (entry.group !== this.#page) continue;
			const day = dayBucket(entry.mtime, midnight);
			const row = this.#row(entry, now);
			const last = sections.at(-1);
			if (last?.id === day.id) last.rows.push(row);
			else sections.push({ ...day, rows: [row] });
		}
		return sections;
	}

	#describePrefs(): NativeNode {
		const now = Date.now();
		// Labels carry no count: Tern's eyebrow over the page heading already counts the rows.
		const pages: TspPrefsProps["pages"][number][] = this.#pageIds().map(id => ({
			id,
			label: id,
			icon: PAGE_ICONS[id] ?? "doc",
		}));
		const searching = this.#searching;
		// The lead only speaks up when there is something to say: loading, a notice, or nothing to list.
		const lead = this.#loading
			? "Loading artifacts…"
			: (this.#notice?.text ??
				(this.#entries.length === 0 ? `${this.#opts.host.sessionLabel} has no artifacts yet.` : undefined));
		const props: TspPrefsProps = {
			title: "Artifacts",
			pages,
			page: this.#page ?? "",
			lead: searching ? undefined : lead,
			query: searching ? this.#search.getValue() : undefined,
			cursor: searching ? this.#search.getCursor() : undefined,
			sections: this.#sections(now),
			focus: this.#selectedId ?? null,
		};
		const children: NativeChild[] = [];
		const gallery = this.#galleryEntries();
		this.#galleryIds = gallery.map(entry => entry.id);
		const tiles = gallery.flatMap((entry, index) => {
			const thumbnail = this.#thumbs.get(entry.id)?.node;
			if (!thumbnail) return [];
			return [{ ...galleryTile(entry, thumbnail, entry.id === this.#selectedId), key: `${TILE_KEY}${index}` }];
		});
		if (tiles.length > 0) {
			children.push(
				col(
					[
						node("text", { spans: [span("Images", "strong")] }),
						node("row", { gap: "md", wrap: true, align: "start" }, tiles),
					],
					{ gap: "sm" },
				),
			);
		}
		return node("prefs", props, children);
	}

	/** Without a native surface there is nothing to draw but why. */
	render(): readonly string[] {
		return NOT_NATIVE;
	}
}
