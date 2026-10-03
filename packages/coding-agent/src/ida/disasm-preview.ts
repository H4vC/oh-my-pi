/**
 * A quick disassembly of one file through idalib (`disasm-preview.py`), for previews: an
 * executable IDA loads is listed from its entry point, a raw blob only when it decodes as
 * plausible x86-64 or AArch64 code. One short-lived Python process per file, working on a temp
 * copy, so no database lands beside the file and no IDA host daemon is involved.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { hostHasInheritableConsole, shouldHideKernelWindow } from "../eval/py/spawn-options";
import { stageRunnerScript } from "../eval/runner-cache";
import IDA_DISASM_PREVIEW from "./disasm-preview.py" with { type: "text" };
import { cfgIdaAvailable } from "./install";
import { resolveIdaRuntime } from "./runtime";

/** Budget for idalib to load, try the architectures, and list. */
const DISASM_TIMEOUT_MS = 60_000;

/** A disassembly listing: what it was read as, and one line per instruction. */
export interface DisasmPreview {
	/** `x86 64-bit · Portable executable for AMD64 (PE)`, `arm64 (raw)`, … */
	arch: string;
	lines: string[];
}

/**
 * Disassemble the start of `file` with IDA, or undefined when IDA is unavailable, the file is no
 * executable and decodes as code for no supported architecture, or the run fails.
 */
export async function disassemblePreview(
	file: string,
	opts: { settings: Settings; cwd: string; maxLines: number },
): Promise<DisasmPreview | undefined> {
	if (!cfgIdaAvailable.get(opts.settings)) return undefined;
	try {
		const runtime = await resolveIdaRuntime(opts);
		const script = await stageRunnerScript("omp-ida-disasm-preview", "py", IDA_DISASM_PREVIEW);
		const proc = Bun.spawn([runtime.pythonPath, "-u", script, file, String(opts.maxLines)], {
			env: runtime.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: DISASM_TIMEOUT_MS,
			windowsHide: shouldHideKernelWindow({
				platform: process.platform,
				hostHasInheritableConsole: hostHasInheritableConsole(),
			}),
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) {
			logger.debug("IDA disassembly preview failed", { file, code, stderr: stderr.slice(-2000) });
			return undefined;
		}
		const result = JSON.parse(stdout) as { arch?: string; lines?: string[] };
		return result.arch && result.lines?.length ? { arch: result.arch, lines: result.lines } : undefined;
	} catch (error) {
		logger.debug("IDA disassembly preview unavailable", { file, error: String(error) });
		return undefined;
	}
}
