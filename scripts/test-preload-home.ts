/**
 * `bun test` preload (see the `[test] preload` entries in the root and package
 * `bunfig.toml` files): points every omp directory at a private, throwaway root
 * so no test reads or writes the developer's real `~/.omp` or XDG directories,
 * on any OS.
 *
 * Runs before any test module loads. Isolation goes through omp's own env
 * (an absolute `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `XDG_*`), never
 * HOME/USERPROFILE: Bun pins `os.homedir()` at process start on POSIX, so
 * rewriting HOME here would give spawned children a different home than this
 * process. Leaving it alone keeps parent and child home resolution identical;
 * tests that exercise `~` itself fake it per test (`spyOn(os, "homedir")`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-home-"));

// Children inherit the temp XDG_CACHE_HOME; keep their Bun transpiler cache
// where it was so every spawned `bun` does not re-transpile from scratch.
process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ??= process.env.XDG_CACHE_HOME
	? path.join(process.env.XDG_CACHE_HOME, "bun", "@t@")
	: path.join(os.homedir(), ".bun", "install", "cache", "@t@");

process.env.PI_CONFIG_DIR = path.join(root, ".omp");
process.env.PI_CODING_AGENT_DIR = path.join(root, ".omp", "agent");
process.env.XDG_CONFIG_HOME = path.join(root, ".config");
process.env.XDG_DATA_HOME = path.join(root, ".local", "share");
process.env.XDG_STATE_HOME = path.join(root, ".local", "state");
process.env.XDG_CACHE_HOME = path.join(root, ".cache");

process.on("exit", () => {
	try {
		fs.rmSync(root, { recursive: true, force: true });
	} catch {
		// Best-effort: a file another process still holds open stays in the OS temp dir.
	}
});
