/**
 * Collab live-session wire protocol.
 *
 * Hub topology: the host is authoritative, guests never peer. All session
 * payloads (`CollabFrame`) travel AES-256-GCM sealed; the relay only sees the
 * plaintext envelope (`[4B uint32 BE peerId][sealed payload]`) plus TEXT JSON
 * control messages that carry no session data.
 */

import type { ImageContent } from "@oh-my-pi/pi-ai";
import type {
	BusChannel,
	CollabUiRequest,
	GuestFrame,
	Participant,
	AgentSnapshot as WireAgentSnapshot,
} from "@oh-my-pi/pi-wire";
import { DEFAULT_RELAY_URL, ENVELOPE_HEADER_LENGTH, ROOM_ID_BYTES } from "@oh-my-pi/pi-wire";
import { rewriteEnvelopePeer as wireRewriteEnvelopePeer } from "@oh-my-pi/pi-wire/collab";
import type { CollabSessionState } from "@oh-my-pi/pi-tui/status-line/types";
import type { AgentSessionEvent } from "../session/agent-session";
import type { SessionEntry, SessionHeader } from "../session/session-entries";

export type {
	CollabPromptDetails,
	CollabUiRequest,
	CollabUiRequestDraft,
	CollabUiResponseValue,
	CollabUiSelectItem,
	ParsedCollabLink,
	RelayControlMessage,
	RelayControlToGuest,
	RelayControlToHost,
} from "@oh-my-pi/pi-wire";
export { COLLAB_PROMPT_MESSAGE_TYPE, COLLAB_PROTO } from "@oh-my-pi/pi-wire";
export { DEFAULT_RELAY_URL, ENVELOPE_HEADER_LENGTH, ROOM_ID_BYTES };

export type CollabParticipant = Participant;
export type AgentSnapshot = WireAgentSnapshot;

export type { CollabSessionState };

/**
 * Encrypted payload frames (inside AES-GCM, JSON). The wire package pins the
 * JSON skeleton (`WireFrame`); host-side frames carry the rich session types
 * that serialize into those shapes.
 */
export type CollabFrame =
	// guest -> host (hello/abort/agent-cmd/fetch-transcript/ui-response are taken verbatim from the wire grammar)
	| Exclude<GuestFrame, { t: "prompt" }>
	| { t: "prompt"; text: string; images?: ImageContent[] }
	// host -> guest
	| {
			t: "welcome";
			proto: number;
			header: SessionHeader;
			state: CollabSessionState;
			agents: AgentSnapshot[];
			/**
			 * Total number of `SessionEntry` items the host will deliver in the
			 * `snapshot-chunk` frames that follow. The guest stays in the
			 * snapshot-loading phase until it has accumulated that many entries
			 * (or a chunk arrives with `final: true`).
			 */
			entryCount: number;
			/** True when this peer joined through a read-only (view) link. */
			readOnly?: boolean;
	  }
	/**
	 * Targeted snapshot fragment delivered after `welcome`. Splits a large
	 * transcript across many small frames so the guest's per-chunk progress
	 * timeout resets each time the relay delivers another batch; without
	 * chunking, a multi-MB session has to fit one giant frame inside the
	 * 30 s first-welcome budget. The last chunk carries `final: true` so the
	 * guest can finalize the replica session.
	 */
	| { t: "snapshot-chunk"; entries: SessionEntry[]; final: boolean }
	| { t: "entry"; entry: SessionEntry }
	| { t: "event"; event: AgentSessionEvent }
	| { t: "state"; state: CollabSessionState }
	/** Mirrored EventBus traffic (task subagent lifecycle/progress channels only). */
	| { t: "bus"; channel: BusChannel; data: unknown }
	/** Full agent-registry snapshot (debounced on registry change). */
	| { t: "agents"; agents: AgentSnapshot[] }
	| { t: "ui-request"; request: CollabUiRequest }
	| { t: "ui-request-end"; reqId: number }
	/** Targeted reply to fetch-transcript; `error` marks a terminal read failure that guests must surface without hot retrying. */
	| { t: "transcript"; reqId: number; text: string; newSize: number; error?: string }
	| { t: "bye"; reason: string }
	| { t: "error"; message: string };

// ═══════════════════════════════════════════════════════════════════════════
// Wire envelope ([4B uint32 BE peerId][sealed payload]) and link format
// (wss://<host[:port]>/r/<roomId>.<base64url-key>). Shared with the browser
// guest and the local relay through `@oh-my-pi/pi-wire/collab`.
// ═══════════════════════════════════════════════════════════════════════════

export {
	formatCollabLink,
	formatCollabWebLink,
	generateRoomId,
	packEnvelope,
	parseCollabLink,
	unpackEnvelope,
} from "@oh-my-pi/pi-wire/collab";

/**
 * Rewrite the peerId in place without copying the payload.
 *
 * @deprecated Relay-side helper with no host/guest caller; use `rewriteEnvelopePeer` from `@oh-my-pi/pi-wire/collab`. Will be removed in the next major.
 */
export function rewriteEnvelopePeer(data: Uint8Array, peerId: number): void {
	wireRewriteEnvelopePeer(data, peerId);
}
