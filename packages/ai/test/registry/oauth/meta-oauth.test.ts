import { describe, expect, it, vi } from "bun:test";
import * as AIError from "../../../src/error";
import { loginMetaHook } from "../../../src/registry/oauth/meta";
import type { FetchImpl } from "../../../src/types";

const DEVICE_URL = "https://auth.meta.com/oidc/device/authorization/";
const TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
const MINT_URL = "https://api.meta.ai/muse-code/key";

const DEVICE_AUTHORIZATION = {
	device_code: "device-code-123",
	user_code: "ABCD-EFGH",
	verification_uri: "https://auth.meta.com/activate",
	verification_uri_complete: "https://auth.meta.com/activate?user_code=ABCD-EFGH",
	expires_in: 600,
	interval: 1,
};

type RecordedRequest = {
	url: string;
	init: RequestInit | undefined;
};

type JsonResponse = {
	body: unknown;
	status?: number;
};

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

type MetaAccountFetchOptions = {
	deviceAuth?: JsonResponse;
	tokenResponses?: readonly JsonResponse[];
	mint?: JsonResponse;
};

function createMetaAccountFetch(options: MetaAccountFetchOptions) {
	const requests: RecordedRequest[] = [];
	let tokenIndex = 0;
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
		requests.push({ url, init });

		if (url === DEVICE_URL) {
			if (!options.deviceAuth) throw new Error(`Unexpected Meta device request ${requests.length}`);
			return jsonResponse(options.deviceAuth.body, options.deviceAuth.status);
		}
		if (url === TOKEN_URL) {
			const tokenResponse = options.tokenResponses?.[tokenIndex];
			tokenIndex += 1;
			if (!tokenResponse) throw new Error(`Unexpected Meta token poll ${tokenIndex}`);
			return jsonResponse(tokenResponse.body, tokenResponse.status);
		}
		if (url === MINT_URL) {
			if (!options.mint) throw new Error(`Unexpected Meta mint request ${requests.length}`);
			return jsonResponse(options.mint.body, options.mint.status);
		}
		throw new Error(`Unexpected Meta request: ${url}`);
	});

	return { fetchMock: fetchMock as unknown as FetchImpl, requests };
}

/** Return the i-th recorded request, failing loudly when the flow made fewer calls than expected. */
function requestAt(requests: readonly RecordedRequest[], index: number): RecordedRequest {
	const request = requests[index];
	if (!request) {
		throw new Error(`Expected a Meta request at index ${index}, got ${requests.length}`);
	}
	return request;
}

function formBody(request: RecordedRequest): URLSearchParams {
	const body = request.init?.body;
	if (!(body instanceof URLSearchParams)) {
		throw new Error("Expected an application/x-www-form-urlencoded body");
	}
	return body;
}

function jsonBody(request: RecordedRequest): unknown {
	const body = request.init?.body;
	if (typeof body !== "string") {
		throw new Error("Expected a JSON string body");
	}
	return JSON.parse(body) as unknown;
}

function headerValue(request: RecordedRequest, name: string): string | undefined {
	return new Headers(request.init?.headers).get(name) ?? undefined;
}

/** Run a browser-arm login (menu choice 1) and return the thrown error (or null on success). */
async function runBrowserLogin(options: MetaAccountFetchOptions): Promise<{
	apiKey: string | null;
	error: unknown;
	requests: RecordedRequest[];
}> {
	const { fetchMock, requests } = createMetaAccountFetch(options);
	try {
		const apiKey = await loginMetaHook({
			fetch: fetchMock,
			onAuth: () => {},
			onProgress: () => {},
			onPrompt: async () => "1",
		});
		return { apiKey, error: null, requests };
	} catch (error) {
		return { apiKey: null, error, requests };
	}
}

const OK_TOKEN_RESPONSE = {
	access_token: "account-access-token",
	refresh_token: "refresh",
	expires_in: 3600,
};

describe("loginMetaHook browser sign-in", () => {
	it("authorizes, polls to approval, mints a key, and returns the minted key", async () => {
		const { fetchMock, requests } = createMetaAccountFetch({
			deviceAuth: { body: DEVICE_AUTHORIZATION },
			tokenResponses: [{ body: { error: "authorization_pending" } }, { body: OK_TOKEN_RESPONSE }],
			mint: { body: { api_key: "minted-key-123" } },
		});

		const authEvents: Array<{ url: string; instructions?: string }> = [];
		const progress: string[] = [];
		const apiKey = await loginMetaHook({
			fetch: fetchMock,
			onAuth: info => authEvents.push(info),
			onProgress: message => progress.push(message),
			onPrompt: async () => "1",
		});

		expect(apiKey).toBe("minted-key-123");
		expect(authEvents).toEqual([
			{
				url: "https://auth.meta.com/activate?user_code=ABCD-EFGH",
				instructions: "Enter code: ABCD-EFGH",
			},
		]);
		expect(progress).toEqual(["Waiting for Meta account authorization...", "Minting Model API key..."]);

		// x-api-version pins every call; no User-Agent is sent (Muse wire parity).
		for (const request of requests) {
			expect(headerValue(request, "x-api-version")).toBe("1.0.0");
			expect(headerValue(request, "user-agent")).toBeUndefined();
		}
		expect(requests.map(request => request.url)).toEqual([DEVICE_URL, TOKEN_URL, TOKEN_URL, MINT_URL]);
		expect(formBody(requestAt(requests, 0)).get("client_id")).toBe("1031625952748946");
		const poll = formBody(requestAt(requests, 2));
		expect(poll.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
		expect(poll.get("device_code")).toBe("device-code-123");
		const mint = requestAt(requests, 3);
		expect(headerValue(mint, "Authorization")).toBe("Bearer account-access-token");
		expect(jsonBody(mint)).toEqual({ onboard: true });
	});

	it("defaults an empty menu choice to browser sign-in like Muse's primary action", async () => {
		const { fetchMock, requests } = createMetaAccountFetch({
			deviceAuth: { body: DEVICE_AUTHORIZATION },
			tokenResponses: [{ body: OK_TOKEN_RESPONSE }],
			mint: { body: { api_key: "minted-key-123" } },
		});

		const apiKey = await loginMetaHook({
			fetch: fetchMock,
			onAuth: () => {},
			onPrompt: async () => "",
		});

		expect(apiKey).toBe("minted-key-123");
		expect(requests.map(request => request.url)).toEqual([DEVICE_URL, TOKEN_URL, MINT_URL]);
	});

	it("falls back to verification_uri and surfaces the code when _complete is absent", async () => {
		const { fetchMock, requests } = createMetaAccountFetch({
			deviceAuth: {
				body: { ...DEVICE_AUTHORIZATION, verification_uri_complete: undefined },
			},
			tokenResponses: [{ body: OK_TOKEN_RESPONSE }],
			mint: { body: { api_key: "minted-key-123" } },
		});
		const authEvents: Array<{ url: string; instructions?: string }> = [];
		await loginMetaHook({
			fetch: fetchMock,
			onAuth: info => authEvents.push(info),
			onPrompt: async () => "1",
		});

		expect(authEvents).toEqual([
			{
				url: "https://auth.meta.com/activate",
				instructions: "Enter code: ABCD-EFGH",
			},
		]);
		expect(requests).toHaveLength(3);
	});

	it("rejects terminal access_denied without minting", async () => {
		const { error, requests } = await runBrowserLogin({
			deviceAuth: { body: DEVICE_AUTHORIZATION },
			tokenResponses: [
				{
					body: {
						error: "access_denied",
						error_description: "User denied the request",
					},
				},
			],
			mint: { body: { api_key: "never" } },
		});

		expect(error).toBeInstanceOf(AIError.OAuthError);
		expect(String(error)).toMatch(/denied the request/);
		expect(requests.map(request => request.url)).toEqual([DEVICE_URL, TOKEN_URL]);
	});

	it("rejects an expired device code", async () => {
		const { error, requests } = await runBrowserLogin({
			deviceAuth: { body: DEVICE_AUTHORIZATION },
			tokenResponses: [{ body: { error: "expired_token" } }],
			mint: { body: { api_key: "never" } },
		});

		expect(error).toBeInstanceOf(AIError.OAuthError);
		expect((error as AIError.OAuthError).kind).toBe("device-auth");
		expect(String(error)).toMatch(/expired_token/);
		expect(requests).toHaveLength(2);
	});

	it("classifies a slow_down token response as a retry, not a failure", async () => {
		const { apiKey, requests } = await runBrowserLogin({
			deviceAuth: { body: DEVICE_AUTHORIZATION },
			tokenResponses: [{ body: { error: "slow_down" } }, { body: OK_TOKEN_RESPONSE }],
			mint: { body: { api_key: "minted-key-123" } },
		});

		// RFC 8628 slow_down back-off (+5s per response) makes this poll cadence
		// real: allow the retry sleep inside the helper to elapse.
		expect(apiKey).toBe("minted-key-123");
		expect(requests.map(request => request.url)).toEqual([DEVICE_URL, TOKEN_URL, TOKEN_URL, MINT_URL]);
	}, 15_000);
});

describe("loginMetaHook mint states", () => {
	it("maps require_payment to an entitlement error carrying the action URL", async () => {
		const { error } = await runBrowserLogin({
			deviceAuth: { body: DEVICE_AUTHORIZATION },
			tokenResponses: [{ body: OK_TOKEN_RESPONSE }],
			mint: {
				body: {
					require_payment: true,
					action_url: "https://www.meta.ai/subscribe",
				},
			},
		});

		expect(error).toBeInstanceOf(AIError.OAuthError);
		expect((error as AIError.OAuthError).kind).toBe("entitlement");
		expect(String(error)).toMatch(/https:\/\/www\.meta\.ai\/subscribe/);
	});

	it("maps not-onboarded to a provisioning error routing to dev.meta.ai", async () => {
		const { error } = await runBrowserLogin({
			deviceAuth: { body: DEVICE_AUTHORIZATION },
			tokenResponses: [{ body: OK_TOKEN_RESPONSE }],
			mint: {
				body: { error: "account not onboarded", status: 400 },
				status: 400,
			},
		});

		expect(error).toBeInstanceOf(AIError.OAuthError);
		expect((error as AIError.OAuthError).kind).toBe("provisioning");
		expect(String(error)).toMatch(/dev\.meta\.ai/);
	});

	it("propagates a failed device-code request as a device-auth error", async () => {
		const { error } = await runBrowserLogin({
			deviceAuth: { body: { error: "server_error" }, status: 500 },
		});

		expect(error).toBeInstanceOf(AIError.OAuthError);
		expect((error as AIError.OAuthError).kind).toBe("device-auth");
	});
});
