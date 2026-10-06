/**
 * AES-256-GCM sealing for collab frames.
 *
 * The room key lives only in the link fragment; the relay sees opaque bytes.
 * Sealed layout: `[12B IV][ciphertext+tag]`. The implementation is shared
 * with the browser guest through `@oh-my-pi/pi-wire/collab`; this module keeps
 * the host-side names and the rich {@link CollabFrame} typing.
 */
import { open as openFrame, sealSerialized } from "@oh-my-pi/pi-wire/collab";
import type { CollabFrame } from "./protocol";

export { generateRoomKey, generateWriteToken, importRoomKey, sealSerialized } from "@oh-my-pi/pi-wire/collab";

/**
 * @deprecated Test/dev-only; use `sealSerialized(key, JSON.stringify(frame))` (or `sealEnvelope`) instead. Will be removed in the next major.
 */
export function seal(key: CryptoKey, frame: CollabFrame): Promise<Uint8Array> {
	return sealSerialized(key, JSON.stringify(frame));
}

/** Inverse of `sealSerialized`. Throws on auth failure or malformed input. */
export function open(key: CryptoKey, data: Uint8Array): Promise<CollabFrame> {
	return openFrame<CollabFrame>(key, data);
}
