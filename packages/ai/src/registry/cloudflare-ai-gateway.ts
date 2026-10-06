import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { apiRouteFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
	parseCloudflareAiGatewayCredential,
} from "@oh-my-pi/pi-catalog/wire/cloudflare-ai-gateway";
import { $env } from "@oh-my-pi/pi-utils";
import { NO_AUTH_SENTINEL } from "../auth-retry";
import * as AIError from "../error";
import type { Api, Model } from "../types";
import type { ProviderTransport } from "./build";

/**
 * `prepareModel` runs per request, and the OpenAI-compat route rebuilds the
 * model through the full compat engine. Models are immutable once built, so
 * the rebuilt route is kept per source object; `id` and `baseUrl` pick the
 * route and are re-checked so a caller that edits them in place still
 * re-resolves.
 */
const compatRouteModels = new WeakMap<Model<Api>, { id: string; baseUrl: string; prepared: Model<Api> }>();

/** Cloudflare AI Gateway model/request shaping; login lives in `oauth/cloudflare-ai-gateway.ts` + its auth rule. */
export const cloudflareAiGatewayTransport: ProviderTransport = {
	prepareModel: model => {
		const hasGatewayPlaceholders = model.baseUrl.includes("<account>") || model.baseUrl.includes("<gateway>");
		const route = apiRouteFor("cloudflare-ai-gateway", model.id);
		if (!route) return model;
		if (route.api === "anthropic-messages") {
			const requestModelId = (route.requestModelId ?? model.id).replaceAll(".", "-");
			const baseUrl = hasGatewayPlaceholders ? CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL : model.baseUrl;
			if (
				model.api === "anthropic-messages" &&
				model.baseUrl === baseUrl &&
				model.requestModelId === requestModelId
			) {
				return model;
			}
			return {
				...model,
				api: "anthropic-messages",
				baseUrl,
				requestModelId,
			};
		}
		if (route.api === "openai-completions") {
			const isOpenAIRoute = route.requestModelId !== undefined;
			const baseUrl = hasGatewayPlaceholders
				? isOpenAIRoute
					? CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL
					: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL
				: model.baseUrl;
			if (
				model.api === "openai-completions" &&
				model.baseUrl === baseUrl &&
				model.requestModelId === route.requestModelId
			) {
				return model;
			}
			const cached = compatRouteModels.get(model);
			if (cached && cached.id === model.id && cached.baseUrl === model.baseUrl) return cached.prepared;
			const prepared = buildModel({
				...model,
				api: "openai-completions",
				baseUrl,
				compat: model.compatConfig,
				...(route.requestModelId !== undefined ? { requestModelId: route.requestModelId } : {}),
			});
			compatRouteModels.set(model, { id: model.id, baseUrl: model.baseUrl, prepared });
			return prepared;
		}
		return model;
	},
	prepareRequest: (model, options) => {
		const credential = parseCloudflareAiGatewayCredential(options.apiKey ?? $env.CLOUDFLARE_AI_GATEWAY_API_KEY ?? "");
		if (!credential) return { model, options };
		const accountId = credential.accountId ?? $env.CLOUDFLARE_ACCOUNT_ID;
		const gatewayId = credential.gatewayId ?? $env.CLOUDFLARE_GATEWAY_ID;
		let baseUrl = model.baseUrl;
		if (baseUrl.startsWith(CLOUDFLARE_AI_GATEWAY_BASE_URL)) {
			if (!accountId) throw new AIError.ConfigurationError("Cloudflare account ID is required");
			if (!gatewayId) throw new AIError.ConfigurationError("Cloudflare AI Gateway ID is required");
			baseUrl = baseUrl.replace("<account>", accountId).replace("<gateway>", gatewayId);
		}

		const isAnthropic = model.api === "anthropic-messages";
		let headers = model.headers;
		if (!isAnthropic) {
			headers = { ...headers };
			for (const name in headers) {
				const normalized = name.toLowerCase();
				if (normalized === "authorization" || normalized === "x-api-key") delete headers[name];
			}
			headers["cf-aig-authorization"] = `Bearer ${credential.token}`;
		}
		return {
			model: { ...model, baseUrl, headers },
			options: { ...options, apiKey: isAnthropic ? credential.token : NO_AUTH_SENTINEL },
		};
	},
};
