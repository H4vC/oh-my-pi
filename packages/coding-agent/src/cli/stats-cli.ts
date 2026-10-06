/**
 * Stats CLI command handlers.
 *
 * Handles `omp stats` subcommand for viewing AI usage statistics.
 */

import { formatKeyHint } from "@oh-my-pi/pi-tui/key-hint-format";
import { truncateToWidth } from "@oh-my-pi/pi-tui/utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { openStandaloneJudge } from "../judgment/standalone";
import { openPath } from "../utils/open";

/**
 * Single-line TTY progress bar. On a non-TTY stream we just stay quiet -
 * the final "Synced ..." summary still prints either way. The line clears
 * itself once the last file is reported.
 */
function createSyncProgressReporter(): (event: { current: number; total: number; sessionFile: string }) => void {
	const stream = process.stderr;
	const isTty = stream.isTTY === true;
	let lastWidth = 0;
	let lastRender = 0;
	return event => {
		if (!isTty) return;
		if (event.current >= event.total) {
			if (lastWidth > 0) stream.write(`\r${" ".repeat(lastWidth)}\r`);
			lastWidth = 0;
			return;
		}
		const now = Date.now();
		// Throttle to ~30 fps.
		if (now - lastRender < 33) return;
		lastRender = now;
		const label = chalk.dim(shortenSessionFile(event.sessionFile));
		const pct = ((event.current / event.total) * 100).toFixed(0).padStart(3, " ");
		const counter = chalk.cyan(`[${event.current}/${event.total}]`);
		const line = `${counter} ${pct}%  ${label}`;
		const columns = stream.columns ?? 120;
		const trimmed = truncateToWidth(line, columns - 1);
		stream.write(`\r${trimmed.padEnd(lastWidth)}`);
		lastWidth = trimmed.length;
	};
}

function shortenSessionFile(p: string): string {
	const marker = "/sessions/";
	const idx = p.indexOf(marker);
	return idx >= 0 ? p.slice(idx + marker.length) : p;
}

// =============================================================================
// Types
// =============================================================================

export interface StatsCommandArgs {
	port: number;
	host: string;
	json: boolean;
	summary: boolean;
}

// =============================================================================
// Command Handler
// =============================================================================

export async function runStatsCommand(cmd: StatsCommandArgs): Promise<void> {
	// Lazy import to avoid loading stats module when not needed
	const { closeDb, formatStatsDashboardUrl, runStatsReport, startServer } = await import("@oh-my-pi/omp-stats");

	// One-shot reports need fully ingested, fully rolled-up data before printing.
	if (cmd.json || cmd.summary) {
		await runStatsReport({ json: cmd.json, onProgress: createSyncProgressReporter() });
		return;
	}

	// The dashboard starts immediately and ingests sessions in the background,
	// streaming progress to the page. The judge (settings, auth, registry)
	// resolves on the first Frustration estimate/run and lives until exit.
	const cwd = process.cwd();
	const { hostname, port } = await startServer(cmd.port, cmd.host, {
		judge: async () => (await openStandaloneJudge(cwd, "stats_frustration")).judge,
	});
	const url = formatStatsDashboardUrl(hostname, port);
	console.log(chalk.green(`Dashboard available at: ${url}`));

	// Open browser
	openPath(url);

	console.log(`Press ${formatKeyHint("ctrl+c")} to stop\n`);

	// Keep process running
	process.on("SIGINT", () => {
		console.log("\nShutting down...");
		closeDb();
		process.exit(0);
	});

	// Keep the process alive
	await new Promise(() => {});
}
