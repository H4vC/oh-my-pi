import { formatConventionalCommit } from "./conventional/normalization";
import type { ConventionalAnalysis } from "./types";

/**
 * @deprecated Duplicate of `formatConventionalCommit` from `commit/conventional/normalization`
 * (pass `body: details.map(d => d.text.trim())`, `footers: []`). Will be removed in the next major.
 */
export function formatCommitMessage(analysis: ConventionalAnalysis, summary: string): string {
	return formatConventionalCommit({
		type: analysis.type,
		scope: analysis.scope,
		summary,
		body: analysis.details.map(detail => detail.text.trim()),
		footers: [],
	});
}
