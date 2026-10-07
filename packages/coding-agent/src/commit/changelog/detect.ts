import * as fs from "node:fs";
import * as path from "node:path";
import type { ChangelogBoundary } from "../../commit/types";

const CHANGELOG_NAME = "CHANGELOG.md";

export async function detectChangelogBoundaries(cwd: string, stagedFiles: string[]): Promise<ChangelogBoundary[]> {
	const boundaries = new Map<string, string[]>();
	const root = path.resolve(cwd);
	// Staged files cluster in shared directories; resolve each directory (and its ancestors) once.
	const nearestByDir = new Map<string, Promise<string | null>>();
	const findNearestChangelog = (dir: string): Promise<string | null> => {
		let pending = nearestByDir.get(dir);
		if (!pending) {
			pending = (async () => {
				const candidate = path.resolve(dir, CHANGELOG_NAME);
				try {
					await fs.promises.access(candidate);
					return candidate;
				} catch {
					// not found, continue traversal
				}
				if (dir === root) return null;
				const parent = path.dirname(dir);
				if (parent === dir) return null;
				return findNearestChangelog(parent);
			})();
			nearestByDir.set(dir, pending);
		}
		return pending;
	};

	for (const file of stagedFiles) {
		if (file.toLowerCase().endsWith("changelog.md")) continue;
		const changelogPath = await findNearestChangelog(path.resolve(cwd, path.dirname(file)));
		if (!changelogPath) continue;
		const list = boundaries.get(changelogPath) ?? [];
		list.push(file);
		boundaries.set(changelogPath, list);
	}

	return Array.from(boundaries.entries()).map(([changelogPath, files]) => ({
		changelogPath,
		files,
	}));
}
