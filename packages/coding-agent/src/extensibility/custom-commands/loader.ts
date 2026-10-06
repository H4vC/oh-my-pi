/**
 * Custom command loader - loads TypeScript command modules using native Bun import.
 *
 * Dependencies (the arktype validation and pi-coding-agent) are injected via the
 * CustomCommandAPI to avoid import resolution issues with custom commands loaded from user directories.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import * as zod from "@oh-my-pi/omptype/zod";
import { getAgentDir, getProjectDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { getConfigDirs } from "../../config";

import { execCommand } from "../../exec/exec";
import * as typebox from "../legacy-typebox";
import { installLegacyPiSpecifierShim } from "../plugins/legacy-pi-compat";
import { getPiCodingAgentModule, loadPiCodingAgentModule } from "../utils";
import { GreenCommand } from "./bundled/ci-green";
import { AnnotateCommand } from "./bundled/annotate";
import { ReviewCommand } from "./bundled/review";
import type {
	CustomCommand,
	CustomCommandAPI,
	CustomCommandFactory,
	CustomCommandSource,
	CustomCommandsLoadResult,
	LoadedCustomCommand,
} from "./types";

const arktype = Object.assign(Function.prototype.bind.call(type, undefined) as typeof type, type, { type });

type ImportedCommandModule = { module: { default?: unknown }; error: null } | { module: null; error: string };

/**
 * Import a single command module using native Bun import.
 */
async function importCommandModule(commandPath: string): Promise<ImportedCommandModule> {
	try {
		const module: { default?: unknown } = await import(commandPath);
		return { module, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { module: null, error: `Failed to load command: ${message}` };
	}
}

/**
 * Run an imported command module's factory and validate its commands.
 */
async function bindCommandModule(
	imported: ImportedCommandModule,
	sharedApi: CustomCommandAPI,
): Promise<{ commands: CustomCommand[] | null; error: string | null }> {
	if (imported.module === null) return { commands: null, error: imported.error };
	try {
		const factory = (imported.module.default ?? imported.module) as CustomCommandFactory;

		if (typeof factory !== "function") {
			return { commands: null, error: "Command must export a default function" };
		}

		const result = await factory(sharedApi);
		const commands = Array.isArray(result) ? result : [result];

		// Validate commands
		for (const cmd of commands) {
			if (!cmd.name || typeof cmd.name !== "string") {
				return { commands: null, error: "Command must have a name" };
			}
			if (!cmd.description || typeof cmd.description !== "string") {
				return { commands: null, error: `Command "${cmd.name}" must have a description` };
			}
			if (typeof cmd.execute !== "function") {
				return { commands: null, error: `Command "${cmd.name}" must have an execute function` };
			}
		}

		return { commands, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { commands: null, error: `Failed to load command: ${message}` };
	}
}

export interface DiscoverCustomCommandsOptions {
	/** Current working directory. Default: getProjectDir() */
	cwd?: string;
	/** Agent config directory. Default: from getAgentDir() */
	agentDir?: string;
}

export interface DiscoverCustomCommandsResult {
	/** Paths to command modules */
	paths: Array<{ path: string; source: CustomCommandSource }>;
}

/**
 * Discover custom command modules (TypeScript slash commands).
 * Markdown slash commands are handled by core/slash-commands.ts.
 */
export async function discoverCustomCommands(
	options: DiscoverCustomCommandsOptions = {},
): Promise<DiscoverCustomCommandsResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();
	const paths: Array<{ path: string; source: CustomCommandSource }> = [];
	const seen = new Set<string>();

	const addPath = (commandPath: string, source: CustomCommandSource): void => {
		const resolved = path.resolve(commandPath);
		if (seen.has(resolved)) return;
		seen.add(resolved);
		paths.push({ path: resolved, source });
	};

	// Missing directories need no existence pre-check: readdir's ENOENT is skipped below.
	const commandDirs: Array<{ path: string; source: CustomCommandSource }> = [];
	if (agentDir) {
		commandDirs.push({ path: path.join(agentDir, "commands"), source: "user" });
	}

	for (const entry of getConfigDirs("commands", { cwd })) {
		const source = entry.level === "user" ? "user" : "project";
		if (!commandDirs.some(d => d.path === entry.path)) {
			commandDirs.push({ path: entry.path, source });
		}
	}

	const indexCandidates = ["index.ts", "index.js", "index.mjs", "index.cjs"];
	// Resolve every command directory's index file concurrently; results are
	// appended afterwards in directory/entry order so first-seen dedupe holds.
	const perDir = await Promise.all(
		commandDirs.map(async ({ path: commandsDir, source }) => {
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(commandsDir, { withFileTypes: true });
			} catch (error) {
				if (!isEnoent(error)) {
					logger.warn("Failed to read custom commands directory", { path: commandsDir, error: String(error) });
				}
				return [];
			}
			const found = await Promise.all(
				entries
					.filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
					.map(async entry => {
						const commandDir = path.join(commandsDir, entry.name);
						const stats = await Promise.all(
							indexCandidates.map(filename =>
								fs.promises.stat(path.join(commandDir, filename)).then(
									() => true,
									() => false,
								),
							),
						);
						const index = stats.indexOf(true);
						return index === -1 ? null : path.join(commandDir, indexCandidates[index]);
					}),
			);
			return found.filter(candidate => candidate !== null).map(candidate => ({ path: candidate, source }));
		}),
	);
	for (const dirPaths of perDir) {
		for (const { path: candidate, source } of dirPaths) addPath(candidate, source);
	}

	return { paths };
}

export interface LoadCustomCommandsOptions {
	/** Current working directory. Default: getProjectDir() */
	cwd?: string;
	/** Agent config directory. Default: from getAgentDir() */
	agentDir?: string;
}

/**
 * Load bundled commands (shipped with pi-coding-agent).
 */
function loadBundledCommands(sharedApi: CustomCommandAPI): LoadedCustomCommand[] {
	const bundled: LoadedCustomCommand[] = [];

	// Add bundled commands here
	bundled.push({
		path: "bundled:green",
		resolvedPath: "bundled:green",
		command: new GreenCommand(sharedApi),
		source: "bundled",
	});
	bundled.push({
		path: "bundled:review",
		resolvedPath: "bundled:review",
		command: new ReviewCommand(sharedApi),
		source: "bundled",
	});
	bundled.push({
		path: "bundled:annotate",
		resolvedPath: "bundled:annotate",
		command: new AnnotateCommand(sharedApi),
		source: "bundled",
	});

	return bundled;
}

/**
 * Discover and load custom commands from standard locations.
 */
export async function loadCustomCommands(options: LoadCustomCommandsOptions = {}): Promise<CustomCommandsLoadResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();

	const { paths } = await discoverCustomCommands({ cwd, agentDir });

	const commands: LoadedCustomCommand[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const seenNames = new Set<string>();

	// Shared API object - all commands get the same instance
	const sharedApi: CustomCommandAPI = {
		cwd,
		exec: (command: string, args: string[], execOptions) =>
			execCommand(command, args, execOptions?.cwd ?? cwd, execOptions),
		typebox,
		arktype,
		zod,
		get pi() {
			return getPiCodingAgentModule();
		},
	};

	// 1. Load bundled commands first (lowest priority - can be overridden)
	for (const loaded of loadBundledCommands(sharedApi)) {
		seenNames.add(loaded.command.name);
		commands.push(loaded);
	}

	// 2. Load user/project commands (can override bundled). Imports run
	// concurrently; factories and conflict checks then run in path order.
	if (paths.length > 0) {
		await loadPiCodingAgentModule();
		installLegacyPiSpecifierShim();
	}
	const imported = await Promise.all(paths.map(({ path: commandPath }) => importCommandModule(commandPath)));
	for (const [index, { path: commandPath, source }] of paths.entries()) {
		const { commands: loadedCommands, error } = await bindCommandModule(imported[index], sharedApi);

		if (error) {
			errors.push({ path: commandPath, error });
			continue;
		}

		if (loadedCommands) {
			for (const command of loadedCommands) {
				// Allow overriding bundled commands, but not user/project conflicts
				const existingIdx = commands.findIndex(c => c.command.name === command.name);
				if (existingIdx !== -1) {
					const existing = commands[existingIdx];
					if (existing.source === "bundled") {
						// Override bundled command
						commands.splice(existingIdx, 1);
						seenNames.delete(command.name);
					} else {
						// Conflict between user/project commands
						errors.push({
							path: commandPath,
							error: `Command name "${command.name}" conflicts with existing command`,
						});
						continue;
					}
				}

				seenNames.add(command.name);
				commands.push({
					path: commandPath,
					resolvedPath: path.resolve(commandPath),
					command,
					source,
				});
			}
		}
	}

	return { commands, errors };
}
