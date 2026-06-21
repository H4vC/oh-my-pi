import type { ChildProcess as NodeChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { Readable, Writable } from "node:stream";
import { PatchrightPipeProcess } from "@oh-my-pi/pi-natives";

const require = createRequire(import.meta.url);
const childProcess = require("child_process") as PatchedChildProcess;

interface NativePatchrightPipeProcess {
	readonly pid: number;
	write(data: string | Uint8Array): void;
	closeStdin(): void;
	kill(): void;
	onData(callback: (err: Error | null, data: Uint8Array) => void): void;
	onStdout(callback: (err: Error | null, data: Uint8Array) => void): void;
	onStderr(callback: (err: Error | null, data: Uint8Array) => void): void;
	onExit(callback: (err: Error | null, exit: { exitCode?: number | null }) => void): void;
}

interface NativePatchrightPipeCtor {
	spawn(options: {
		command: string;
		args: string[];
		cwd?: string;
		env?: Record<string, string>;
		windowsHide?: boolean;
	}): NativePatchrightPipeProcess;
}

const patchrightPipeProcess = PatchrightPipeProcess as NativePatchrightPipeCtor;
const patchedSpawnSymbol = Symbol.for("omp.patchrightBunPipeSpawn");

type SpawnFunction = (
	command: string,
	args?: readonly string[] | SpawnOptions,
	options?: SpawnOptions,
) => NodeChildProcess;
type PatchedChildProcess = {
	spawn: SpawnFunction;
	[patchedSpawnSymbol]?: boolean;
};

class NativePipeReadable extends Readable {
	_read(): void {}

	pushChunk(chunk: Uint8Array): void {
		this.push(Buffer.from(chunk));
	}

	close(): void {
		this.push(null);
	}
}

class NativePipeWritable extends Writable {
	readonly process: NativePatchrightPipeProcess;

	constructor(process: NativePatchrightPipeProcess) {
		super();
		this.process = process;
	}

	_write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		try {
			if (typeof chunk === "string") {
				this.process.write(Buffer.from(chunk, encoding));
			} else {
				this.process.write(chunk);
			}
			callback();
		} catch (err) {
			callback(err instanceof Error ? err : new Error(String(err)));
		}
	}

	_final(callback: (error?: Error | null) => void): void {
		try {
			this.process.closeStdin();
			callback();
		} catch (err) {
			callback(err instanceof Error ? err : new Error(String(err)));
		}
	}
}

class NativeBrowserChildProcess extends EventEmitter {
	readonly pid: number;
	readonly stdin = null;
	readonly stdout: NativePipeReadable;
	readonly stderr: NativePipeReadable;
	readonly stdio: [null, NativePipeReadable, NativePipeReadable, NativePipeWritable, NativePipeReadable];
	killed = false;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	connected = false;

	readonly process: NativePatchrightPipeProcess;

	constructor(process: NativePatchrightPipeProcess) {
		super();
		this.process = process;
		this.pid = process.pid;
		this.stdout = new NativePipeReadable();
		this.stderr = new NativePipeReadable();
		const cdpWrite = new NativePipeWritable(process);
		const cdpRead = new NativePipeReadable();
		this.stdio = [null, this.stdout, this.stderr, cdpWrite, cdpRead];
		process.onStdout((err, data) => {
			if (err) this.emit("error", err);
			else this.stdout.pushChunk(data);
		});
		process.onStderr((err, data) => {
			if (err) this.emit("error", err);
			else this.stderr.pushChunk(data);
		});
		process.onData((err, data) => {
			if (err) this.emit("error", err);
			else cdpRead.pushChunk(data);
		});
		process.onExit((err, exit) => {
			if (err) {
				this.emit("error", err);
				return;
			}
			this.exitCode = exit.exitCode ?? null;
			this.stdout.close();
			this.stderr.close();
			cdpRead.close();
			this.emit("exit", this.exitCode, this.signalCode);
			this.emit("close", this.exitCode, this.signalCode);
		});
	}

	kill(_signal?: NodeJS.Signals | number): boolean {
		if (this.killed) return false;
		this.killed = true;
		this.process.kill();
		return true;
	}

	ref(): this {
		return this;
	}

	unref(): this {
		return this;
	}
}

function isPatchrightChromiumPipeLaunch(
	_command: string,
	args: readonly string[] | undefined,
	options: SpawnOptions | undefined,
): boolean {
	return Boolean(
		Array.isArray(options?.stdio) &&
			options.stdio.length >= 5 &&
			options.stdio[3] === "pipe" &&
			options.stdio[4] === "pipe" &&
			args?.includes("--remote-debugging-pipe"),
	);
}

function cleanEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
	if (!env) return undefined;
	const clean: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") clean[key] = value;
	}
	return clean;
}

export function installPatchrightBunPipeSpawnPatch(): void {
	if (!process.versions.bun) return;
	const target = childProcess as PatchedChildProcess;
	if (target[patchedSpawnSymbol]) return;
	const originalSpawn = target.spawn.bind(childProcess) as SpawnFunction;
	const patchedSpawn = ((command: string, args?: readonly string[] | SpawnOptions, options?: SpawnOptions) => {
		const argsArray = Array.isArray(args) ? args : undefined;
		const normalizedArgs = argsArray ? [...argsArray] : [];
		const normalizedOptions = argsArray ? options : (args as SpawnOptions | undefined);
		if (isPatchrightChromiumPipeLaunch(command, normalizedArgs, normalizedOptions)) {
			const nativeProcess = patchrightPipeProcess.spawn({
				command,
				args: normalizedArgs,
				cwd: normalizedOptions?.cwd?.toString(),
				env: cleanEnv(normalizedOptions?.env),
				windowsHide: normalizedOptions?.windowsHide !== false,
			});
			return new NativeBrowserChildProcess(nativeProcess) as unknown as NodeChildProcess;
		}
		return originalSpawn(command, args as string[], options);
	}) as SpawnFunction;
	Object.defineProperty(patchedSpawn, "name", { value: "ompPatchrightBunPipeSpawn" });
	try {
		target.spawn = patchedSpawn;
		target[patchedSpawnSymbol] = true;
	} catch {
		// Some runtimes may expose an immutable ESM namespace. In that case the
		// original Patchright launch remains unchanged and will surface its own
		// timeout instead of broadening the patch beyond this exact seam.
	}
}
