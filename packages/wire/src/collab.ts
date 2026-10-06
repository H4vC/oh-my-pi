/**
 * Collab transport helpers shared by the host CLI, the browser guest, and the
 * local relay: AES-256-GCM frame sealing, the relay envelope, and the
 * shareable link format.
 *
 * Browser-safe by construction: Web Crypto, `TextEncoder`/`TextDecoder`, and
 * `btoa`/`atob` only — no `Buffer`, no `node:` imports.
 *
 * - Sealed payload: `[12B IV][ciphertext+tag]`; the room key lives only in the
 *   link, so the relay sees opaque bytes.
 * - Wire envelope: `[4B uint32 BE peerId][sealed payload]`. Host→relay: peerId
 *   0 broadcasts to all guests, N targets guest N. Guest→relay: always 0; the
 *   relay rewrites it to the sender's id.
 * - Link: `wss://<host[:port]>/r/<roomId>.<base64url-key>`.
 */
import {
	DEFAULT_RELAY_URL,
	ENVELOPE_HEADER_LENGTH,
	type ParsedCollabLink,
	ROOM_ID_BYTES,
	ROOM_KEY_BYTES,
	WRITE_TOKEN_BYTES,
	type WireFrame,
} from "./index";

const AES_ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/;
const BARE_LINK_RE = /^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const LOCAL_HOSTNAMES: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true };

// ═══════════════════════════════════════════════════════════════════════════
// Random material
// ═══════════════════════════════════════════════════════════════════════════

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

/** Fresh 32-byte AES-256-GCM room key. */
export function generateRoomKey(): Uint8Array<ArrayBuffer> {
	return randomBytes(ROOM_KEY_BYTES);
}

/** Fresh write token for full (control) links. */
export function generateWriteToken(): Uint8Array<ArrayBuffer> {
	return randomBytes(WRITE_TOKEN_BYTES);
}

/** Fresh base64url room id. */
export function generateRoomId(): string {
	return encodeBase64Url(randomBytes(ROOM_ID_BYTES));
}

// ═══════════════════════════════════════════════════════════════════════════
// AES-256-GCM sealing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * View `bytes` as an `ArrayBuffer`-backed source for Web Crypto. Views into a
 * regular buffer pass through at any offset; only a shared-memory view is
 * copied, because `BufferSource` excludes `SharedArrayBuffer`.
 */
function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	if (bytes.buffer instanceof ArrayBuffer) return bytes as Uint8Array<ArrayBuffer>;
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

export function importRoomKey(raw: Uint8Array): Promise<CryptoKey> {
	if (raw.byteLength !== ROOM_KEY_BYTES) {
		throw new Error(`Room key must be ${ROOM_KEY_BYTES} bytes, got ${raw.byteLength}`);
	}
	return crypto.subtle.importKey("raw", bufferSource(raw), AES_ALGORITHM, false, ["encrypt", "decrypt"]);
}

/**
 * Seal `plaintext` into a fresh buffer with `offset` spare leading bytes:
 * `[offset][12B IV][ciphertext+tag]`. One allocation for the whole output.
 */
async function sealInto(key: CryptoKey, plaintext: string, offset: number): Promise<Uint8Array<ArrayBuffer>> {
	const iv = randomBytes(IV_LENGTH);
	const ciphertext = await crypto.subtle.encrypt({ name: AES_ALGORITHM, iv }, key, TEXT_ENCODER.encode(plaintext));
	const out = new Uint8Array(offset + IV_LENGTH + ciphertext.byteLength);
	out.set(iv, offset);
	out.set(new Uint8Array(ciphertext), offset + IV_LENGTH);
	return out;
}

/** Seal one frame: `[12B IV][ciphertext+tag]` over its JSON form. */
export function seal(key: CryptoKey, frame: WireFrame): Promise<Uint8Array<ArrayBuffer>> {
	return sealInto(key, JSON.stringify(frame), 0);
}

/** {@link seal} for a frame that is already JSON — skips a second serialization. */
export function sealSerialized(key: CryptoKey, frame: string): Promise<Uint8Array<ArrayBuffer>> {
	return sealInto(key, frame, 0);
}

/**
 * Seal an already-serialized frame straight into a wire envelope:
 * `[4B uint32 BE peerId][12B IV][ciphertext+tag]`. Equivalent to
 * `packEnvelope(peerId, await sealSerialized(key, frame))` without the
 * intermediate sealed buffer and its copy.
 */
export async function sealEnvelope(key: CryptoKey, peerId: number, frame: string): Promise<Uint8Array<ArrayBuffer>> {
	const out = await sealInto(key, frame, ENVELOPE_HEADER_LENGTH);
	new DataView(out.buffer).setUint32(0, peerId, false);
	return out;
}

/**
 * Inverse of {@link seal}. Throws on auth failure or malformed input. `data`
 * may be a view into a larger buffer (e.g. an envelope payload); it is not
 * copied.
 */
export async function open<T = WireFrame>(key: CryptoKey, data: Uint8Array): Promise<T> {
	if (data.byteLength <= IV_LENGTH) {
		throw new Error("Sealed frame too short");
	}
	const source = bufferSource(data);
	const iv = source.subarray(0, IV_LENGTH);
	const ciphertext = source.subarray(IV_LENGTH);
	const plaintext = await crypto.subtle.decrypt({ name: AES_ALGORITHM, iv }, key, ciphertext);
	return JSON.parse(TEXT_DECODER.decode(plaintext)) as T;
}

// ═══════════════════════════════════════════════════════════════════════════
// Wire envelope
// ═══════════════════════════════════════════════════════════════════════════

export function packEnvelope(peerId: number, sealed: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + sealed.byteLength);
	new DataView(out.buffer).setUint32(0, peerId, false);
	out.set(sealed, ENVELOPE_HEADER_LENGTH);
	return out;
}

export function unpackEnvelope(data: Uint8Array): { peerId: number; payload: Uint8Array } | null {
	if (data.byteLength < ENVELOPE_HEADER_LENGTH) return null;
	const peerId = new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
	return { peerId, payload: data.subarray(ENVELOPE_HEADER_LENGTH) };
}

/** Rewrite the peerId in place without copying the payload (relay-side). */
export function rewriteEnvelopePeer(data: Uint8Array, peerId: number): void {
	new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).setUint32(0, peerId, false);
}

// ═══════════════════════════════════════════════════════════════════════════
// base64url
// ═══════════════════════════════════════════════════════════════════════════

export function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Decode unpadded base64url; `null` for anything outside the alphabet or malformed. */
export function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
	if (!B64URL_RE.test(text)) return null;
	const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
	const padded = base64.length % 4 === 0 ? base64 : base64 + "=".repeat(4 - (base64.length % 4));
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		return null;
	}
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Link format
// ═══════════════════════════════════════════════════════════════════════════

/** Normalize a relay base URL (ws/wss/http/https) into a ws/wss origin, or an error. */
function normalizeRelayOrigin(relayUrl: string): { origin: string } | { error: string } {
	let url: URL;
	try {
		url = new URL(relayUrl);
	} catch {
		return { error: `Invalid relay URL: ${relayUrl}` };
	}
	let scheme: string;
	switch (url.protocol) {
		case "wss:":
		case "https:":
			scheme = "wss:";
			break;
		case "ws:":
		case "http:":
			scheme = "ws:";
			break;
		default:
			return { error: `Unsupported relay URL scheme: ${url.protocol}` };
	}
	if (scheme === "ws:" && LOCAL_HOSTNAMES[url.hostname] !== true) {
		return { error: "relay link must be wss:// (plain ws:// is only allowed for localhost)" };
	}
	const port = url.port ? `:${url.port}` : "";
	return { origin: `${scheme}//${url.hostname}${port}` };
}

/**
 * Render the shareable link. Compact forms: the default relay collapses to
 * `<roomId>.<key>`, other wss relays drop the scheme (`host[:port]/r/…`);
 * only localhost ws:// links keep their full URL so parsing cannot
 * mis-infer wss.
 *
 * The room secret is dot-joined (`<roomId>.<key>`) rather than `#`-joined:
 * RFC 3986 forbids a raw `#` inside a fragment, so strict URL stacks (macOS
 * Foundation behind terminal click-to-open) percent-encode a second `#` to
 * `%23` and break the link. Parsers still accept the legacy `#` form and the
 * mangled `%23` form.
 *
 * Full links append the write token to the key
 * (`base64url(key ∥ writeToken)`); read-only (view) links carry the bare
 * 32-byte key, which is also the pre-token link format.
 */
export function formatCollabLink(relayUrl: string, roomId: string, key: Uint8Array, writeToken?: Uint8Array): string {
	const normalized = normalizeRelayOrigin(relayUrl);
	if ("error" in normalized) throw new Error(normalized.error);
	let secret = key;
	if (writeToken) {
		secret = new Uint8Array(key.byteLength + writeToken.byteLength);
		secret.set(key, 0);
		secret.set(writeToken, key.byteLength);
	}
	const keyText = encodeBase64Url(secret);
	if (normalized.origin === DEFAULT_RELAY_URL) return `${roomId}.${keyText}`;
	const compact = normalized.origin.startsWith("wss://")
		? normalized.origin.slice("wss://".length)
		: normalized.origin;
	return `${compact}/r/${roomId}.${keyText}`;
}

function normalizeCollabWebBaseUrl(relayUrl: string, webUrl?: string): string {
	const explicitWebUrl = webUrl?.trim();
	if (!explicitWebUrl) {
		const normalized = normalizeRelayOrigin(relayUrl);
		if ("error" in normalized) throw new Error(normalized.error);
		return normalized.origin.startsWith("wss://")
			? `https://${normalized.origin.slice("wss://".length)}`
			: `http://${normalized.origin.slice("ws://".length)}`;
	}

	let url: URL;
	try {
		url = new URL(explicitWebUrl);
	} catch {
		throw new Error("collab.webUrl must start with http:// or https://");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("collab.webUrl must start with http:// or https://");
	}
	if (url.protocol === "http:" && LOCAL_HOSTNAMES[url.hostname] !== true) {
		throw new Error("collab.webUrl must use https:// unless it targets localhost");
	}
	if (url.search || url.hash) {
		throw new Error("collab.webUrl must not include a query string or fragment");
	}
	const path = url.pathname.replace(/\/+$/, "");
	return `${url.origin}${path}`;
}

/**
 * Render the browser deep link. The browser UI may be hosted separately from
 * the relay; the fragment always carries the relay-specific collab link, so
 * room secrets stay out of HTTP path and query bytes.
 */
export function formatCollabWebLink(
	relayUrl: string,
	roomId: string,
	key: Uint8Array,
	writeToken?: Uint8Array,
	webUrl?: string,
): string {
	return `${normalizeCollabWebBaseUrl(relayUrl, webUrl)}/#${formatCollabLink(relayUrl, roomId, key, writeToken)}`;
}

export function parseCollabLink(link: string): ParsedCollabLink | { error: string } {
	// Lenient input: terminals that open OSC 8 links through strict URL stacks
	// (macOS Foundation) percent-encode the legacy second `#` to `%23`.
	let text = link.trim().replace(/%23/gi, "#");
	// Bare `<roomId>.<key>` (legacy `<roomId>#<key>`) → default relay.
	const bare = BARE_LINK_RE.exec(text);
	if (bare) text = `${DEFAULT_RELAY_URL}/r/${bare[1]}.${bare[2]}`;
	// Scheme-less `host[:port]/r/…` → wss.
	else if (!text.includes("://")) text = `wss://${text}`;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return { error: `Invalid collab link: ${link}` };
	}
	if ((url.protocol === "http:" || url.protocol === "https:") && url.hash) {
		const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
		const parsed = parseCollabLink(inner);
		if (!("error" in parsed)) return parsed;
	}
	const normalized = normalizeRelayOrigin(url.origin);
	if ("error" in normalized) return normalized;
	const match = ROOM_PATH_RE.exec(url.pathname);
	if (!match) {
		// Non-http(s) deep links may also carry a complete collab link in the
		// fragment. http(s) links are handled once above so invalid fragments
		// fall through to direct relay validation instead of double-recursing.
		const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
		if (inner && url.protocol !== "http:" && url.protocol !== "https:") return parseCollabLink(inner);
		return { error: "Collab link must contain a /r/<roomId> path" };
	}
	const roomId = match[1] as string;
	// Key rides dot-joined in the path (`/r/<roomId>.<key>`); legacy links
	// carry it in the fragment (`/r/<roomId>#<key>`).
	const fragment = match[2] ?? (url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
	if (!fragment) {
		return { error: "Collab link is missing the <key> part" };
	}
	const secret = decodeBase64Url(fragment);
	if (!secret || (secret.byteLength !== ROOM_KEY_BYTES && secret.byteLength !== ROOM_KEY_BYTES + WRITE_TOKEN_BYTES)) {
		return { error: "Collab link key must be 32 (view) or 48 (full) base64url bytes" };
	}
	const key = secret.subarray(0, ROOM_KEY_BYTES);
	const writeToken = secret.byteLength > ROOM_KEY_BYTES ? secret.subarray(ROOM_KEY_BYTES) : undefined;
	return { wsUrl: `${normalized.origin}/r/${roomId}`, roomId, key, writeToken };
}
