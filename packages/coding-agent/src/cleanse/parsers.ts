import * as path from "node:path";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { CleanseDiagnostic, CleanseSeverity } from "./types";

/** Machine and fallback output formats understood by cleanse. */
export const CLEANSE_PARSER_KINDS = [
	"rust",
	"rust-test",
	"go",
	"go-test",
	"staticcheck",
	"golangci",
	"ruff",
	"pyright",
	"mypy",
	"pylint",
	"flake8",
	"ty",
	"eslint",
	"biome",
	"oxlint",
	"deno-lint",
	"stylelint",
	"rubocop",
	"phpstan",
	"psalm",
	"swiftlint",
	"dart",
	"credo",
	"shellcheck",
	"hlint",
	"terraform",
	"tflint",
	"actionlint",
	"generic",
] as const;

/** One machine or fallback output format understood by cleanse. */
export type CleanseParserKind = (typeof CLEANSE_PARSER_KINDS)[number];

/** Captured checker process output passed to a format parser. */
export interface CleanseParserInput {
	checker: string;
	projectCwd: string;
	checkerCwd: string;
	stdout: string;
	stderr: string;
}

interface DiagnosticFields {
	file?: string;
	line?: number;
	column?: number;
	endLine?: number;
	endColumn?: number;
	code?: string;
	severity?: CleanseSeverity | string | number;
	message?: string;
	suggestion?: string;
}

interface ParsedLocation {
	file: string;
	line?: number;
	column?: number;
}

type DiagnosticParser = (input: CleanseParserInput) => CleanseDiagnostic[];

type JsonRecord = Record<string, unknown> | undefined;

/** One family of diagnostic records inside a parsed JSON document. */
interface JsonSection {
	/** Diagnostic records in one document — or, with `nested`, the file records that own them. */
	select: (root: unknown) => unknown[];
	/** Key of each selected owner record's diagnostic array. */
	nested?: string;
	fields: (record: JsonRecord, owner: JsonRecord) => DiagnosticFields;
}

/** One line-oriented diagnostic format, matched against each trimmed output line. */
interface LineFormat {
	pattern: RegExp;
	fields: (match: RegExpExecArray) => DiagnosticFields;
}

/**
 * Where partial output on one stream may be cut so both sides parse independently:
 * at any line end, or only at line ends outside every JSON document.
 */
type StreamFraming = "lines" | "json";

interface ParserSpec {
	parse: DiagnosticParser;
	/** Used instead of `parse` when it finds nothing in the output. */
	fallback?: DiagnosticParser;
	stdout: StreamFraming;
	stderr: StreamFraming;
}

/** Parse one checker invocation into normalized, project-relative diagnostics. */
export function parseCleanseDiagnostics(kind: CleanseParserKind, input: CleanseParserInput): CleanseDiagnostic[] {
	const spec = PARSERS[kind];
	const parsed = spec.parse(input);
	return deduplicateDiagnostics(parsed.length > 0 || !spec.fallback ? parsed : spec.fallback(input));
}

/** Identity key shared by every cleanse dedupe; also used for exactly-once streaming emission. */
export function diagnosticKey(diagnostic: CleanseDiagnostic): string {
	return [
		diagnostic.file ?? "",
		diagnostic.line ?? "",
		diagnostic.column ?? "",
		diagnostic.code ?? "",
		diagnostic.message,
	].join("\u0000");
}

/** Drop repeated diagnostics by {@link diagnosticKey}, keeping first-seen order. */
export function deduplicateDiagnostics(diagnostics: readonly CleanseDiagnostic[]): CleanseDiagnostic[] {
	const seen = new Set<string>();
	const unique: CleanseDiagnostic[] = [];
	for (const diagnostic of diagnostics) {
		const key = diagnosticKey(diagnostic);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(diagnostic);
	}
	return unique;
}

/**
 * Incremental parser for output of a checker that is still running.
 *
 * Each {@link push} takes the text appended to stdout/stderr since the previous call and
 * parses only the output completed since then, cut where the format parses independently:
 * at line ends, and for JSON streams only between documents. The diagnostics yielded across
 * calls match re-parsing the whole completed prefix each time; callers dedupe across calls.
 */
export class CleanseStreamParser {
	readonly #spec: ParserSpec;
	readonly #context: Omit<CleanseParserInput, "stdout" | "stderr">;
	readonly #stdout: StreamCutter;
	readonly #stderr: StreamCutter;
	#primaryFound = false;

	constructor(kind: CleanseParserKind, context: Omit<CleanseParserInput, "stdout" | "stderr">) {
		this.#spec = PARSERS[kind];
		this.#context = context;
		this.#stdout = new StreamCutter(this.#spec.stdout);
		this.#stderr = new StreamCutter(this.#spec.stderr);
	}

	/** Feed newly produced output; returns diagnostics parsed from newly completed segments. */
	push(stdout: string, stderr: string): CleanseDiagnostic[] {
		const input: CleanseParserInput = {
			...this.#context,
			stdout: this.#stdout.push(stdout),
			stderr: this.#stderr.push(stderr),
		};
		if (!input.stdout && !input.stderr) return [];
		const parsed = this.#spec.parse(input);
		if (parsed.length > 0) this.#primaryFound = true;
		// A fallback applies only while the primary format has matched nothing in the
		// whole prefix, exactly as a full re-parse of that prefix would decide.
		const fallback = this.#primaryFound ? undefined : this.#spec.fallback;
		return deduplicateDiagnostics(fallback ? fallback(input) : parsed);
	}
}

/** Splits one growing output stream into sanitized segments that parse independently. */
class StreamCutter {
	readonly #json: boolean;
	/** Raw output after the last newline seen. */
	#partial = "";
	/** Sanitized complete lines held back while a JSON document is open. */
	#held = "";
	// JSON scanner state at the end of #held, mirroring parseJsonValues.
	#inDocument = false;
	#depth = 0;
	#inString = false;
	#escaped = false;

	constructor(framing: StreamFraming) {
		this.#json = framing === "json";
	}

	push(chunk: string): string {
		const text = this.#partial + chunk;
		const newline = text.lastIndexOf("\n");
		if (newline < 0) {
			this.#partial = text;
			return "";
		}
		this.#partial = text.slice(newline + 1);
		// Sanitize whole lines only: ANSI sequences never span a newline, so this
		// equals the corresponding slice of the full sanitized output.
		const complete = sanitizeText(text.slice(0, newline + 1));
		if (!this.#json) return complete;
		const held = this.#held + complete;
		const cut = this.#scan(held, this.#held.length);
		this.#held = held.slice(cut);
		return held.slice(0, cut);
	}

	/** Advance the scanner over `text` from `from`; returns the offset after the last line end outside a document. */
	#scan(text: string, from: number): number {
		let cut = 0;
		for (let index = from; index < text.length; index += 1) {
			const char = text[index];
			if (!this.#inDocument) {
				if (char === "\n") cut = index + 1;
				else if (char === "{" || char === "[") {
					this.#inDocument = true;
					this.#depth = 1;
					this.#inString = false;
					this.#escaped = false;
				}
				continue;
			}
			if (this.#inString) {
				if (this.#escaped) this.#escaped = false;
				else if (char === "\\") this.#escaped = true;
				else if (char === '"') this.#inString = false;
				continue;
			}
			if (char === '"') this.#inString = true;
			else if (char === "{" || char === "[") this.#depth += 1;
			else if (char === "}" || char === "]") this.#depth -= 1;
			if (this.#depth === 0) this.#inDocument = false;
		}
		return cut;
	}
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function toArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nestedRecord(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
	return toRecord(record?.[key]);
}

function normalizeSeverity(value: DiagnosticFields["severity"]): CleanseSeverity {
	if (typeof value === "number") return value >= 2 ? "error" : value === 1 ? "warning" : "info";
	const normalized = String(value ?? "warning").toLowerCase();
	if (normalized.includes("error") || normalized === "fatal") return "error";
	if (normalized.includes("warn") || normalized === "convention" || normalized === "refactor") return "warning";
	return "info";
}

function normalizeFile(rawFile: string, input: CleanseParserInput): string | undefined {
	let file = rawFile.trim().replace(/^['"]|['"]$/g, "");
	if (!file || file.startsWith("<")) return undefined;
	if (file.startsWith("file://")) {
		try {
			file = decodeURIComponent(new URL(file).pathname);
		} catch {
			return undefined;
		}
	}
	const absolute = path.isAbsolute(file) ? path.normalize(file) : path.resolve(input.checkerCwd, file);
	const relative = path.relative(input.projectCwd, absolute);
	if (!relative || relative === ".") return undefined;
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
	return relative.split(path.sep).join("/");
}

function makeDiagnostic(input: CleanseParserInput, fields: DiagnosticFields): CleanseDiagnostic | undefined {
	const message = sanitizeText(fields.message ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (!message) return undefined;
	const file = fields.file ? normalizeFile(fields.file, input) : undefined;
	if (fields.file && !file) return undefined;
	return {
		checker: input.checker,
		file,
		line: positiveInteger(fields.line),
		column: positiveInteger(fields.column),
		endLine: positiveInteger(fields.endLine),
		endColumn: positiveInteger(fields.endColumn),
		code: fields.code?.trim() || undefined,
		severity: normalizeSeverity(fields.severity),
		message,
		suggestion: fields.suggestion?.trim() || undefined,
	};
}

function positiveInteger(value: number | undefined): number | undefined {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

function addDiagnostic(target: CleanseDiagnostic[], input: CleanseParserInput, fields: DiagnosticFields): void {
	const diagnostic = makeDiagnostic(input, fields);
	if (diagnostic) target.push(diagnostic);
}

function parseJsonValues(text: string): unknown[] {
	const sanitized = sanitizeText(text).trim();
	if (!sanitized) return [];
	try {
		const parsed: unknown = JSON.parse(sanitized);
		return [parsed];
	} catch {}
	const values: unknown[] = [];
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < sanitized.length; index += 1) {
		const char = sanitized[index];
		if (start < 0) {
			if (char !== "{" && char !== "[") continue;
			start = index;
			depth = 1;
			inString = false;
			escaped = false;
			continue;
		}
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{" || char === "[") depth += 1;
		else if (char === "}" || char === "]") depth -= 1;
		if (depth !== 0) continue;
		try {
			const parsed: unknown = JSON.parse(sanitized.slice(start, index + 1));
			values.push(parsed);
		} catch {}
		start = -1;
	}
	return values;
}

function allJsonValues(input: CleanseParserInput): unknown[] {
	return [...parseJsonValues(input.stdout), ...parseJsonValues(input.stderr)];
}

function parseJsonSections(input: CleanseParserInput, sections: readonly JsonSection[]): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const root of allJsonValues(input)) {
		for (const section of sections) {
			for (const value of section.select(root)) {
				const record = toRecord(value);
				if (section.nested === undefined) {
					addDiagnostic(diagnostics, input, section.fields(record, undefined));
					continue;
				}
				for (const child of toArray(record?.[section.nested])) {
					addDiagnostic(diagnostics, input, section.fields(toRecord(child), record));
				}
			}
		}
	}
	return diagnostics;
}

function parseLines(input: CleanseParserInput, formats: readonly LineFormat[]): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const line of sanitizeText(`${input.stdout}\n${input.stderr}`).split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		for (const format of formats) {
			const match = format.pattern.exec(trimmed);
			if (!match) continue;
			addDiagnostic(diagnostics, input, format.fields(match));
			break;
		}
	}
	return diagnostics;
}

function jsonFormat(...sections: JsonSection[]): ParserSpec {
	return { parse: input => parseJsonSections(input, sections), stdout: "json", stderr: "json" };
}

function lineFormat(...formats: LineFormat[]): ParserSpec {
	return { parse: input => parseLines(input, formats), stdout: "lines", stderr: "lines" };
}

/** Elements of one array field on a top-level document object. */
function rootField(key: string): (root: unknown) => unknown[] {
	return root => toArray(toRecord(root)?.[key]);
}

function integer(value: string | undefined): number | undefined {
	return value ? Number.parseInt(value, 10) : undefined;
}

function zeroBased(value: number | undefined): number | undefined {
	return value === undefined ? undefined : value + 1;
}

function parseRust(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const value of parseJsonValues(input.stdout)) {
		const envelope = toRecord(value);
		if (stringField(envelope, "reason") !== "compiler-message") continue;
		const message = nestedRecord(envelope, "message");
		const level = stringField(message, "level");
		if (level !== "error" && level !== "warning") continue;
		const spans = toArray(message?.spans)
			.map(toRecord)
			.filter(entry => entry !== undefined);
		const primary = spans.find(span => span.is_primary === true) ?? spans[0];
		const code = nestedRecord(message, "code");
		addDiagnostic(diagnostics, input, {
			file: stringField(primary, "file_name"),
			line: numberField(primary, "line_start"),
			column: numberField(primary, "column_start"),
			endLine: numberField(primary, "line_end"),
			endColumn: numberField(primary, "column_end"),
			code: stringField(code, "code"),
			severity: level,
			message: stringField(message, "message"),
			suggestion: stringField(primary, "suggested_replacement"),
		});
	}
	return diagnostics;
}

function parseRustTest(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics = parseRust(input);
	const text = `${input.stdout}\n${input.stderr}`;
	for (const line of text.split("\n")) {
		const panic = /thread '([^']+)' panicked at (.*?):(\d+):(\d+):/.exec(line);
		if (!panic) continue;
		addDiagnostic(diagnostics, input, {
			file: panic[2],
			line: Number.parseInt(panic[3], 10),
			column: Number.parseInt(panic[4], 10),
			severity: "error",
			code: "test-failure",
			message: `test ${panic[1]} panicked`,
		});
	}
	return diagnostics;
}

function parseGoVet(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	const visit = (value: unknown, analyzer?: string): void => {
		if (Array.isArray(value)) {
			for (const child of value) visit(child, analyzer);
			return;
		}
		const record = toRecord(value);
		if (!record) return;
		const position = stringField(record, "posn") ?? stringField(record, "position");
		const message = stringField(record, "message");
		if (position && message) {
			const location = parseLocation(position);
			if (location) {
				addDiagnostic(diagnostics, input, {
					...location,
					code: stringField(record, "category") ?? analyzer,
					severity: "warning",
					message,
				});
			}
			return;
		}
		for (const key in record) visit(record[key], key);
	};
	for (const value of allJsonValues(input)) visit(value);
	return diagnostics;
}

function parseGoTestEvents(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const value of parseJsonValues(input.stdout)) {
		const event = toRecord(value);
		const output = stringField(event, "Output");
		if (output) {
			for (const line of output.split("\n")) {
				const location = /^\s*(?:\.\/)?(.+?\.go):(\d+)(?::(\d+))?:\s*(.+?)\s*$/.exec(line);
				if (!location) continue;
				addDiagnostic(diagnostics, input, {
					file: location[1],
					line: Number.parseInt(location[2], 10),
					column: location[3] ? Number.parseInt(location[3], 10) : undefined,
					severity: "error",
					code: "test-failure",
					message: location[4],
				});
			}
		}
		const testName = stringField(event, "Test");
		if (stringField(event, "Action") === "fail" && testName) {
			addDiagnostic(diagnostics, input, {
				severity: "error",
				code: "test-failure",
				message: `test ${testName} failed`,
			});
		}
	}
	return diagnostics;
}

function parsePhpstan(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const rootValue of allJsonValues(input)) {
		const root = toRecord(rootValue);
		const files = toRecord(root?.files);
		if (files) {
			for (const fileName in files) {
				const file = toRecord(files[fileName]);
				for (const messageValue of toArray(file?.messages)) {
					const message = toRecord(messageValue);
					addDiagnostic(diagnostics, input, {
						file: fileName,
						line: numberField(message, "line"),
						code: stringField(message, "identifier"),
						severity: "error",
						message: stringField(message, "message"),
					});
				}
			}
		}
		for (const error of toArray(root?.errors)) {
			if (typeof error === "string") addDiagnostic(diagnostics, input, { severity: "error", message: error });
		}
	}
	return diagnostics;
}

function parseDart(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const line of sanitizeText(`${input.stdout}\n${input.stderr}`).split("\n")) {
		const fields = line.split("|");
		if (fields.length < 8) continue;
		addDiagnostic(diagnostics, input, {
			severity: fields[0],
			code: fields[2],
			file: fields[3],
			line: Number.parseInt(fields[4], 10),
			column: Number.parseInt(fields[5], 10),
			message: fields.slice(7).join("|"),
		});
	}
	return diagnostics;
}

function parseLocation(value: string): ParsedLocation | undefined {
	const parenthesized = /^(.*?)\((\d+),(\d+)\)$/.exec(value.trim());
	if (parenthesized) {
		return {
			file: parenthesized[1],
			line: Number.parseInt(parenthesized[2], 10),
			column: Number.parseInt(parenthesized[3], 10),
		};
	}
	const colon = /^(.*?):(\d+)(?::(\d+))?$/.exec(value.trim());
	if (!colon) return undefined;
	return {
		file: colon[1],
		line: Number.parseInt(colon[2], 10),
		column: colon[3] ? Number.parseInt(colon[3], 10) : undefined,
	};
}

const GENERIC_FORMATS: readonly LineFormat[] = [
	{
		// MSVC / MSBuild: file(line,col): error C1234: message [project]
		pattern: /^(.*?)\((\d+),(\d+)\):\s*(error|warning|info)(?:\s+([A-Za-z]+\d+))?:\s*(.*?)(?:\s+\[[^\]]+\])?$/i,
		fields: match => ({
			file: match[1],
			line: integer(match[2]),
			column: integer(match[3]),
			severity: match[4],
			code: match[5],
			message: match[6],
		}),
	},
	{
		// GCC / clang / mypy: file:line[:col]: severity[ [code]]: message
		pattern: /^(.*?):(\d+)(?::(\d+))?:\s*(error|warning|info|note)(?:\s*\[([^\]]+)\])?:\s*(.*)$/i,
		fields: match => ({
			file: match[1],
			line: integer(match[2]),
			column: integer(match[3]),
			severity: match[4],
			code: match[5],
			message: match[6],
		}),
	},
];

function parseGeneric(input: CleanseParserInput): CleanseDiagnostic[] {
	return parseLines(input, GENERIC_FORMATS);
}

const GENERIC: ParserSpec = { parse: parseGeneric, stdout: "lines", stderr: "lines" };

const PARSERS: Record<CleanseParserKind, ParserSpec> = {
	rust: { parse: parseRust, stdout: "json", stderr: "lines" },
	"rust-test": { parse: parseRustTest, stdout: "json", stderr: "lines" },
	go: { parse: parseGoVet, fallback: parseGeneric, stdout: "json", stderr: "json" },
	"go-test": { parse: parseGoTestEvents, fallback: parseGeneric, stdout: "json", stderr: "lines" },
	staticcheck: jsonFormat({
		select: root => [root],
		fields: record => {
			const location = nestedRecord(record, "location");
			const end = nestedRecord(record, "end");
			return {
				file: stringField(location, "file"),
				line: numberField(location, "line"),
				column: numberField(location, "column"),
				endLine: numberField(end, "line"),
				endColumn: numberField(end, "column"),
				code: stringField(record, "code"),
				severity: stringField(record, "severity") ?? "warning",
				message: stringField(record, "message"),
			};
		},
	}),
	golangci: lineFormat({
		pattern: /^(.+?):(\d+):(\d+):\s+(.*?)\s+\(([A-Za-z0-9_-]+)\)$/,
		fields: match => ({
			file: match[1],
			line: integer(match[2]),
			column: integer(match[3]),
			code: match[5],
			severity: "warning",
			message: match[4],
		}),
	}),
	ruff: jsonFormat({
		select: toArray,
		fields: record => {
			const location = nestedRecord(record, "location");
			const endLocation = nestedRecord(record, "end_location");
			return {
				file: stringField(record, "filename"),
				line: numberField(location, "row"),
				column: numberField(location, "column"),
				endLine: numberField(endLocation, "row"),
				endColumn: numberField(endLocation, "column"),
				code: stringField(record, "code"),
				severity: "warning",
				message: stringField(record, "message"),
				suggestion: stringField(nestedRecord(record, "fix"), "message"),
			};
		},
	}),
	pyright: jsonFormat({
		select: rootField("generalDiagnostics"),
		fields: record => {
			const range = nestedRecord(record, "range");
			const start = nestedRecord(range, "start");
			const end = nestedRecord(range, "end");
			return {
				file: stringField(record, "file"),
				line: zeroBased(numberField(start, "line")),
				column: zeroBased(numberField(start, "character")),
				endLine: zeroBased(numberField(end, "line")),
				endColumn: zeroBased(numberField(end, "character")),
				code: stringField(record, "rule"),
				severity: stringField(record, "severity"),
				message: stringField(record, "message"),
			};
		},
	}),
	mypy: GENERIC,
	pylint: jsonFormat({
		select: toArray,
		fields: record => ({
			file: stringField(record, "path"),
			line: numberField(record, "line"),
			column: zeroBased(numberField(record, "column")),
			endLine: numberField(record, "endLine"),
			endColumn: zeroBased(numberField(record, "endColumn")),
			code: stringField(record, "symbol") ?? stringField(record, "message-id"),
			severity: stringField(record, "type"),
			message: stringField(record, "message"),
		}),
	}),
	flake8: lineFormat({
		pattern: /^(.+?):(\d+):(\d+):\s+([A-Z]+\d+)\s+(.*)$/,
		fields: match => ({
			file: match[1],
			line: integer(match[2]),
			column: integer(match[3]),
			code: match[4],
			severity: match[4].startsWith("F") || match[4].startsWith("E9") ? "error" : "warning",
			message: match[5],
		}),
	}),
	ty: lineFormat({
		pattern: /^(.+?):(\d+):(\d+):\s+(error|warning|info)\[([^\]]+)\]\s+(.*)$/,
		fields: match => ({
			file: match[1],
			line: integer(match[2]),
			column: integer(match[3]),
			code: match[5],
			severity: match[4],
			message: match[6],
		}),
	}),
	eslint: jsonFormat({
		select: toArray,
		nested: "messages",
		fields: (message, file) => ({
			file: stringField(file, "filePath"),
			line: numberField(message, "line"),
			column: numberField(message, "column"),
			endLine: numberField(message, "endLine"),
			endColumn: numberField(message, "endColumn"),
			code: stringField(message, "ruleId"),
			severity: numberField(message, "severity"),
			message: stringField(message, "message"),
			suggestion: nestedRecord(message, "fix") ? "automatic fix available" : undefined,
		}),
	}),
	biome: jsonFormat({
		select: rootField("diagnostics"),
		fields: record => {
			const location = nestedRecord(record, "location");
			return {
				file: stringField(nestedRecord(location, "path"), "file") ?? stringField(location, "path"),
				code: stringField(record, "category"),
				severity: stringField(record, "severity"),
				message:
					stringField(record, "description") ?? stringField(record, "message") ?? stringField(record, "title"),
			};
		},
	}),
	oxlint: lineFormat({
		// Unix format: file:line:col: message [Severity/rule]
		pattern: /^(.+?):(\d+):(\d+):\s+(.*?)\s+\[(Error|Warning)\/([^\]]+)\]$/i,
		fields: match => ({
			file: match[1],
			line: integer(match[2]),
			column: integer(match[3]),
			code: match[6],
			severity: match[5],
			message: match[4],
		}),
	}),
	"deno-lint": jsonFormat(
		{
			select: rootField("diagnostics"),
			fields: entry => {
				const range = nestedRecord(entry, "range");
				const start = nestedRecord(range, "start");
				const end = nestedRecord(range, "end");
				return {
					file: stringField(entry, "filename"),
					line: numberField(start, "line"),
					column: zeroBased(numberField(start, "col")),
					endLine: numberField(end, "line"),
					endColumn: zeroBased(numberField(end, "col")),
					code: stringField(entry, "code"),
					severity: "warning",
					message: stringField(entry, "message"),
					suggestion: stringField(entry, "hint"),
				};
			},
		},
		{
			select: rootField("errors"),
			fields: entry => ({
				file: stringField(entry, "file_path"),
				severity: "error",
				message: stringField(entry, "message"),
			}),
		},
	),
	stylelint: jsonFormat({
		select: root => toArray(root).filter(value => stringField(toRecord(value), "source") !== undefined),
		nested: "warnings",
		fields: (entry, file) => ({
			file: stringField(file, "source"),
			line: numberField(entry, "line"),
			column: numberField(entry, "column"),
			endLine: numberField(entry, "endLine"),
			endColumn: numberField(entry, "endColumn"),
			code: stringField(entry, "rule"),
			severity: stringField(entry, "severity"),
			message: stringField(entry, "text"),
		}),
	}),
	rubocop: jsonFormat({
		select: rootField("files"),
		nested: "offenses",
		fields: (offense, file) => {
			const location = nestedRecord(offense, "location");
			return {
				file: stringField(file, "path"),
				line: numberField(location, "start_line"),
				column: numberField(location, "start_column"),
				endLine: numberField(location, "last_line"),
				endColumn: numberField(location, "last_column"),
				code: stringField(offense, "cop_name"),
				severity: stringField(offense, "severity"),
				message: stringField(offense, "message"),
				suggestion: offense?.corrected === true ? "automatic correction available" : undefined,
			};
		},
	}),
	phpstan: { parse: parsePhpstan, stdout: "json", stderr: "json" },
	psalm: jsonFormat({
		select: toArray,
		fields: record => {
			const shortcode = numberField(record, "shortcode");
			return {
				file: stringField(record, "file_name") ?? stringField(record, "file_path"),
				line: numberField(record, "line_from"),
				column: numberField(record, "column_from"),
				endLine: numberField(record, "line_to"),
				endColumn: numberField(record, "column_to"),
				code: stringField(record, "type") ?? (shortcode === undefined ? undefined : String(shortcode)),
				severity: stringField(record, "severity"),
				message: stringField(record, "message"),
			};
		},
	}),
	swiftlint: jsonFormat({
		select: toArray,
		fields: record => ({
			file: stringField(record, "file"),
			line: numberField(record, "line"),
			column: numberField(record, "character"),
			code: stringField(record, "rule_id"),
			severity: stringField(record, "severity"),
			message: stringField(record, "reason"),
		}),
	}),
	dart: { parse: parseDart, stdout: "lines", stderr: "lines" },
	credo: jsonFormat({
		select: rootField("issues"),
		fields: record => ({
			file: stringField(record, "filename"),
			line: numberField(record, "line_no") ?? numberField(record, "line"),
			column: numberField(record, "column"),
			code: stringField(record, "check"),
			severity: stringField(record, "priority") ?? stringField(record, "category"),
			message: stringField(record, "message"),
		}),
	}),
	shellcheck: jsonFormat({
		// `--format=json` emits an array; `json1` wraps it in { comments }.
		select: root => (Array.isArray(root) ? root : rootField("comments")(root)),
		fields: record => {
			const code = numberField(record, "code");
			return {
				file: stringField(record, "file"),
				line: numberField(record, "line"),
				column: numberField(record, "column"),
				endLine: numberField(record, "endLine"),
				endColumn: numberField(record, "endColumn"),
				code: code === undefined ? undefined : `SC${code}`,
				severity: stringField(record, "level"),
				message: stringField(record, "message"),
				suggestion: record?.fix ? "automatic fix available" : undefined,
			};
		},
	}),
	hlint: jsonFormat({
		select: toArray,
		fields: record => ({
			file: stringField(record, "file"),
			line: numberField(record, "startLine"),
			column: numberField(record, "startColumn"),
			endLine: numberField(record, "endLine"),
			endColumn: numberField(record, "endColumn"),
			code: stringField(record, "hint"),
			severity: stringField(record, "severity"),
			message: stringField(record, "hint") ?? stringField(record, "from"),
			suggestion: stringField(record, "to"),
		}),
	}),
	terraform: jsonFormat({
		select: rootField("diagnostics"),
		fields: record => {
			const range = nestedRecord(record, "range");
			const start = nestedRecord(range, "start");
			const end = nestedRecord(range, "end");
			return {
				file: stringField(range, "filename"),
				line: numberField(start, "line"),
				column: numberField(start, "column"),
				endLine: numberField(end, "line"),
				endColumn: numberField(end, "column"),
				severity: stringField(record, "severity"),
				message: [stringField(record, "summary"), stringField(record, "detail")].filter(Boolean).join(": "),
			};
		},
	}),
	tflint: jsonFormat(
		{
			select: rootField("issues"),
			fields: record => {
				const rule = nestedRecord(record, "rule");
				const range = nestedRecord(record, "range");
				const start = nestedRecord(range, "start");
				const end = nestedRecord(range, "end");
				return {
					file: stringField(range, "filename"),
					line: numberField(start, "line"),
					column: numberField(start, "column"),
					endLine: numberField(end, "line"),
					endColumn: numberField(end, "column"),
					code: stringField(rule, "name"),
					severity: stringField(rule, "severity"),
					message: stringField(record, "message"),
				};
			},
		},
		{
			select: rootField("errors"),
			fields: error => ({ severity: "error", message: stringField(error, "message") }),
		},
	),
	actionlint: jsonFormat({
		select: toArray,
		fields: record => ({
			file: stringField(record, "filepath"),
			line: numberField(record, "line"),
			column: numberField(record, "column"),
			code: stringField(record, "kind"),
			severity: "error",
			message: stringField(record, "message"),
		}),
	}),
	generic: GENERIC,
};
