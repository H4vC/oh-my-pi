/**
 * Dependency-free on purpose: browser bundles import this via the
 * `@oh-my-pi/pi-utils/task-result` subpath, never the root barrel.
 */

const TASK_RESULT_BODY = /<(output|preview)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/\1>/;

/**
 * Task job results are delivered in the model-facing `<task-result>` envelope
 * so the parent agent can parse status and the `agent://` pointer. The wrapper
 * markup is noise to a human — returns the trimmed inner `<output>`/`<preview>`
 * body, or `text` unchanged when it is not an envelope or the body is empty.
 */
export function stripTaskResultEnvelope(text: string): string {
	if (!text.startsWith("<task-result")) return text;
	const body = TASK_RESULT_BODY.exec(text)?.[2];
	return body?.trim() || text;
}
