/**
 * Meta Model API account sign-in — the `meta` custom login hook declared in
 * `rules/auth/meta.kdl`. Mirrors Muse Code's first-run menu: browser sign-in
 * (RFC 8628 device authorization against `auth.meta.com`, then minting a
 * Model API key from the account grant at `api.meta.ai/muse-code/key`) or
 * pasting a dashboard key (MMA accounts and CI cannot use browser sign-in).
 *
 * The POC stores the minted key, not the account grant: this hook returns a
 * plain API-key string, which `AuthStorage.login` persists as an `api_key`
 * row (`source: "login"`) under provider `meta` — the existing transport
 * picks it up unchanged. Account tokens are discarded after minting.
 *
 * Wire shapes below come from static RE of muse-x86-linux 1.0.2-R2040.1:
 * no User-Agent is sent; the version is pinned via `x-api-version: 1.0.0`.
 * The mint body/schema was inferred from the binary and confirmed against a
 * live Meta account sign-in.
 */

import { $env } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { validateApiKeyAgainstModelsEndpoint } from "../api-key-validation";
import { type OAuthDeviceCodePollResult, pollOAuthDeviceCodeFlow } from "./device-code";
import type { OAuthController } from "./types";

const META_DASHBOARD_URL = "https://developer.meta.com/ai/";
const META_DASHBOARD_INSTRUCTIONS = "Create or copy your key from the Meta Model API dashboard";
const META_MODELS_URL = "https://api.meta.ai/v1/models";

const META_AUTH_BASE_URL = "https://auth.meta.com";
const META_API_BASE_URL = "https://api.meta.ai";
const META_OAUTH_DEVICE_URL = `${META_AUTH_BASE_URL}/oidc/device/authorization/`;
const META_OAUTH_TOKEN_URL = `${META_AUTH_BASE_URL}/oidc/device/token/`;
const META_MINT_URL = `${META_API_BASE_URL}/muse-code/key`;
const META_X_API_VERSION = "1.0.0";
const META_ONBOARD_URL = "https://dev.meta.ai";

// Muse Code's OAuth client id, borrowed as a POC mock pending a Meta-issued
// client id for omp (user in talks). `MUSE_CLIENT_ID` overrides it so the swap
// needs no rebuild.
const DEFAULT_META_CLIENT_ID = "1031625952748946";

const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

const META_LOGIN_CHOICE_MESSAGE = [
	"How do you want to sign in to Meta Model API?",
	"1. Sign in with browser (Meta account)",
	"2. Paste an API key (dashboard or MMA keys)",
	"Enter 1 or 2",
].join("\n");

interface MetaDeviceAuthorization {
	deviceCode: string;
	userCode: string;
	/** Full verification URL (code pre-embedded when the server provides it). */
	verificationUrl: string;
	expiresInSeconds: number;
	intervalSeconds: number;
}

interface MetaAccountTokens {
	access: string;
}

interface MetaMintedKey {
	apiKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Resolve the OAuth client id: `MUSE_CLIENT_ID` override, else the borrowed Muse default. */
function resolveMetaClientId(): string {
	const override = $env.MUSE_CLIENT_ID?.trim();
	return override && override.length > 0 ? override : DEFAULT_META_CLIENT_ID;
}

/**
 * Validate a Meta auth URL against its scheme and host.
 *
 * The verification URL is opened in the user's browser, so pin it to the
 * Meta auth origin rather than following a response-supplied redirect.
 *
 * @throws OAuthError `Invalid Meta <field>: <url>` when scheme or host fails.
 */
function validateMetaAuthUrl(url: string, field: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new AIError.OAuthError(`Invalid Meta ${field}: ${url}`, {
			kind: "validation",
			provider: "meta",
		});
	}
	if (parsed.protocol !== "https:") {
		throw new AIError.OAuthError(`Invalid Meta ${field}: ${url}`, {
			kind: "validation",
			provider: "meta",
		});
	}
	const host = parsed.hostname.toLowerCase();
	const valid =
		host === "meta.com" || host.endsWith(".meta.com") || host === "facebook.com" || host.endsWith(".facebook.com");
	if (!valid) {
		throw new AIError.OAuthError(`Invalid Meta ${field}: ${url}`, {
			kind: "validation",
			provider: "meta",
		});
	}
	return url;
}

function parseMetaDeviceAuthorization(payload: unknown): MetaDeviceAuthorization {
	if (!isRecord(payload)) {
		throw new AIError.OAuthError("Meta device-code response was not a JSON object.", {
			kind: "validation",
			provider: "meta",
		});
	}
	const deviceCode = typeof payload.device_code === "string" ? payload.device_code.trim() : "";
	const userCode = typeof payload.user_code === "string" ? payload.user_code.trim() : "";
	// RFC 8628 servers commonly omit `verification_uri_complete`; either field
	// is enough to route the user (the code is shown alongside either way).
	const verificationUrl =
		(typeof payload.verification_uri_complete === "string" ? payload.verification_uri_complete.trim() : "") ||
		(typeof payload.verification_uri === "string" ? payload.verification_uri.trim() : "");
	const expiresInSeconds = payload.expires_in;
	const intervalSeconds = payload.interval;
	if (
		!deviceCode ||
		!userCode ||
		!verificationUrl ||
		typeof expiresInSeconds !== "number" ||
		!Number.isFinite(expiresInSeconds) ||
		expiresInSeconds <= 0 ||
		typeof intervalSeconds !== "number" ||
		!Number.isFinite(intervalSeconds) ||
		intervalSeconds <= 0
	) {
		throw new AIError.OAuthError("Meta device-code response missing or invalid required fields.", {
			kind: "validation",
			provider: "meta",
		});
	}
	return {
		deviceCode,
		userCode,
		verificationUrl: validateMetaAuthUrl(verificationUrl, "verification_uri"),
		expiresInSeconds,
		intervalSeconds,
	};
}

/** POST the device-authorization form (client_id only — no scope, per Muse). */
async function requestMetaDeviceAuthorization(
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<MetaDeviceAuthorization> {
	let response: Response;
	try {
		const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
		response = await fetchImpl(META_OAUTH_DEVICE_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
				"x-api-version": META_X_API_VERSION,
			},
			body: new URLSearchParams({ client_id: resolveMetaClientId() }),
			redirect: "error",
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		});
	} catch (error) {
		if (signal?.aborted) throw new AIError.LoginCancelledError();
		throw new AIError.OAuthError(
			`Meta device-code request failed: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "device-auth", provider: "meta", cause: error },
		);
	}
	if (!response.ok) {
		let detail = "";
		try {
			detail = (await response.text()).trim();
		} catch {
			// Status code is the diagnostic when the body is unreadable.
		}
		throw new AIError.OAuthError(`Meta device-code request failed: ${response.status}${detail ? ` ${detail}` : ""}`, {
			kind: "device-auth",
			provider: "meta",
			status: response.status,
		});
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new AIError.OAuthError(
			`Meta device-code response returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "validation", provider: "meta", cause: error },
		);
	}
	return parseMetaDeviceAuthorization(payload);
}

/**
 * Poll the device token endpoint once and classify the outcome. Terminal
 * RFC 8628 errors (`access_denied`, `expired_token`, …) stop the flow; the
 * shared poller translates pending/slow_down into back-off.
 */
async function pollMetaDeviceToken(
	deviceCode: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<OAuthDeviceCodePollResult<MetaAccountTokens>> {
	let response: Response;
	try {
		const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
		response = await fetchImpl(META_OAUTH_TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
				"x-api-version": META_X_API_VERSION,
			},
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: resolveMetaClientId(),
				device_code: deviceCode,
			}),
			redirect: "error",
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		});
	} catch (error) {
		if (signal?.aborted) throw new AIError.LoginCancelledError();
		throw new AIError.OAuthError(
			`Meta device-code token polling failed: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "polling", provider: "meta", cause: error },
		);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new AIError.OAuthError(
			`Meta device-code token polling returned invalid JSON: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{
				kind: "polling",
				provider: "meta",
				status: response.status,
				cause: error,
			},
		);
	}

	const errorCode = isRecord(payload) && typeof payload.error === "string" ? payload.error : "";
	if (errorCode === "authorization_pending") return { status: "pending" };
	if (errorCode === "slow_down") return { status: "slow_down" };

	if (!response.ok || errorCode) {
		const errorDescription =
			isRecord(payload) && typeof payload.error_description === "string" ? payload.error_description : "";
		const detail = errorDescription || errorCode || String(response.status);
		throw new AIError.OAuthError(`Meta device-code sign-in failed: ${detail}`, {
			kind: "device-auth",
			provider: "meta",
			status: response.status,
		});
	}

	const accessToken = isRecord(payload) && typeof payload.access_token === "string" ? payload.access_token.trim() : "";
	if (!accessToken) {
		throw new AIError.OAuthError("Meta device-code token response missing access_token.", {
			kind: "validation",
			provider: "meta",
		});
	}
	return { status: "complete", value: { access: accessToken } };
}

/**
 * Mint a Model API key from an authorized Meta account grant.
 *
 * Terminal account states are surfaced as structured OAuthErrors:
 * not-onboarded → `provisioning` (route to {@link META_ONBOARD_URL});
 * subscription/payment gate → `entitlement` (route to `action_url`).
 */
async function mintMetaModelApiKey(
	accessToken: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<MetaMintedKey> {
	let response: Response;
	try {
		const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
		response = await fetchImpl(META_MINT_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				Accept: "application/json",
				"x-api-version": META_X_API_VERSION,
			},
			body: JSON.stringify({ onboard: true }),
			redirect: "error",
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		});
	} catch (error) {
		if (signal?.aborted) throw new AIError.LoginCancelledError();
		throw new AIError.OAuthError(
			`Meta Model API key mint failed: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "provisioning", provider: "meta", cause: error },
		);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new AIError.OAuthError(
			`Meta Model API key mint returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "validation", provider: "meta", cause: error },
		);
	}
	if (!isRecord(payload)) {
		throw new AIError.OAuthError("Meta Model API key mint response was not a JSON object.", {
			kind: "validation",
			provider: "meta",
		});
	}

	const apiKey = typeof payload.api_key === "string" ? payload.api_key.trim() : "";
	if (apiKey) {
		return { apiKey };
	}

	// Account-gate states (schema inferred from the Muse binary, confirmed on a
	// live account sign-in).
	const errorText = [payload.error, payload.message, payload.error_code]
		.filter((v): v is string => typeof v === "string")
		.join(" ");

	if (payload.require_payment === true || /pay|subscription|plan/i.test(errorText)) {
		const actionUrl = typeof payload.action_url === "string" ? payload.action_url.trim() : "";
		throw new AIError.OAuthError(
			`Meta subscription required to mint a Model API key.${actionUrl ? ` Subscribe here: ${actionUrl}` : ""}`,
			{ kind: "entitlement", provider: "meta", status: response.status },
		);
	}
	if (/onboard|dev\.meta\.ai/i.test(errorText)) {
		throw new AIError.OAuthError(
			`Meta account is not onboarded for Model API. Complete onboarding at ${META_ONBOARD_URL} and try again.`,
			{ kind: "provisioning", provider: "meta", status: response.status },
		);
	}

	throw new AIError.OAuthError(
		`Meta Model API key mint failed: HTTP ${response.status}${errorText ? ` ${errorText}` : ""}`,
		{ kind: "provisioning", provider: "meta", status: response.status },
	);
}

/**
 * Browser sign-in: authorize against the Meta account, poll to approval, mint
 * the Model API key, and discard the account grant.
 *
 * Opens the device verification URL (via `onAuth`), polls until the user
 * approves, mints the key, and returns it. Throws {@link AIError.OAuthError}
 * on denial, expiry, timeout, or account states that block minting.
 */
async function loginMetaAccount(callbacks: OAuthController): Promise<string> {
	const fetchImpl = callbacks.fetch ?? fetch;
	const device = await requestMetaDeviceAuthorization(fetchImpl, callbacks.signal);
	callbacks.onAuth?.({
		url: device.verificationUrl,
		instructions: `Enter code: ${device.userCode}`,
	});
	callbacks.onProgress?.("Waiting for Meta account authorization...");

	const tokens = await pollOAuthDeviceCodeFlow({
		poll: () => pollMetaDeviceToken(device.deviceCode, fetchImpl, callbacks.signal),
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		signal: callbacks.signal,
	});

	callbacks.onProgress?.("Minting Model API key...");
	const minted = await mintMetaModelApiKey(tokens.access, fetchImpl, callbacks.signal);
	return minted.apiKey;
}

/** Paste an API key from the Meta Model API dashboard, validated against /v1/models. */
async function pasteMetaApiKey(callbacks: OAuthController): Promise<string> {
	if (!callbacks.onPrompt) {
		throw new AIError.OnPromptRequiredError("Meta Model API");
	}
	callbacks.onAuth?.({
		url: META_DASHBOARD_URL,
		instructions: META_DASHBOARD_INSTRUCTIONS,
	});
	const answer = await callbacks.onPrompt({
		message: "Paste your Meta Model API key",
		placeholder: "Model API key",
	});
	if (callbacks.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	const trimmed = answer.trim();
	if (!trimmed) {
		throw new AIError.ApiKeyRequiredError();
	}
	callbacks.onProgress?.("Validating API key...");
	await validateApiKeyAgainstModelsEndpoint({
		provider: "Meta Model API",
		apiKey: trimmed,
		modelsUrl: META_MODELS_URL,
		signal: callbacks.signal,
		fetch: callbacks.fetch,
	});
	return trimmed;
}

/**
 * `meta` custom login hook: Muse-Code-style choice between browser sign-in
 * (device flow + mint) and pasting a dashboard key. Enter (empty) defaults to
 * browser sign-in, Muse's primary first-run action; returns the key string
 * either way so `AuthStorage` persists an `api_key` row.
 */
export async function loginMetaHook(callbacks: OAuthController): Promise<string> {
	if (!callbacks.onPrompt) {
		throw new AIError.OnPromptRequiredError("Meta Model API");
	}
	const choice = (
		await callbacks.onPrompt({
			message: META_LOGIN_CHOICE_MESSAGE,
			placeholder: "1",
		})
	).trim();
	if (callbacks.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	if (choice === "2") {
		return pasteMetaApiKey(callbacks);
	}
	return loginMetaAccount(callbacks);
}
