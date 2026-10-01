import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __resetDirsFromEnvForTests, removeWithRetries } from "@oh-my-pi/pi-utils";

const CONFIG_ENV_KEYS = ["PI_CONFIG_DIR", "PI_CODING_AGENT_DIR"] as const;

export interface IsolatedHome {
	/** Fresh empty dir; `getConfigRootDir()` resolves to `<home>/.omp`. */
	readonly home: string;
	/** Restore the previous config env and directory resolver, then delete `home`. */
	restore(): Promise<void>;
}

/**
 * Point every omp directory (`~/.omp` logs, reports, collab replicas, …) at a
 * fresh temp dir on every platform via an absolute `PI_CONFIG_DIR`. HOME and
 * USERPROFILE stay untouched: Bun pins `os.homedir()` at startup on POSIX, so
 * rewriting them mid-run would only move spawned children's home.
 */
export async function isolateHome(prefix: string): Promise<IsolatedHome> {
	const saved = CONFIG_ENV_KEYS.map(key => [key, process.env[key]] as const);
	const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	process.env.PI_CONFIG_DIR = path.join(home, ".omp");
	process.env.PI_CODING_AGENT_DIR = path.join(home, ".omp", "agent");
	__resetDirsFromEnvForTests();
	return {
		home,
		async restore() {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			__resetDirsFromEnvForTests();
			await removeWithRetries(home);
		},
	};
}
