/**
 * Memoized proxy-reference index over the bundled model catalog.
 *
 * Lazy: walking every bundled model (~12K) triggers thinking enrichment, so the
 * walk is deferred off module load and performed once. Consumers that need
 * non-bundled reference data use the pure builder directly
 * ({@link buildModelReferenceIndex}).
 */
import { isBareIdReferenceProvider } from "../compat/behavior";
import { getBundledModelList, getBundledProviders } from "../models";
import { buildModelReferenceIndex, type ModelReferenceIndex } from "./reference";

let referenceIndex: ModelReferenceIndex | undefined;

/** Proxy-reference index over the bundled catalog. */
export function getBundledModelReferenceIndex(): ModelReferenceIndex {
	referenceIndex ??= buildModelReferenceIndex(
		getBundledProviders()
			.filter(isBareIdReferenceProvider)
			.flatMap(provider => getBundledModelList(provider as Parameters<typeof getBundledModelList>[0])),
	);
	return referenceIndex;
}
