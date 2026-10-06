# @oh-my-pi/pi-wire

Shared TypeScript wire contracts for omp collab live sessions.

The root entry contains only JSON-safe protocol shapes and constants. It has no runtime dependencies and is consumed by both the host CLI (`@oh-my-pi/pi-coding-agent`) and browser guest (`@oh-my-pi/collab-web`).

## Exports

```ts
import type { GuestFrame, HostFrame, SessionEntry } from "@oh-my-pi/pi-wire";
import { COLLAB_PROTO, DEFAULT_RELAY_URL, ENVELOPE_HEADER_LENGTH } from "@oh-my-pi/pi-wire";
import { importRoomKey, open, parseCollabLink, sealEnvelope } from "@oh-my-pi/pi-wire/collab";
```

Key groups:

- message and transcript entry shapes rendered by collab guests,
- live agent event and task-subagent bus payload shapes,
- `GuestFrame`, `HostFrame`, and `WireFrame` unions for AES-GCM sealed payloads,
- relay control TEXT messages,
- link/envelope constants shared by host, guest, and local relay code,
- `@oh-my-pi/pi-wire/collab`: the browser-safe transport helpers (Web Crypto only, no `Buffer`) — AES-256-GCM `seal`/`sealSerialized`/`sealEnvelope`/`open`, `packEnvelope`/`unpackEnvelope`/`rewriteEnvelopePeer`, and the link grammar (`formatCollabLink`, `formatCollabWebLink`, `parseCollabLink`, room id/key/write-token generators).

## Protocol boundary

The root entry does not encode, decode, validate, encrypt, or route frames; `@oh-my-pi/pi-wire/collab` seals and opens them and handles the envelope, but never validates or routes. Together they define the shared contract used at those boundaries:

1. callers build a `GuestFrame` or `HostFrame`,
2. transport code serializes it as JSON inside an encrypted payload,
3. relay code routes opaque envelopes using the plaintext peer-id prefix,
4. receivers switch on `frame.t` and tolerate unknown future fields.

Keep protocol changes backward-aware: bump `COLLAB_PROTO` only when old hosts and guests must reject each other.
