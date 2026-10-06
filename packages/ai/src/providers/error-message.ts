import type { Api, AssistantMessage, Model, Usage } from "../types";

/** Usage of a message that has not been billed for anything yet. */
export function createEmptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Empty `AssistantMessage` that a streaming provider accumulates into. */
export function createEmptyAssistantMessage(
	api: Api,
	provider: string,
	modelId: string,
	timestamp = Date.now(),
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider,
		model: modelId,
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp,
	};
}

export function createProviderErrorMessage(model: Model<Api>, err: unknown) {
	const errorMessage = err instanceof Error ? err.message : String(err);
	return {
		role: "assistant" as const,
		content: [],
		errorMessage,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: "error" as const,
		timestamp: Date.now(),
	};
}
