/** Behavior-compatible reimplementation of @xterm/headless's used surface. */
export * from "./vterm/buffer";
export * from "./vterm/query-responder";
export * from "./vterm/terminal";

import { Terminal } from "./vterm/terminal";

const vterm = { Terminal };
/** @deprecated xterm CJS-shape shim; import `{ Terminal }` instead. Will be removed in the next major. */
export default vterm;
