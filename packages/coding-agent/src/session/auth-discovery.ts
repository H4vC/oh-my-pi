/**
 * SDK credential discovery, kept out of sdk.ts so lightweight CLI commands
 * (`omp say`, `omp models`, `omp login`, ...) can build an AuthStorage without
 * evaluating the full agent-session graph. sdk.ts re-exports
 * {@link discoverAuthStorage} for the public SDK surface.
 */
import type { DiscoverAuthStorageOptions } from "@oh-my-pi/pi-ai/auth-broker/discover";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import {
	discoverAuthStorage as discoverAuthStorageFromConfig,
	type EffectiveSettingsScope,
	loadEffectiveAuthAccountPolicyConfig,
} from "./auth-broker-config";
import type { AuthStorage } from "@oh-my-pi/pi-ai";

/**
 * Create an AuthStorage instance.
 *
 * Default: local SQLite store at `<agentDir>/agent.db`.
 *
 * Broker mode: when `OMP_AUTH_BROKER_URL` is set, credentials are pulled from
 * a remote auth-broker over the wire. Refresh tokens never leave the broker;
 * the client receives access tokens with `refresh = "__remote__"` and calls
 * back into the broker through the `AuthStorageOptions.refreshOAuthCredential`
 * override to re-mint access tokens when needed.
 *
 * Account routing (`auth.accountPolicies`, `retry.usageReservePct`) comes from
 * effective settings: `options.settings` when given, else the matching global
 * instance, else a read-only load for `options.cwd`; explicit option values win.
 *
 * Delegates to {@link ./auth-broker-config} so the TUI and the catalog
 * generator share the same credential-discovery logic.
 */
export async function discoverAuthStorage(
	agentDir: string = getAgentDir(),
	options: Omit<DiscoverAuthStorageOptions, "agentDir" | "configValueResolver"> &
		Omit<EffectiveSettingsScope, "agentDir"> = {},
): Promise<AuthStorage> {
	const { settings, cwd, ...discoveryOptions } = options;
	const policy = await loadEffectiveAuthAccountPolicyConfig({ settings, cwd, agentDir });
	return discoverAuthStorageFromConfig(agentDir, {
		...discoveryOptions,
		accountPolicies: discoveryOptions.accountPolicies ?? policy.accountPolicies,
		authStorageOptions: {
			...discoveryOptions.authStorageOptions,
			defaultReservePct: discoveryOptions.authStorageOptions?.defaultReservePct ?? policy.defaultReservePct,
		},
	});
}
