import { logger } from "@oh-my-pi/pi-utils";

import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { runSharpshooterConsolidation } from "./consolidate";
import { readSharpshooterState, sharpshooterBankDir } from "./paths";

import { cfgSharpshooterIntervalMinutes } from "./settings";

const SCHEDULER_TICK_MS = 60_000;

interface SchedulerEntry {
	timer: NodeJS.Timeout;
	refCount: number;
}

const schedulers = new Map<string, SchedulerEntry>();

export function startSharpshooterScheduler(options: {
	agentDir: string;
	cwd: string;
	settings: Settings;
	modelRegistry: ModelRegistry;
	sessionId: string;
}): () => void {
	const bankDir = sharpshooterBankDir(options.agentDir, options.cwd);
	const existing = schedulers.get(bankDir);
	if (existing) {
		existing.refCount += 1;
		return createDisposer(bankDir, existing);
	}

	const tick = async (): Promise<void> => {
		try {
			// Consolidation is a no-op until the interval elapses, so gate on state alone;
			// the queue is only listed once consolidation actually runs. A recorded error
			// (e.g. no model resolved) backs off for one interval instead of retrying every tick.
			const state = await readSharpshooterState(options.agentDir, options.cwd);
			const intervalMs = cfgSharpshooterIntervalMinutes.get(options.settings) * 60_000;
			const lastAttempt = Math.max(state.lastConsolidatedAt, state.lastError?.at ?? 0);
			if (Date.now() - lastAttempt < intervalMs) return;
			await runSharpshooterConsolidation(options);
		} catch (error) {
			logger.debug("sharpshooter scheduler tick failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
	const timer = setInterval(() => void tick(), SCHEDULER_TICK_MS);
	timer.unref();
	const entry: SchedulerEntry = { timer, refCount: 1 };
	schedulers.set(bankDir, entry);
	void tick();
	return createDisposer(bankDir, entry);
}

function createDisposer(bankDir: string, entry: SchedulerEntry): () => void {
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		const current = schedulers.get(bankDir);
		if (current !== entry) return;
		current.refCount -= 1;
		if (current.refCount > 0) return;
		clearInterval(current.timer);
		schedulers.delete(bankDir);
	};
}
