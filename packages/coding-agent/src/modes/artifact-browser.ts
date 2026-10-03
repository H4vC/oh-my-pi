/**
 * `/artifacts`: the session's artifacts (spilled tool output, subagent output
 * and transcripts, `local://` files) in the pi-tui artifact browser, docked
 * beside the transcript like `/settings`.
 *
 * Tern only: the browser is a native `prefs` page; the selected file shows in
 * Tern's preview block beside omp's pane (`tern open --preview`), a binary IDA
 * can disassemble as its disassembly listing, and files open in new Tern file
 * blocks (`tern open --split`).
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, isEnoent, postmortem } from "@oh-my-pi/pi-utils";
import {
	ArtifactBrowserComponent,
	type ArtifactBrowserHost,
	type ArtifactEntry,
	type ArtifactImage,
} from "@oh-my-pi/pi-tui/apps/artifact-browser";
import { getImageDimensions } from "@oh-my-pi/pi-tui/terminal-capabilities";
import type { OverlayHandle } from "@oh-my-pi/pi-tui/tui";
import type { InteractiveModeContext } from "./types";
import { copyToClipboard } from "../utils/clipboard";
import type { Settings } from "../config/settings";
import { type DisasmPreview, disassemblePreview } from "../ida/disasm-preview";

const NEEDS_TERN = "The artifact browser needs Tern: run omp inside a Tern pane.";

const MAX_DEPTH = 4;
/** Images get thumbnails up to this size; Tern caches each blob per surface. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
/** Head of a file read to tell text from binary. */
const SNIFF_BYTES = 8192;
/** Files bigger than this are not handed to IDA. */
const MAX_DISASM_BYTES = 64 * 1024 * 1024;
/** Instructions a disassembly listing holds. */
const DISASM_LINES = 2_000;
/** Where disassembly listings are written for Tern's preview block. */
const LISTING_DIR = path.join(os.tmpdir(), "omp-artifact-disasm");
const IMAGE_MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
};

const GROUP_ORDER: Record<string, number> = { Local: 0, "Tool output": 1, Subagents: 2, Other: 3 };

/**
 * The `tern` CLI when this process runs in a Tern pane, else null. On Windows
 * `tern.com` is the console entry; `tern.exe` is the GUI-subsystem window app.
 */
export function resolveTernCli(env: Record<string, string | undefined> = process.env): string | null {
	if (!env.TERN_PANE?.trim()) return null;
	return (process.platform === "win32" ? $which("tern.com") : null) ?? $which("tern");
}

/** Classify one file under an artifacts dir into a browser entry. */
function classify(root: string, rel: string, size: number, mtime: number): ArtifactEntry {
	const parts = rel.split(/[\\/]/);
	const name = parts[parts.length - 1]!;
	const base: Omit<ArtifactEntry, "group" | "label"> = {
		id: rel,
		path: path.join(root, rel),
		size,
		mtime,
		...(IMAGE_MIME_BY_EXT[path.extname(name).toLowerCase()] ? { image: true } : {}),
	};
	if (parts[0] === "local" && parts.length > 1) {
		const localPath = parts.slice(1).join("/");
		return { ...base, group: "Local", label: localPath, url: `local://${localPath}` };
	}
	const spill = parts.length === 1 ? /^(\d+)\.(.+)\.log$/.exec(name) : null;
	if (spill) {
		return { ...base, group: "Tool output", label: `#${spill[1]} ${spill[2]}`, url: `artifact://${spill[1]}` };
	}
	const agent = /^(.+)\.(md|jsonl)$/.exec(name);
	if (agent && !name.startsWith("__")) {
		const isOutput = agent[2] === "md";
		return {
			...base,
			group: "Subagents",
			label: `${agent[1]} ${isOutput ? "output" : "transcript"}`,
			url: isOutput ? `agent://${agent[1]}` : undefined,
			depth: parts.length - 1,
		};
	}
	return { ...base, group: "Other", label: parts.join("/") };
}

async function walk(root: string, rel: string, depth: number, out: ArtifactEntry[]): Promise<void> {
	let dirents: Dirent[];
	try {
		dirents = await fs.readdir(path.join(root, rel), { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	await Promise.all(
		dirents.map(async dirent => {
			// Staged writes (`writeArtifact`) and EPERM-rewrite backups are not artifacts.
			if (dirent.name.startsWith(".") || dirent.name.endsWith(".tmp") || dirent.name.endsWith(".bak")) return;
			const child = rel ? path.join(rel, dirent.name) : dirent.name;
			if (dirent.isDirectory()) {
				if (depth < MAX_DEPTH) await walk(root, child, depth + 1, out);
				return;
			}
			if (!dirent.isFile()) return;
			try {
				const stat = await fs.stat(path.join(root, child));
				out.push(classify(root, child, stat.size, stat.mtimeMs));
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
		}),
	);
}

/** Every artifact in an artifacts directory, grouped, newest first within a group. */
export async function listArtifactEntries(artifactsDir: string): Promise<ArtifactEntry[]> {
	const out: ArtifactEntry[] = [];
	await walk(artifactsDir, "", 0, out);
	return out.sort(
		(a, b) =>
			(GROUP_ORDER[a.group] ?? 9) - (GROUP_ORDER[b.group] ?? 9) || b.mtime - a.mtime || a.id.localeCompare(b.id),
	);
}

/**
 * Whether a file head reads as binary: a NUL byte, bytes that are not UTF-8,
 * or more than 5% control characters other than whitespace and ESC (ANSI
 * logs stay text).
 */
function looksBinary(head: Uint8Array): boolean {
	if (head.includes(0)) return true;
	try {
		// `stream` tolerates a character cut at the end of the head.
		new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
	} catch {
		return true;
	}
	let control = 0;
	for (const byte of head) {
		if (
			(byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c && byte !== 0x1b) ||
			byte === 0x7f
		)
			control++;
	}
	return control > head.length * 0.05;
}

/** Whether `file` reads as binary (see {@link looksBinary}). */
async function isBinaryFile(file: string): Promise<boolean> {
	return looksBinary(new Uint8Array(await Bun.file(file).slice(0, SNIFF_BYTES).arrayBuffer()));
}

/** An image artifact's bytes and pixel size for its thumbnail, or undefined when it is no (small enough) image. */
async function loadArtifactImage(entry: ArtifactEntry): Promise<ArtifactImage | undefined> {
	const mime = IMAGE_MIME_BY_EXT[path.extname(entry.path).toLowerCase()];
	if (!mime || entry.size > MAX_IMAGE_BYTES) return undefined;
	const bytes = await Bun.file(entry.path).bytes();
	const size = getImageDimensions(Buffer.from(bytes).toString("base64"), mime) ?? undefined;
	return { bytes, mime, size };
}

/** Write a disassembly listing for Tern to show; one file per artifact path, rewritten as it changes. */
async function writeListing(entry: ArtifactEntry, listing: DisasmPreview): Promise<string> {
	const file = path.join(LISTING_DIR, `${Bun.hash(entry.path).toString(36)}-${path.basename(entry.path)}.asm`);
	const header = `; ${path.basename(entry.path)} — ${listing.arch}, disassembled by IDA\n; ${entry.path}\n\n`;
	await Bun.write(file, `${header}${listing.lines.join("\n")}\n`);
	return file;
}

/** Run one `tern` CLI command; resolves with its stdout, throws with its stderr on failure. */
async function runTern(tern: string, args: string[]): Promise<string> {
	const child = Bun.spawn([tern, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0)
		throw new Error(`tern ${args[0]} failed (${code}): ${stderr.trim() || stdout.trim() || "no output"}`);
	return stdout;
}

/**
 * Filesystem/Tern host for the artifact browser over one artifacts directory; `tern` is the Tern
 * CLI, `ida` what the IDA disassembler needs (the session's settings and cwd).
 */
export function createArtifactBrowserHost(opts: {
	tern: string;
	artifactsDir: string;
	sessionLabel: string;
	ida: { settings: Settings; cwd: string };
}): ArtifactBrowserHost & { close(): Promise<void> } {
	const { tern, artifactsDir } = opts;
	/** Disassembly listings by path and mtime (undefined: IDA could not read it as code). */
	const listings = new Map<string, Promise<DisasmPreview | undefined>>();
	// One idalib process at a time, however fast the selection moves.
	let idaQueue: Promise<unknown> = Promise.resolve();
	let shownSeq = 0;
	/** The preview blocks the browser showed files in, closed with it. */
	const previewBlocks = new Set<string>();
	let closed = false;
	const disassemble = (entry: ArtifactEntry): Promise<DisasmPreview | undefined> => {
		const key = `${entry.path}\n${entry.mtime}`;
		let listing = listings.get(key);
		if (!listing) {
			listing = idaQueue.then(() => disassemblePreview(entry.path, { ...opts.ida, maxLines: DISASM_LINES }));
			idaQueue = listing.catch(() => undefined);
			listings.set(key, listing);
		}
		return listing;
	};
	const closeBlocks = async (): Promise<void> => {
		const blocks = [...previewBlocks];
		previewBlocks.clear();
		await Promise.all(blocks.map(block => runTern(tern, ["close", block]).catch(() => undefined)));
	};
	/** Show `file` in Tern's preview block beside omp's pane, remembering the block to close it later. */
	const preview = async (file: string): Promise<void> => {
		const reply = JSON.parse(await runTern(tern, ["open", "--preview", "--json", file])) as { blocks?: number[] };
		for (const block of reply.blocks ?? []) previewBlocks.add(String(block));
		// Closed while this open was in flight: the block it made goes too.
		if (closed) await closeBlocks();
	};
	return {
		sessionLabel: opts.sessionLabel,
		listEntries: () => listArtifactEntries(artifactsDir),
		loadImage: loadArtifactImage,
		async show(entry) {
			if (closed) return;
			const seq = ++shownSeq;
			// The file itself at once; a binary IDA reads as code is replaced by its listing when that is ready.
			await preview(entry.path);
			if (entry.image || entry.size > MAX_DISASM_BYTES || !(await isBinaryFile(entry.path))) return;
			const listing = await disassemble(entry);
			if (!listing || seq !== shownSeq || closed) return;
			const file = await writeListing(entry, listing);
			if (seq === shownSeq && !closed) await preview(file);
		},
		async open(entry) {
			// `--split` asks for a new block even when the file is already open somewhere.
			await runTern(tern, ["open", "--split", "right", entry.path]);
		},
		copy: copyToClipboard,
		/** Close the preview blocks the browser used; blocks opened with a double click stay. */
		close() {
			closed = true;
			return closeBlocks();
		},
	};
}

/** `/artifacts`: the browser docked beside the transcript in omp's own pane, like `/settings`. */
export function showArtifactBrowser(ctx: InteractiveModeContext): void {
	const tern = resolveTernCli();
	if (!tern) {
		ctx.showError(NEEDS_TERN);
		return;
	}
	const artifactsDir = ctx.sessionManager.getArtifactsDir();
	if (!artifactsDir) {
		ctx.showError("This session has no session file, so it has no artifacts.");
		return;
	}
	const previousFocus = ctx.ui.getFocused();
	let overlay: OverlayHandle | undefined;
	const host = createArtifactBrowserHost({
		tern,
		artifactsDir,
		sessionLabel: ctx.sessionManager.getSessionName() || "This session",
		ida: { settings: ctx.settings, cwd: ctx.sessionManager.getCwd() },
	});
	// omp exiting with the browser open takes its preview block along, as closing the browser does.
	const unregister = postmortem.register("artifact-browser", () => host.close(), { exitOnly: true });
	const browser = new ArtifactBrowserComponent({
		host,
		onUpdate: () => ctx.ui.requestRender(),
		onExit: () => {
			unregister();
			void host.close();
			browser.dispose();
			overlay?.hide();
			overlay = undefined;
			ctx.ui.setFocus(previousFocus ?? ctx.editor);
			ctx.ui.requestRender();
		},
	});
	// The same mount as `/settings`: over a live session Tern docks the
	// browser's `prefs` page at the pane's right edge, the transcript beside it.
	overlay = ctx.ui.showOverlay(browser, {
		anchor: "bottom-center",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
		fullscreen: true,
	});
	ctx.ui.setFocus(browser);
	ctx.ui.requestRender();
}
