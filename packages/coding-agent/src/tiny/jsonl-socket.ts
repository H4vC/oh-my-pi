import * as net from "node:net";

/**
 * Local-socket plumbing (Unix sockets / Windows named pipes): bounded dialing, liveness probes and
 * newline-delimited JSON framing. Shared by the tiny worker daemon (both halves), the MLX and
 * predict daemon clients, the IDA host, the daemon broker client and the LSP mux.
 */

/** Feed socket chunks and invoke `onLine` per complete, non-blank line. */
export class LineParser {
	#buffer = "";
	constructor(readonly onLine: (line: string) => void) {}

	push(chunk: string): void {
		this.#buffer += chunk;
		for (;;) {
			const newline = this.#buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.#buffer.slice(0, newline);
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line.trim()) this.onLine(line);
		}
	}
}

/** Write one JSON line; silently dropped once the socket is gone (the close handler reports that). */
export function writeJsonLine(socket: net.Socket, message: unknown): void {
	if (socket.destroyed) return;
	socket.write(`${JSON.stringify(message)}\n`);
}

/**
 * Dial a Unix socket or named pipe with a bounded connect. Rejects with the socket error, or with
 * `timeoutMessage` once `timeoutMs` passes (the socket is destroyed). The returned socket carries
 * no listeners of ours.
 */
export function dialSocket(
	endpoint: string,
	timeoutMs: number,
	timeoutMessage = `timed out connecting to ${endpoint}`,
): Promise<net.Socket> {
	const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
	const socket = net.createConnection(endpoint);
	const timer = setTimeout(() => {
		socket.destroy();
		reject(new Error(timeoutMessage));
	}, timeoutMs);
	const onConnect = (): void => {
		clearTimeout(timer);
		socket.off("error", onError);
		resolve(socket);
	};
	const onError = (error: Error): void => {
		clearTimeout(timer);
		socket.off("connect", onConnect);
		socket.destroy();
		reject(error);
	};
	socket.once("connect", onConnect);
	socket.once("error", onError);
	return promise;
}

/** Dial a Unix socket or named pipe with a bounded connect; the socket is switched to UTF-8 strings. */
export async function connectJsonlSocket(endpoint: string, timeoutMs: number): Promise<net.Socket> {
	const socket = await dialSocket(endpoint, timeoutMs);
	socket.setEncoding("utf-8");
	// The first post-connect error is absorbed; callers report a lost peer from their close handler.
	socket.once("error", () => {});
	return socket;
}

/** True when something accepts a connection at `endpoint`. */
export function endpointAlive(endpoint: string): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.createConnection(endpoint);
	socket.once("connect", () => {
		socket.destroy();
		resolve(true);
	});
	socket.once("error", () => {
		socket.destroy();
		resolve(false);
	});
	return promise;
}
