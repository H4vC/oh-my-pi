/**
 * Pull plain-text user/assistant messages out of a session manager.
 *
 * These `{role, content, timestamp}` records are our internal conversation
 * shape. The Hindsight retain API ultimately receives a serialized transcript
 * string, so we drop tool calls, tool results, bash execution wrappers, custom
 * messages, and anything else that isn't a primary conversation turn. Each
 * surviving message's `TextContent` parts are joined with newlines. The
 * SessionEntry timestamp is preserved on the internal record as the source
 * event time.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "../session/session-entries";
import { type HindsightMessage, hasSubstantiveContent } from "./content";

export interface ReadonlySessionManagerLike {
	getEntries(): SessionEntry[];
}

/**
 * Walk session entries top-to-bottom, returning a flat user/assistant list.
 *
 * Implementation choices:
 * - Skip entries whose type isn't `"message"` (compaction, branch_summary,
 *   custom_message, tool exec records, ...). Those don't represent a
 *   conversational turn, only the LLM's plain-text utterances do.
 * - Skip messages whose role isn't `"user"` or `"assistant"`. We deliberately
 *   ignore `toolResult`, `bashExecution`, `hookMessage`, etc. — they're noise
 *   for memory purposes.
 * - For assistant messages, only `text` blocks contribute. Thinking and
 *   toolCall blocks are intentionally dropped: the user never saw them, so
 *   retaining them would prime recall on internal monologue.
 */
export function extractMessages(sessionManager: ReadonlySessionManagerLike): HindsightMessage[] {
	const messages: HindsightMessage[] = [];

	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		const role = msg.role;
		if (role !== "user" && role !== "assistant") continue;

		const text = role === "user" ? extractUserText(msg) : extractAssistantText(msg as AssistantMessage);
		if (!hasSubstantiveContent(text)) continue;
		messages.push({ role, content: text, timestamp: entry.timestamp });
	}

	return messages;
}

/**
 * Reduce arbitrary AgentMessages into the flat user/assistant text shape, with
 * the same text extraction and substantive-content filter as {@link extractMessages}.
 */
export function flattenAgentMessages(messages: readonly AgentMessage[]): HindsightMessage[] {
	const out: HindsightMessage[] = [];
	for (const msg of messages) {
		if (!("role" in msg) || (msg.role !== "user" && msg.role !== "assistant")) continue;
		const text = msg.role === "user" ? extractUserText(msg) : extractAssistantText(msg);
		if (hasSubstantiveContent(text)) out.push({ role: msg.role, content: text });
	}
	return out;
}

/** Substantive-content verdict per user message object; entries replace (never mutate) messages. */
const userTurnVerdicts = new WeakMap<object, boolean>();

/**
 * Count user turns exactly as `extractMessages(sessionManager).filter(m => m.role === "user").length`,
 * without extracting assistant text or allocating the message list. Per-message verdicts are memoized,
 * so repeated calls on a growing session only inspect new user messages.
 */
export function countUserTurns(sessionManager: ReadonlySessionManagerLike): number {
	let count = 0;
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const msg = entry.message;
		let substantive = userTurnVerdicts.get(msg);
		if (substantive === undefined) {
			substantive = hasSubstantiveContent(extractUserText(msg));
			userTurnVerdicts.set(msg, substantive);
		}
		if (substantive) count++;
	}
	return count;
}

function extractUserText(msg: { content: unknown }): string {
	const content = msg.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const maybeText = block as { type?: unknown; text?: unknown };
		if (maybeText.type === "text" && typeof maybeText.text === "string") {
			parts.push(maybeText.text);
		}
	}
	return parts.join("\n");
}

function extractAssistantText(msg: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of msg.content) {
		if (block.type === "text" && block.text) parts.push(block.text);
	}
	return parts.join("\n");
}
