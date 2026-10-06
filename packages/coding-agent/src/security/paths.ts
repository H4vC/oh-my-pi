/**
 * Normalize a repository-relative path (`\` → `/`, leading `./` dropped). Returns
 * `undefined` for empty, absolute (POSIX or drive-letter) and `..`-escaping paths.
 */
export function normalizeRepositoryRelativePath(value: string): string | undefined {
	const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
	if (
		!normalized ||
		normalized.startsWith("/") ||
		/^[a-zA-Z]:\//.test(normalized) ||
		normalized.split("/").includes("..")
	)
		return undefined;
	return normalized;
}
