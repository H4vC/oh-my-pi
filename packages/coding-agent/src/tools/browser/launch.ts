import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, logger } from "@oh-my-pi/pi-utils";
import type { Browser, BrowserServer, BrowserType, CDPSession, Page } from "patchright";
import { ToolError } from "../tool-errors";
import { installPatchrightBunPipeSpawnPatch } from "./patchright-bun-pipe";

export type { Browser, BrowserServer, CDPSession, Page };

/**
 * Lazy access to patchright's `chromium`. Top-level import would execute
 * patchright-core (Node-version guard + heavy coreBundle with chromium-bidi)
 * at startup. Must defer to avoid crashing omp before the browser tool is used.
 * Exception to ts-no-dynamic-import: static import triggers the side effect we defer.
 */
let _chromium: BrowserType | undefined;
function chromium(): BrowserType {
	installPatchrightBunPipeSpawnPatch();
	if (!_chromium) _chromium = require("patchright").chromium;
	registerAriaSelectorEngine();
	return _chromium!;
}

/**
 * Register a custom `aria=` selector engine that matches by computed accessible
 * name, including associated form labels (`label[for]` and wrapper labels).
 * Playwright's built-in `role=` engine requires a role; `text=` only matches
 * visible text. This keeps bare `aria/Name` selectors compatible with the old
 * Puppeteer ARIA query behavior for icon buttons and labelled controls.
 */
export const ARIA_SELECTOR_ENGINE_SOURCE = `({queryAll(root,selector){
function norm(v){return((v||"")+"").replace(/\\s+/g," ").trim()}
function txt(el){return norm(el&&el.textContent)}
function byIds(doc,ids){var out=[];ids.split(/\\s+/).forEach(function(id){var e=doc.getElementById(id);var t=txt(e);if(t)out.push(t)});return out.join(" ")}
function esc(v){return typeof CSS!=="undefined"&&CSS.escape?CSS.escape(v):v.replace(/(["\\\\])/g,"\\\\$1")}
function labels(el,doc){var out=[];if(el.labels){for(var i=0;i<el.labels.length;i++){var t=txt(el.labels[i]);if(t)out.push(t)}}else{var id=el.getAttribute&&el.getAttribute("id");if(id){doc.querySelectorAll('label[for="'+esc(id)+'"]').forEach(function(l){var t=txt(l);if(t)out.push(t)})}var p=el.closest&&el.closest("label");if(p){var pt=txt(p);if(pt)out.push(pt)}}return out.join(" ")}
function role(el){var x=(el.getAttribute&&el.getAttribute("role")||"").trim();if(x)return /^(none|presentation)$/.test(x)?null:x.split(/\\s+/)[0];var t=el.tagName;if(t==="A"||t==="AREA")return el.hasAttribute("href")?"link":null;if(t==="BUTTON")return"button";if(t==="IMG")return el.getAttribute("alt")===""?null:"img";if(/^H[1-6]$/.test(t))return"heading";if(t==="SELECT")return el.multiple||el.size>1?"listbox":"combobox";if(t==="TEXTAREA")return"textbox";if(t==="INPUT"){var ty=(el.getAttribute("type")||"text").toLowerCase();return /^(button|submit|reset|image)$/.test(ty)?"button":ty==="checkbox"?"checkbox":ty==="radio"?"radio":ty==="range"?"slider":ty==="number"?"spinbutton":/^(hidden|password)$/.test(ty)?null:"textbox"}return null}
function vis(el){if(el.tagName==="TEMPLATE"||(el.closest&&el.closest("template,[hidden],[aria-hidden='true']")))return false;var s=typeof getComputedStyle==="function"&&getComputedStyle(el);if(s&&(s.visibility==="hidden"||s.display==="none"))return false;var r=el.getClientRects&&el.getClientRects();return !r||r.length>0}
function named(el){return !!(el.getAttribute&&(el.getAttribute("aria-label")||el.getAttribute("aria-labelledby")||el.getAttribute("title")||el.getAttribute("alt"))||el.labels&&el.labels.length)}
function cand(el){if(el.tagName==="LABEL"&&(el.control||el.htmlFor||el.getAttribute("for")||el.querySelector("input,textarea,select,button")))return false;return vis(el)&&(!!role(el)||named(el)||el.isContentEditable||el.hasAttribute&&el.hasAttribute("tabindex"))}
function gan(el,doc){var lb=el.getAttribute&&el.getAttribute("aria-labelledby");if(lb){var lbt=byIds(doc,lb);if(lbt)return lbt}var al=norm(el.getAttribute&&el.getAttribute("aria-label"));if(al)return al;var lt=labels(el,doc);if(lt)return lt;var alt=norm(el.getAttribute&&el.getAttribute("alt"));if(alt)return alt;var t=norm(el.getAttribute&&el.getAttribute("title"));if(t)return t;var tx=txt(el);if(tx)return tx;if(el.tagName==="INPUT"&&el.value)return norm(el.value);return""}
var n=norm(selector);var r=[];var doc=root.ownerDocument||root;var a=root.querySelectorAll("*");
for(var i=0;i<a.length;i++){var el=a[i];if(cand(el)&&gan(el,doc)===n)r.push(el)}return r}})`;

let _ariaEngineRegistered = false;
function registerAriaSelectorEngine(): void {
	if (_ariaEngineRegistered || !_chromium) return;
	_ariaEngineRegistered = true;
	const { selectors } = require("patchright") as typeof import("patchright");
	void selectors.register("aria", ARIA_SELECTOR_ENGINE_SOURCE, { contentScript: true }).catch(err => {
		logger.warn("Failed to register aria selector engine", { error: (err as Error).message });
	});
}

export const DEFAULT_VIEWPORT = { width: 1365, height: 768, deviceScaleFactor: 1.25 };

export const BROWSER_PROTOCOL_TIMEOUT_MS = 60_000;

let chromiumExecutablePromise: Promise<string | undefined> | undefined;

async function tryInstallPatchrightChromium(argv: string[], label: string): Promise<string | undefined> {
	let stderr = "";
	try {
		const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
		const [stderrText] = await Promise.all([new Response(child.stderr).text(), new Response(child.stdout).text()]);
		stderr = stderrText;
		const exitCode = await child.exited;
		if (exitCode === 0) return undefined;
		logger.warn(`${label} patchright install failed`, { exitCode, stderr: stderr.slice(-500) });
	} catch {}
	return stderr;
}

async function installPatchrightChromium(): Promise<void> {
	const npxStderr = await tryInstallPatchrightChromium(["npx", "patchright", "install", "chromium"], "npx");
	if (npxStderr === undefined) return;
	const nodeStderr = await tryInstallPatchrightChromium(
		["node", "-e", "require('patchright/lib/program').program.parse(['node','patchright','install','chromium'])"],
		"node",
	);
	if (nodeStderr === undefined) return;
	throw new ToolError(
		"Failed to install Chromium for patchright. " +
			"Set PUPPETEER_EXECUTABLE_PATH to use an existing Chrome/Chromium binary, " +
			"or run `npx patchright install chromium` manually." +
			(npxStderr ? `\nnpx stderr: ${npxStderr.slice(-300)}` : "") +
			(nodeStderr ? `\nnode stderr: ${nodeStderr.slice(-300)}` : ""),
	);
}

async function ensureChromiumExecutable(): Promise<string | undefined> {
	const sysChrome = resolveSystemChromium();
	if (sysChrome) return sysChrome;
	const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
	if (envPath) return envPath;
	if (chromiumExecutablePromise) return chromiumExecutablePromise;

	chromiumExecutablePromise = (async () => {
		const exe = chromium().executablePath();
		if (fs.existsSync(exe)) return exe;
		// Self-provision: download Chromium on first use, matching the old
		// @puppeteer/browsers behavior. Try multiple strategies so this works
		// on npm installs, standalone binaries, and Bun-only hosts.
		logger.warn("Patchright Chromium not found, downloading (first browser use)", {
			expectedPath: exe,
		});
		await installPatchrightChromium();
		if (!fs.existsSync(exe)) {
			throw new ToolError(
				`Chromium was installed but the executable is not at the expected path: ${exe}. ` +
					"Set PUPPETEER_EXECUTABLE_PATH to use an existing Chrome/Chromium binary.",
			);
		}
		return exe;
	})().catch(err => {
		chromiumExecutablePromise = undefined;
		if (err instanceof ToolError) throw err;
		throw new ToolError(
			`Failed to resolve Chromium executable for patchright: ${(err as Error).message}. ` +
				"Set PUPPETEER_EXECUTABLE_PATH to use an existing Chrome/Chromium binary, or install one manually.",
		);
	});
	return chromiumExecutablePromise;
}

let resolvedChromium: string | null | undefined; // undefined = unchecked; null = not found

function isExecutableFile(p: string): boolean {
	try {
		const st = fs.statSync(p);
		return st.isFile();
	} catch {
		return false;
	}
}

function systemChromiumCandidates(): string[] {
	const home = os.homedir();
	const candidates: string[] = [];
	switch (process.platform) {
		case "darwin": {
			for (const root of ["/Applications", path.join(home, "Applications")]) {
				candidates.push(
					path.join(root, "Google Chrome.app/Contents/MacOS/Google Chrome"),
					path.join(root, "Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"),
					path.join(root, "Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev"),
					path.join(root, "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"),
					path.join(root, "Chromium.app/Contents/MacOS/Chromium"),
					path.join(root, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
				);
			}
			break;
		}
		case "linux": {
			const names = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"];
			for (const name of names) {
				const found = $which(name);
				if (found) candidates.push(found);
			}
			candidates.push(
				"/usr/bin/google-chrome-stable",
				"/usr/bin/google-chrome",
				"/usr/bin/chromium",
				"/usr/bin/chromium-browser",
				"/snap/bin/chromium",
				"/var/lib/flatpak/exports/bin/com.google.Chrome",
				"/var/lib/flatpak/exports/bin/org.chromium.Chromium",
			);
			let onNixos = false;
			try {
				onNixos = fs.existsSync("/etc/NIXOS");
			} catch {}
			if (onNixos) {
				candidates.push(path.join(home, ".nix-profile/bin/chromium"), "/run/current-system/sw/bin/chromium");
			}
			break;
		}
		case "win32": {
			const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
			const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
			const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData\\Local");
			candidates.push(
				path.join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(programFiles, "Chromium\\Application\\chrome.exe"),
				path.join(localAppData, "Chromium\\Application\\chrome.exe"),
				path.join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
				path.join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
			);
			break;
		}
	}
	return candidates;
}

function resolveSystemChromium(): string | undefined {
	if (resolvedChromium !== undefined) return resolvedChromium ?? undefined;
	const seen = new Set<string>();
	for (const candidate of systemChromiumCandidates()) {
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		if (isExecutableFile(candidate)) {
			resolvedChromium = candidate;
			logger.debug("Using system Chrome/Chromium", { path: candidate });
			return candidate;
		}
	}
	resolvedChromium = null;
	return undefined;
}

export interface LaunchHeadlessOptions {
	headless: boolean;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
}

/**
 * Launch a headless Chromium browser via patchright.
 *
 * Patchright provides built-in stealth (Runtime.enable avoidance, command-flag
 * fixes, etc.) so no custom injection scripts or UA overrides are applied.
 *
 * Per patchright best practice, we use `channel: "chrome"` when a system Chrome
 * is available (better fingerprint than Chromium), and fall back to the bundled
 * Chromium otherwise.
 */
export async function launchHeadlessBrowser(opts: LaunchHeadlessOptions): Promise<BrowserServer> {
	const vp = opts.viewport ?? DEFAULT_VIEWPORT;
	const executablePath = await ensureChromiumExecutable();
	const launchArgs = ["--no-sandbox", "--disable-setuid-sandbox", `--window-size=${vp.width},${vp.height}`];

	const proxy = process.env.PUPPETEER_PROXY;
	if (proxy) {
		launchArgs.push(`--proxy-server=${proxy}`);
		// Chrome (since v72) bypasses proxies for localhost by default. When PUPPETEER_PROXY_BYPASS_LOOPBACK
		// is true, add <-loopback> so traffic to localhost reaches the proxy (e.g. for mitmdump/auth capture).
		const bypassLoopback = process.env.PUPPETEER_PROXY_BYPASS_LOOPBACK?.toLowerCase();
		if (bypassLoopback === "true" || bypassLoopback === "1" || bypassLoopback === "yes" || bypassLoopback === "on") {
			launchArgs.push("--proxy-bypass-list=<-loopback>");
		}
	}
	const ignoreCert = process.env.PUPPETEER_PROXY_IGNORE_CERT_ERRORS?.toLowerCase();
	if (ignoreCert === "true" || ignoreCert === "1" || ignoreCert === "yes" || ignoreCert === "on") {
		launchArgs.push("--ignore-certificate-errors");
	}

	const sysChrome = resolveSystemChromium();
	// Always launchServer so workers connect via wsEndpoint() in an isolated thread.
	return await chromium().launchServer({
		headless: opts.headless,
		// When using a system Chrome, use channel "chrome" for the best fingerprint.
		// Otherwise let patchright use its bundled Chromium.
		channel: sysChrome ? "chrome" : undefined,
		executablePath,
		args: launchArgs,
		timeout: BROWSER_PROTOCOL_TIMEOUT_MS,
	});
}

/**
 * Apply viewport dimensions (width, height, deviceScaleFactor) to a page.
 *
 * Playwright's `setViewportSize` handles width/height. For deviceScaleFactor,
 * we use CDP `Emulation.setDeviceMetricsOverride` since Playwright only supports
 * DPR at context creation time, not on an existing page.
 */
export async function applyViewport(
	page: Page,
	viewport?: { width: number; height: number; deviceScaleFactor?: number },
): Promise<void> {
	const vp = viewport ?? DEFAULT_VIEWPORT;
	await page.setViewportSize({ width: vp.width, height: vp.height });
	const dpr = vp.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor;
	if (dpr !== 1) {
		try {
			const session = await page.context().newCDPSession(page);
			await session.send("Emulation.setDeviceMetricsOverride", {
				width: vp.width,
				height: vp.height,
				deviceScaleFactor: dpr,
				mobile: false,
			});
			await session.detach();
		} catch (err) {
			logger.debug("Failed to set deviceScaleFactor via CDP", { error: (err as Error).message });
		}
	}
}

/**
 * Connect to an existing browser via its WebSocket endpoint.
 * Used by the tab worker to connect to the browser launched by the supervisor.
 */
export async function connectBrowser(browserWSEndpoint: string): Promise<Browser> {
	return await chromium().connect(browserWSEndpoint, { timeout: BROWSER_PROTOCOL_TIMEOUT_MS });
}

/**
 * Connect to an existing browser via its CDP HTTP endpoint (e.g. http://127.0.0.1:9222).
 * Used for attaching to Electron apps or externally-launched Chrome instances.
 */
export async function connectOverCDP(cdpUrl: string): Promise<Browser> {
	return await chromium().connectOverCDP(cdpUrl, { timeout: BROWSER_PROTOCOL_TIMEOUT_MS });
}

/**
 * Resolve the target ID for a page via CDP.
 * Playwright doesn't expose Target objects; we use CDP to get the target info.
 */
export async function pageTargetId(page: Page): Promise<string> {
	const session = await page.context().newCDPSession(page);
	try {
		const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
		const targetId = info.targetInfo?.targetId;
		if (!targetId) throw new ToolError("Target id unavailable from CDP target info");
		return targetId;
	} finally {
		await session.detach().catch(() => undefined);
	}
}
