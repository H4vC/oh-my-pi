import * as fs from "node:fs";
import * as path from "node:path";

// Promise caches: concurrent discovery providers asking for the same path share
// one in-flight stat/read instead of each issuing its own syscalls.
const contentCache = new Map<string, Promise<string | null>>();
const dirCache = new Map<string, Promise<fs.Dirent[]>>();

/**
 * Content entries hold whole file bodies and the cache lives until reset(), so
 * cwd changes, worktrees and subagent cwds would otherwise grow it without
 * bound. Oldest entries are evicted first; a later miss simply re-reads.
 */
const MAX_CONTENT_ENTRIES = 2048;

function resolvePath(filePath: string): string {
	return path.resolve(filePath);
}

async function loadFile(abs: string): Promise<string | null> {
	try {
		// Gate on the file type first: discovery scans foreign config dirs
		// (~/.claude, ~/.cursor, project trees), and reading a FIFO/socket/char
		// device with `.text()` blocks until EOF — i.e. forever — hanging
		// startup with zero output. `stat` follows symlinks, so symlinked
		// context files (CLAUDE.md -> AGENTS.md) still resolve.
		const stats = await fs.promises.stat(abs);
		if (!stats.isFile()) return null;
		return await Bun.file(abs).text();
	} catch {
		return null;
	}
}

export function readFile(filePath: string): Promise<string | null> {
	const abs = resolvePath(filePath);
	let pending = contentCache.get(abs);
	if (!pending) {
		if (contentCache.size >= MAX_CONTENT_ENTRIES) {
			const oldest = contentCache.keys().next().value;
			if (oldest !== undefined) contentCache.delete(oldest);
		}
		pending = loadFile(abs);
		contentCache.set(abs, pending);
	}
	return pending;
}

export function readDirEntries(dirPath: string): Promise<fs.Dirent[]> {
	const abs = resolvePath(dirPath);
	let pending = dirCache.get(abs);
	if (!pending) {
		pending = fs.promises.readdir(abs, { withFileTypes: true }).catch(() => []);
		dirCache.set(abs, pending);
	}
	return pending;
}

export async function readDir(dirPath: string): Promise<string[]> {
	const entries = await readDirEntries(dirPath);
	return entries.map(entry => entry.name);
}

/** @deprecated Unused; {@link findRepoRoot} covers the walk-up in use. Will be removed in the next major. */
export async function walkUp(
	startDir: string,
	name: string,
	opts: { file?: boolean; dir?: boolean } = {},
): Promise<string | null> {
	const { file = true, dir = true } = opts;
	let current = resolvePath(startDir);

	while (true) {
		const entries = await readDirEntries(current);
		const entry = entries.find(e => e.name === name);
		if (entry) {
			if (file && entry.isFile()) return path.join(current, name);
			if (dir && entry.isDirectory()) return path.join(current, name);
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Walk up from startDir looking for a `.git` entry (file or directory).
 * Returns the directory containing `.git` (the repo root), or null if not in a git repo.
 * Results are based on the cached readDirEntries, so repeated calls are cheap.
 */
export async function findRepoRoot(startDir: string): Promise<string | null> {
	let current = resolvePath(startDir);
	while (true) {
		const entries = await readDirEntries(current);
		if (entries.some(e => e.name === ".git")) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function cacheStats(): { content: number; dir: number } {
	return {
		content: contentCache.size,
		dir: dirCache.size,
	};
}

export function clearCache(): void {
	contentCache.clear();
	dirCache.clear();
}

export function invalidate(filePath: string): void {
	const abs = resolvePath(filePath);
	contentCache.delete(abs);
	dirCache.delete(abs);
	const parent = path.dirname(abs);
	if (parent !== abs) {
		dirCache.delete(parent);
	}
}
