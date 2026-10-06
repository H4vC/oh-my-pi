/**
 * Content-addressed binary blobs (images) for `image` nodes.
 *
 * `describe()` registers the bytes and puts the returned id in `image.p.blob`;
 * the native backend uploads each referenced blob once per surface with verb
 * `b` before the frame that first references it.
 *
 * Lifetime. A blob is held strongly while a live surface's document
 * references it. Each backend sweeps once enough new bytes arrived since the
 * last sweep ({@link sweepNativeBlobs}). A blob no surface references then
 * joins a recently-unreferenced list that stays strongly held up to 64 MiB,
 * so a caller that kept only the id can show it again; past that, the oldest
 * are held only weakly: available while anything else keeps their bytes (the
 * node {@link base64ImageNode} built, a caller's own buffer) and dropped once
 * those are collected.
 */
import type { TspProps } from "@oh-my-pi/pi-wire";
import { getImageDimensionsFromBytes } from "../terminal-capabilities";
import { node } from "./describe";
import type { NativeNode } from "./node";

export interface NativeBlob {
	readonly id: string;
	readonly mime: string;
	readonly bytes: Uint8Array;
}

interface StoredBlob {
	readonly mime: string;
	/** Held strongly: referenced by a surface at the last sweep, registered/uploaded since, or recently unreferenced. */
	strong: NativeBlob | undefined;
	/** Held weakly: unreferenced and pushed out of the recently-unreferenced list. */
	weak: WeakRef<Uint8Array> | undefined;
}

const blobs = new Map<string, StoredBlob>();
// Registration usually repeats with the same bytes object on every describe;
// the tag skips rehashing it.
const kBlobId = Symbol("native.blobId");

interface BlobTagged {
	[kBlobId]?: string;
}

/** Bytes behind each {@link base64ImageNode} node, alive as long as the node is. */
const nodeBytes = new WeakMap<NativeNode, Uint8Array>();

/** Strongly held bytes added since the last sweep that make the next one due. */
const SWEEP_AFTER_BYTES = 16 * 1024 * 1024;
let strongBytesSinceSweep = 0;

/** Blob ids each backend's surfaces referenced at its last sweep. */
const holders: { owner: WeakRef<object>; ids: ReadonlySet<string> }[] = [];

/** Unreferenced blobs still held strongly, least recently unreferenced first. */
const recent = new Map<string, NativeBlob>();
const RECENT_MAX_BYTES = 64 * 1024 * 1024;
let recentBytes = 0;

/** Take `id` off the recently-unreferenced list: a surface references it again. */
function leaveRecent(id: string): void {
	const blob = recent.get(id);
	if (!blob) return;
	recent.delete(id);
	recentBytes -= blob.bytes.byteLength;
}

function holdStrongly(id: string, stored: StoredBlob, bytes: Uint8Array): NativeBlob {
	strongBytesSinceSweep += bytes.byteLength;
	stored.strong = { id, mime: stored.mime, bytes };
	stored.weak = undefined;
	return stored.strong;
}

/** Register `bytes` and return their content address (sha256 hex) for `image.p.blob`. */
export function registerNativeBlob(bytes: Uint8Array, mime: string): string {
	let id = (bytes as BlobTagged)[kBlobId];
	if (id === undefined) {
		id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		(bytes as BlobTagged)[kBlobId] = id;
	}
	let stored = blobs.get(id);
	if (!stored) {
		stored = { mime, strong: undefined, weak: undefined };
		blobs.set(id, stored);
	}
	if (!stored.strong) holdStrongly(id, stored, bytes);
	return id;
}

/** A registered blob by id; undefined once evicted. */
export function getNativeBlob(id: string): NativeBlob | undefined {
	const stored = blobs.get(id);
	if (!stored) return undefined;
	if (stored.strong) {
		leaveRecent(id);
		return stored.strong;
	}
	const bytes = stored.weak?.deref();
	if (!bytes) {
		blobs.delete(id);
		return undefined;
	}
	// Asked for again (an upload): held until the next sweep sees whether a surface references it.
	return holdStrongly(id, stored, bytes);
}

/**
 * Release blobs no live surface references. `collect` adds every blob id
 * `owner`'s surfaces reference now; it runs only when a sweep is due (enough
 * new bytes held since the last one). Blob ids other owners reported at their
 * last sweep stay held; unreferenced ones stay strongly held while they fit
 * the 64 MiB recently-unreferenced budget. The native backend calls it after
 * each frame's uploads.
 */
export function sweepNativeBlobs(owner: object, collect: (out: Set<string>) => void): void {
	if (strongBytesSinceSweep < SWEEP_AFTER_BYTES) return;
	const ids = new Set<string>();
	collect(ids);
	setHolding(owner, ids);
}

/** Drop `owner`'s hold on the blobs its surfaces referenced (the backend was discarded). */
export function releaseNativeBlobs(owner: object): void {
	setHolding(owner, new Set());
}

function setHolding(owner: object, ids: ReadonlySet<string>): void {
	for (let i = holders.length - 1; i >= 0; i--) {
		const target = holders[i]!.owner.deref();
		if (target === owner || target === undefined) holders.splice(i, 1);
	}
	if (ids.size > 0) holders.push({ owner: new WeakRef(owner), ids });
	strongBytesSinceSweep = 0;
	for (const [id, stored] of blobs) {
		const held = holders.some(holder => holder.ids.has(id));
		if (stored.strong) {
			if (held) leaveRecent(id);
			else if (!recent.has(id)) {
				recent.set(id, stored.strong);
				recentBytes += stored.strong.bytes.byteLength;
			}
			continue;
		}
		const bytes = stored.weak?.deref();
		if (!bytes) {
			blobs.delete(id);
		} else if (held) {
			// Shown again by a surface that already had it uploaded.
			stored.strong = { id, mime: stored.mime, bytes };
			stored.weak = undefined;
		}
	}
	// Over budget: the longest-unreferenced blobs fall back to weak holding.
	for (const [id, blob] of recent) {
		if (recentBytes <= RECENT_MAX_BYTES) break;
		recent.delete(id);
		recentBytes -= blob.bytes.byteLength;
		const stored = blobs.get(id)!;
		stored.weak = new WeakRef(blob.bytes);
		stored.strong = undefined;
	}
}

/**
 * An `image` node for a base64 payload: the bytes are registered as a blob and
 * the pixel size probed from the header. Decoding and hashing cost real time,
 * so callers cache the node per payload ({@link NativeImageCache}).
 */
export function base64ImageNode(
	data: string,
	mimeType: string,
	p?: Omit<TspProps<"image">, "blob" | "builtin" | "w" | "h">,
	key?: string,
): NativeNode {
	const bytes = Buffer.from(data, "base64");
	const blob = registerNativeBlob(bytes, mimeType);
	const size = getImageDimensionsFromBytes(bytes, mimeType);
	const image = node(
		"image",
		size ? { ...p, blob, w: size.widthPx, h: size.heightPx } : { ...p, blob },
		undefined,
		key,
	);
	// The node keeps its blob available after no surface shows it any more.
	nodeBytes.set(image, bytes);
	return image;
}

/** `image` nodes for base64 payloads, one per slot key, rebuilt only when the slot's payload changes. */
export class NativeImageCache {
	#entries = new Map<string, { data: string; node: NativeNode }>();

	get(key: string, data: string, mimeType: string): NativeNode {
		const cached = this.#entries.get(key);
		if (cached?.data === data) return cached.node;
		const image = base64ImageNode(data, mimeType, { alt: mimeType }, key);
		this.#entries.set(key, { data, node: image });
		return image;
	}
}
