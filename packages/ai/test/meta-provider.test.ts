import { describe, expect, test } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { META_MUSE_STATIC_MODELS } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const loginMeta = getProviderDefinition("meta")!.login!;

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function capturePayload(reasoning: Effort): Promise<Record<string, unknown>> {
	const model = buildModel(META_MUSE_STATIC_MODELS[0]!) as Model<"openai-responses">;
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamOpenAIResponses(model, context, {
		apiKey: "meta-test-key",
		reasoning,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

describe("Meta Model API Responses requests", () => {
	test("sends native xhigh reasoning and requests encrypted replay state", async () => {
		const payload = await capturePayload(Effort.XHigh);
		expect(payload.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
		expect(payload.include).toEqual(["reasoning.encrypted_content"]);
	});

	test("preserves native minimal reasoning without clamping it", async () => {
		const payload = await capturePayload(Effort.Minimal);
		expect(payload.reasoning).toEqual({ effort: "minimal", summary: "auto" });
	});
});

describe("Meta Model API login", () => {
	test("paste menu option validates the key against the models endpoint without running inference", async () => {
		let requestedUrl = "";
		let authorization = "";
		let promptCount = 0;
		const apiKey = await loginMeta({
			onAuth: () => {},
			onPrompt: async () => {
				promptCount += 1;
				// First prompt is the method menu; pick paste, then supply the key.
				return promptCount === 1 ? "2" : " meta-test-key ";
			},
			fetch: (input, init) => {
				requestedUrl = String(input);
				authorization = new Headers(init?.headers).get("Authorization") ?? "";
				return Promise.resolve(Response.json({ data: [{ id: "muse-spark-1.1" }] }));
			},
		});

		expect(apiKey).toBe("meta-test-key");
		expect(promptCount).toBe(2);
		expect(requestedUrl).toBe("https://api.meta.ai/v1/models");
		expect(authorization).toBe("Bearer meta-test-key");
	});
});
