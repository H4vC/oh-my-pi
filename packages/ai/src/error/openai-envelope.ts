/**
 * Reader for the OpenAI-style error body that OpenAI-compatible media
 * endpoints (embeddings, rerank, transcription, video) return on non-2xx.
 */

/** Human-readable detail and machine code pulled from an error body. */
export interface OpenAIErrorEnvelope {
	/** `error.message`, a bare string `error`, or the raw body when neither is present. */
	detail: string;
	/** `error.code` (string or numeric, stringified), else `error.type`. */
	code: string | undefined;
}

/**
 * Parse `{ error: { message, code, type } }` or `{ error: "message" }` from a
 * response body. Bodies that are not JSON or carry no recognisable envelope
 * fall back to the raw text as the detail.
 */
export function readOpenAIErrorEnvelope(text: string): OpenAIErrorEnvelope {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { detail: text, code: undefined };
	}
	if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return { detail: text, code: undefined };
	const { error } = parsed;
	if (typeof error === "string") return { detail: error, code: undefined };
	if (!error || typeof error !== "object") return { detail: text, code: undefined };
	const envelope = error as { message?: unknown; code?: unknown; type?: unknown };
	return {
		detail: typeof envelope.message === "string" ? envelope.message : text,
		code:
			typeof envelope.code === "string" || typeof envelope.code === "number"
				? String(envelope.code)
				: typeof envelope.type === "string"
					? envelope.type
					: undefined,
	};
}
