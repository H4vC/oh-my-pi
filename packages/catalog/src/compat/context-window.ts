import type { Model } from "../types";
import { resolveCatalogPolicy } from "./catalog-policy";

/**
 * Extended-context capacity. Curated maxima correct stale lower discovery
 * values; a higher live maximum still wins. The registry applies this capacity
 * only when extended context is enabled, before explicit user overrides.
 *
 * Override ceiling for Codex models too: upstream clamps `model_context_window`
 * to `min(override, max_context_window)` (`with_config_overrides` in
 * `models-manager/src/model_info.rs`); the ceiling here is stale-aware — the
 * curated maximum corrects a lower server value (Astra reports a stale 872K
 * maximum; OpenAI documents at most 922K input) while a higher live maximum
 * still wins. No curated or live maximum means no ceiling: overrides pass
 * through, matching upstream's unclamped branch.
 */
export function resolveMaxContextWindow(model: Model): number | undefined {
	const ruleMaximum = resolveCatalogPolicy(model).maxContextWindow;
	const curated =
		typeof ruleMaximum === "number" && Number.isFinite(ruleMaximum) && ruleMaximum > 0 ? ruleMaximum : undefined;
	const maximum = model.maxContextWindow;
	if (typeof maximum === "number" && Number.isFinite(maximum) && maximum > 0) {
		return Math.max(maximum, curated ?? 0);
	}
	return curated;
}

/**
 * @deprecated Identical to {@link resolveMaxContextWindow}; use that instead. Will be removed in the next major.
 */
export function codexOverrideCeiling(model: Model): number | undefined {
	return resolveMaxContextWindow(model);
}

/**
 * Whether explicit context-window overrides for this model clamp to the
 * server-honored ceiling. KDL-owned (`clamp-context-override`): branching on
 * it here keeps provider deployment contracts out of TypeScript.
 */
export function clampsContextOverride(model: Model): boolean {
	return resolveCatalogPolicy(model).clampContextOverride === true;
}

/**
 * Clamp a requested Codex context window to the override ceiling, mirroring
 * upstream. `model` is the pre-override model: the ceiling never shrinks the
 * request below the window that already works, so a stale-low live maximum
 * (e.g. 128K base with a 64K advertised maximum) cannot punish an explicit
 * override. Returns the request unchanged when no ceiling applies or it
 * already fits.
 */
export function clampCodexContextWindow(model: Model, requested: number): number {
	if (!Number.isFinite(requested) || requested <= 0) {
		return requested;
	}
	const ceiling = resolveMaxContextWindow(model);
	if (ceiling === undefined || requested <= ceiling) {
		return requested;
	}
	const current = model.contextWindow;
	const floor = typeof current === "number" && Number.isFinite(current) && current > 0 ? current : 0;
	return Math.min(requested, Math.max(ceiling, floor));
}
