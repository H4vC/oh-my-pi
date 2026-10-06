import {
	type ModelWorkerMessage,
	ModelWorkerHost,
	spawnRefCountedWorker,
	wrapRefCountedSubprocess,
} from "../subprocess/model-worker-host";
import {
	createWorkerSubprocess,
	type RefCountedWorkerHandle,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	type SpawnedSubprocess,
	smokeTestWorker,
} from "../subprocess/worker-client";
import { tinyWorkerEnv } from "../tiny/title-client";
import type { SttProgressEvent, SttWorkerInbound, SttWorkerOutbound } from "./asr-protocol";
import { getSttModelSpec, type SttModelKey } from "./models";

type TranscribeRequest = {
	kind: "transcribe";
	modelKey: SttModelKey;
	resolve: (text: string) => void;
	reject: (error: Error) => void;
};

export interface SttTranscribeOptions {
	language?: string;
	signal?: AbortSignal;
}

export interface SttDownloadOptions {
	signal?: AbortSignal;
	onProgress?: (event: SttProgressEvent) => void;
}

export interface SttDownloadResult {
	ok: boolean;
	error?: string;
}

/** Live streaming session handle returned by {@link SttClient.startStream}. */
export interface SttStreamHandle {
	/** Feed 16 kHz mono float samples as the recorder produces them. */
	pushAudio(audio: Float32Array): void;
	/** Flush the trailing segment and resolve with the full joined transcript. */
	stop(): Promise<string>;
	/** Tear the session down without a final flush (resolves `stop()` with ""). */
	cancel(): void;
}

export interface SttStreamOptions {
	language?: string;
	signal?: AbortSignal;
	/** Volatile transcript of the in-progress segment, refreshed as audio arrives. */
	onPartial?: (text: string) => void;
	/** A finalized segment, emitted once when the endpointer commits it. */
	onSegment?: (text: string, index: number) => void;
}

interface StreamState {
	modelKey: SttModelKey;
	onPartial: ((text: string) => void) | undefined;
	onSegment: ((text: string, index: number) => void) | undefined;
	resolve: (text: string) => void;
	reject: (error: Error) => void;
	/** Run `apply` (resolve/reject) once, then unregister the stream. */
	finish: (apply: () => void) => void;
}

/**
 * Live audio is forwarded to the worker in ~100 ms batches (16 kHz) instead of one
 * IPC message per 20 ms capture callback. The worker's endpointer is frame-based, so
 * batching only delays partial/segment detection by at most one batch; `stop()`
 * flushes the remainder before the final flush.
 */
const STREAM_AUDIO_BATCH_SAMPLES = 1_600;

/**
 * Hidden subcommand on the main CLI that boots the speech-recognition worker in
 * the spawned subprocess. Kept in sync with the dispatch in `cli.ts`.
 */
export const STT_WORKER_ARG = "__omp_worker_stt";

/**
 * Spawn the speech worker as a subprocess. Exported for tests and the smoke
 * probe; production callers go through {@link spawnSttWorker}.
 */
export function createSttSubprocess(): SpawnedSubprocess<SttWorkerOutbound> {
	return createWorkerSubprocess<SttWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(STT_WORKER_ARG),
		env: tinyWorkerEnv(),
		exitLabel: "stt subprocess",
	});
}

function spawnSttWorker(): RefCountedWorkerHandle<SttWorkerInbound, SttWorkerOutbound> {
	return spawnRefCountedWorker(createSttSubprocess, "stt", "stt worker spawn failed; speech-to-text disabled");
}

export class SttClient {
	#streams = new Map<string, StreamState>();
	#host: ModelWorkerHost<SttModelKey, SttWorkerInbound, SttWorkerOutbound, TranscribeRequest, SttProgressEvent>;

	constructor(spawnWorker: () => RefCountedWorkerHandle<SttWorkerInbound, SttWorkerOutbound> = spawnSttWorker) {
		this.#host = new ModelWorkerHost({
			name: "stt",
			spawnWorker,
			modelLabel: modelKey => getSttModelSpec(modelKey)?.label ?? modelKey,
			handleMessage: message => this.#handleMessage(message),
			failRequest: (request, error) => request.reject(error),
			hasStreams: () => this.#streams.size > 0,
			failStreams: error => this.#failStreams(error),
		});
	}

	onProgress(listener: (event: SttProgressEvent) => void): () => void {
		return this.#host.onProgress(listener);
	}

	/**
	 * Transcribe 16 kHz mono audio on the warm worker. Rejects with the worker
	 * error on failure and with an `AbortError` when the signal fires (the warm
	 * worker keeps the model loaded across calls — the model is never reloaded).
	 */
	async transcribe(modelKey: SttModelKey, audio: Float32Array, options: SttTranscribeOptions = {}): Promise<string> {
		options.signal?.throwIfAborted();
		return this.#host.request<string>(
			options.signal,
			id => ({ type: "transcribe", id, modelKey, audio, language: options.language }),
			(resolve, reject) => ({ kind: "transcribe", modelKey, resolve, reject }),
			(_resolve, reject) => reject(new DOMException("The operation was aborted.", "AbortError")),
		);
	}

	/**
	 * Open a live streaming session on the warm worker. Audio fed through the
	 * returned handle is segmented by the worker's endpointer: `onSegment` fires
	 * once per committed segment and `onPartial` for the volatile in-progress
	 * preview. `stop()` resolves with the full joined transcript; `cancel()` (or
	 * an aborted signal) tears the session down and resolves `stop()` with "".
	 */
	startStream(modelKey: SttModelKey, options: SttStreamOptions = {}): SttStreamHandle {
		const worker = this.#host.ensureWorker();
		const id = this.#host.nextId();
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		// `stop()` is normally the only awaiter of `promise`, but with model loading
		// now deferred to the stream, a load failure (or early worker error) can
		// reject it before the caller stops — attach a benign handler so that never
		// surfaces as an unhandled rejection. stop()/await still observes the
		// rejection through the original promise.
		void promise.catch(() => {});
		const signal = options.signal;
		let settled = false;
		const onAbort = (): void => handle.cancel();
		const finish = (apply: () => void): void => {
			if (settled) return;
			settled = true;
			this.#streams.delete(id);
			signal?.removeEventListener("abort", onAbort);
			this.#host.syncWorkerRef();
			apply();
		};
		this.#streams.set(id, {
			modelKey,
			onPartial: options.onPartial,
			onSegment: options.onSegment,
			resolve,
			reject,
			finish,
		});
		this.#host.syncWorkerRef();
		worker.send({ type: "stream_start", id, modelKey, language: options.language });
		let batch = new Float32Array(STREAM_AUDIO_BATCH_SAMPLES);
		let batched = 0;
		const flushBatch = (): void => {
			if (batched === 0) return;
			// Structured clone ships the whole backing buffer, so a partial batch is sliced.
			const audio = batched === STREAM_AUDIO_BATCH_SAMPLES ? batch : batch.slice(0, batched);
			worker.send({ type: "stream_audio", id, audio });
			batch = new Float32Array(STREAM_AUDIO_BATCH_SAMPLES);
			batched = 0;
		};
		const handle: SttStreamHandle = {
			pushAudio: audio => {
				if (settled) return;
				if (batched + audio.length > STREAM_AUDIO_BATCH_SAMPLES) {
					flushBatch();
					if (audio.length >= STREAM_AUDIO_BATCH_SAMPLES) {
						worker.send({ type: "stream_audio", id, audio });
						return;
					}
				}
				batch.set(audio, batched);
				batched += audio.length;
				if (batched === STREAM_AUDIO_BATCH_SAMPLES) flushBatch();
			},
			stop: () => {
				if (!settled) {
					flushBatch();
					worker.send({ type: "stream_stop", id });
				}
				return promise;
			},
			cancel: () => {
				if (settled) return;
				worker.send({ type: "stream_cancel", id });
				finish(() => resolve(""));
			},
		};
		if (signal?.aborted) handle.cancel();
		else signal?.addEventListener("abort", onAbort, { once: true });
		return handle;
	}

	downloadModel(modelKey: SttModelKey, options: SttDownloadOptions = {}): Promise<SttDownloadResult> {
		return this.#host.downloadModel(modelKey, options);
	}

	terminate(): Promise<void> {
		return this.#host.terminate();
	}

	#handleMessage(message: ModelWorkerMessage<SttWorkerOutbound>): void {
		if (message.type === "partial" || message.type === "segment" || message.type === "stream_done") {
			const stream = this.#streams.get(message.id);
			if (!stream) return;
			if (message.type === "partial") stream.onPartial?.(message.text);
			else if (message.type === "segment") stream.onSegment?.(message.text, message.index);
			else stream.finish(() => stream.resolve(message.text));
			return;
		}

		const pending = this.#host.pending.get(message.id);
		if (!pending) {
			if (message.type === "error") {
				const stream = this.#streams.get(message.id);
				if (stream) {
					this.#host.emitProgress({ modelKey: stream.modelKey, status: "error" }, message.error);
					stream.finish(() => stream.reject(new Error(message.error)));
				}
			}
			return;
		}
		this.#host.deletePending(message.id);
		if (message.type === "transcription") {
			if (pending.kind === "transcribe") pending.resolve(message.text);
			return;
		}
		// message.type === "error"
		this.#host.emitProgress({ modelKey: pending.modelKey, status: "error" }, message.error);
		if (pending.kind === "transcribe") pending.reject(new Error(message.error));
		else pending.resolve({ ok: false, error: message.error });
	}

	#failStreams(error: Error): void {
		for (const stream of Array.from(this.#streams.values())) {
			this.#host.emitProgress({ modelKey: stream.modelKey, status: "error" }, error.message);
			stream.finish(() => stream.reject(error));
		}
	}
}

export const sttClient = new SttClient();

/** @deprecated Use `sttClient.terminate()`. Will be removed in the next major. */
export async function shutdownSttClient(): Promise<void> {
	await sttClient.terminate();
}

export async function smokeTestSttWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await smokeTestWorker(
		wrapRefCountedSubprocess<SttWorkerInbound, SttWorkerOutbound>(createSttSubprocess(), "stt"),
		"stt worker",
		timeoutMs,
	);
}
