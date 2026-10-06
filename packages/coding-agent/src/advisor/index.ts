import type {
	AdvisorConfig as TuiAdvisorConfig,
	AdvisorConfigScope as TuiAdvisorConfigScope,
	WatchdogConfigDoc as TuiWatchdogConfigDoc,
} from "@oh-my-pi/pi-tui/overlays/advisor-config";

export * from "./advise-tool";
export * from "./config";
export * from "./emission-guard";
export * from "./loop-guard";
export * from "./runtime";
export * from "./transcript-recorder";
export * from "./watchdog";

/** @deprecated Unused re-export; import from `@oh-my-pi/pi-tui/overlays/advisor-config`. Will be removed in the next major. */
export type AdvisorConfig = TuiAdvisorConfig;
/** @deprecated Unused re-export; import from `@oh-my-pi/pi-tui/overlays/advisor-config`. Will be removed in the next major. */
export type AdvisorConfigScope = TuiAdvisorConfigScope;
/** @deprecated Unused re-export; import from `@oh-my-pi/pi-tui/overlays/advisor-config`. Will be removed in the next major. */
export type WatchdogConfigDoc = TuiWatchdogConfigDoc;
