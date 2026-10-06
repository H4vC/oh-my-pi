import type * as MnemopiConfig from "../mnemopi/config";
import type * as MnemopiState from "../mnemopi/state";

// Mnemopi type re-exports below are deprecated: import them from `mnemopi/config` / `mnemopi/state`.
/** @deprecated Import from `@oh-my-pi/pi-coding-agent/mnemopi/config`. Will be removed in the next major. */
export type MnemopiBackendConfig = MnemopiConfig.MnemopiBackendConfig;
/** @deprecated Import from `@oh-my-pi/pi-coding-agent/mnemopi/config`. Will be removed in the next major. */
export type MnemopiLlmMode = MnemopiConfig.MnemopiLlmMode;
/** @deprecated Import from `@oh-my-pi/pi-coding-agent/mnemopi/config`. Will be removed in the next major. */
export type MnemopiProviderOptions = MnemopiConfig.MnemopiProviderOptions;
/** @deprecated Import from `@oh-my-pi/pi-coding-agent/mnemopi/config`. Will be removed in the next major. */
export type MnemopiScoping = MnemopiConfig.MnemopiScoping;
/** @deprecated Import from `@oh-my-pi/pi-coding-agent/mnemopi/state`. Will be removed in the next major. */
export type MnemopiMemoryEditOperation = MnemopiState.MnemopiMemoryEditOperation;
/** @deprecated Import from `@oh-my-pi/pi-coding-agent/mnemopi/state`. Will be removed in the next major. */
export type MnemopiMemoryEditOptions = MnemopiState.MnemopiMemoryEditOptions;
/** @deprecated Import from `@oh-my-pi/pi-coding-agent/mnemopi/state`. Will be removed in the next major. */
export type MnemopiMemoryEditResult = MnemopiState.MnemopiMemoryEditResult;
/** @deprecated Import from `@oh-my-pi/pi-coding-agent/mnemopi/state`. Will be removed in the next major. */
export type MnemopiSessionStateOptions = MnemopiState.MnemopiSessionStateOptions;
// Kept as a type-only re-export (not an alias) so `typeof MnemopiSessionState` keeps resolving.
// Deprecated: import it from `@oh-my-pi/pi-coding-agent/mnemopi/state`; will be removed in the next major.
export type { MnemopiSessionState } from "../mnemopi/state";
export * from "./local-backend";
export * from "./messages";
export * from "./off-backend";
export * from "./resolve";
export * from "./runtime";
export * from "./types";
