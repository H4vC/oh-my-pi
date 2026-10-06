/** Output of a one-shot linter/formatter CLI run. */
export interface LinterCliResult {
	stdout: string;
	stderr: string;
	/** Process exit code; `null` when the process could not be spawned. */
	exitCode: number | null;
}

export interface LinterCliOptions {
	/** Text piped to the process's stdin (e.g. for `--stdin-file-path` modes). */
	stdin?: string;
	signal?: AbortSignal;
}

/**
 * Run a linter/formatter CLI to completion and capture its output. Each caller
 * applies its own success rule (many linters exit non-zero when they report
 * findings). A spawn failure resolves with `exitCode: null` and the error in
 * `stderr`; an abort of `signal` kills the process and rejects.
 */
export async function runLinterCli(
	command: string,
	args: string[],
	cwd: string,
	options: LinterCliOptions = {},
): Promise<LinterCliResult> {
	const { stdin, signal } = options;
	try {
		const proc = Bun.spawn([command, ...args], {
			cwd,
			stdin: stdin === undefined ? "ignore" : Buffer.from(stdin, "utf8"),
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
			signal,
		});
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;
		signal?.throwIfAborted();
		return { stdout, stderr, exitCode };
	} catch (err) {
		if (signal?.aborted) throw err;
		return { stdout: "", stderr: String(err), exitCode: null };
	}
}
