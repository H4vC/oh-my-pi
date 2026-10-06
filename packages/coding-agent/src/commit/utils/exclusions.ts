const EXCLUDED_FILES = [
	"Cargo.lock",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"shrinkwrap.yaml",
	"bun.lock",
	"bun.lockb",
	"deno.lock",
	"composer.lock",
	"Gemfile.lock",
	"poetry.lock",
	"Pipfile.lock",
	"pdm.lock",
	"uv.lock",
	"go.sum",
	"flake.lock",
	"pubspec.lock",
	"Podfile.lock",
	"Packages.resolved",
	"mix.lock",
	"packages.lock.json",
	"config.yml.lock",
	"config.yaml.lock",
	"settings.yml.lock",
	"settings.yaml.lock",
];

const EXCLUDED_SUFFIXES = [".lock.yml", ".lock.yaml", "-lock.yml", "-lock.yaml"];

/** @deprecated Unused; check membership in `EXCLUDED_LOCK_FILES` from `commit/agentic/lock-files`. Will be removed in the next major. */
export function isExcludedFile(path: string): boolean {
	const lower = path.toLowerCase();
	if (EXCLUDED_FILES.some(name => lower.endsWith(name.toLowerCase()))) {
		return true;
	}
	return EXCLUDED_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

/** @deprecated Unused; filter against `EXCLUDED_LOCK_FILES` from `commit/agentic/lock-files`. Will be removed in the next major. */
export function filterExcludedFiles<T extends { filename: string }>(files: T[]): T[] {
	return files.filter(file => !isExcludedFile(file.filename));
}
