/**
 * Session-level extension discovery and loading, kept out of sdk.ts so
 * one-shot CLI commands (`omp models`, `omp usage`, `omp bench`, ...) can load
 * extension providers without evaluating the full agent-session graph.
 * sdk.ts re-exports every function here for the public SDK surface.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { EffectiveExtensionRoots } from "../../capability/types";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { EventBus } from "../../utils/event-bus";
import { cfgDisabledExtensions, cfgExtensions } from "../settings";
import { discoverExtensionPaths, loadExtensions } from "./loader";
import type { LoadExtensionsResult } from "./types";

/** Extension-discovery subset of `CreateAgentSessionOptions`. */
export interface ExtensionDiscoveryOptions {
	/** Additional extension paths to load (merged with discovery). */
	additionalExtensionPaths?: string[];
	/** Disable extension discovery (explicit paths still load). */
	disableExtensionDiscovery?: boolean;
	/** Live extension-root policy inherited by a child session. */
	extensionRoots?: () => EffectiveExtensionRoots;
	/** Include ambient hook factories. Disable for read-only catalog commands. */
	includeAmbientHooks?: boolean;
}

export interface CliExtensionProviderOptions extends ExtensionDiscoveryOptions {
	/** Discover extension model catalogs after registration (default true); usage-only commands skip it. */
	discoverModels?: boolean;
}

/**
 * Path-only counterpart of {@link loadSessionExtensions}: the FS-heavy scan
 * without the per-session module load. Subagents reuse the parent's path list
 * (cached on `ToolSession.extensionPaths`) and rebuild Extension
 * instances themselves so each session's `ExtensionAPI` (cwd, eventBus,
 * runtime) is its own.
 */
export async function discoverSessionExtensionPaths(
	options: ExtensionDiscoveryOptions,
	cwd: string,
	settings: Settings,
): Promise<string[]> {
	const roots = options.extensionRoots?.();
	const explicit = roots?.explicit ?? options.additionalExtensionPaths ?? [];
	const explicitOnly = roots ? roots.mode === "explicit-only" : options.disableExtensionDiscovery;
	const configuredPaths = explicitOnly
		? [...explicit]
		: [...explicit, ...(roots?.configured ?? cfgExtensions.get(settings))];
	const disabledExtensionIds = explicitOnly ? undefined : cfgDisabledExtensions.get(settings);
	return discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds, {
		ambient: !explicitOnly,
		includeAmbientHooks: options.includeAmbientHooks,
	});
}

/**
 * Load the discovered/configured extensions for a session — everything
 * `createAgentSession` would load except the inline factory extensions it appends
 * itself. Extracted so the CLI can resolve extension-registered flags (and thus
 * classify `@file` arguments extension-aware) *before* a session — and its
 * terminal breadcrumb — is created, then hand the result back through
 * `CreateAgentSessionOptions.preloadedExtensions` so the work is not
 * repeated. Keep this the single source of the discovery branch logic.
 */
export async function loadSessionExtensions(
	options: ExtensionDiscoveryOptions,
	cwd: string,
	settings: Settings,
	eventBus: EventBus,
): Promise<LoadExtensionsResult> {
	const paths = await discoverSessionExtensionPaths(options, cwd, settings);
	const result = await logger.time("loadExtensions", loadExtensions, paths, cwd, eventBus);
	for (const { path, error } of result.errors) {
		logger.error("Failed to load extension", { path, error });
	}
	return result;
}

/**
 * Load discovered/configured extensions and register their providers into
 * `modelRegistry`, then discover the dynamic provider catalogs. One-shot CLIs
 * (`omp bench`, dry-balance) build a bare {@link ModelRegistry} that only knows
 * built-in catalog providers; without this, providers contributed by an
 * extension (e.g. a custom OpenAI-compatible provider under
 * `~/.omp/agent/extensions/`) never reach model resolution. Mirrors the
 * session / `omp models` path: drain the queued provider registrations, then
 * `refreshRuntimeProviders` so dynamically-discovered models exist before
 * selectors are resolved, unless `discoverModels: false` (e.g. `omp usage`,
 * which needs only registered usage providers).
 */
export async function loadCliExtensionProviders(
	modelRegistry: ModelRegistry,
	settings: Settings,
	cwd: string,
	options: CliExtensionProviderOptions = {},
): Promise<void> {
	const eventBus = new EventBus();
	const extensionsResult = await loadSessionExtensions(options, cwd, settings, eventBus);
	const activeSources = extensionsResult.extensions.map(extension => extension.path);
	modelRegistry.syncExtensionSources(activeSources);
	for (const sourceId of new Set(activeSources)) {
		modelRegistry.clearSourceRegistrations(sourceId);
	}
	for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config, sourceId);
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	if (options.discoverModels !== false) await modelRegistry.refreshRuntimeProviders();
}
