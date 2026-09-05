import { type AgentTool, type AgentToolResult, validateToolArgumentsForDispatch } from "@oh-my-pi/pi-agent-core";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import { dereferenceJsonSchema, isJsonSchemaValueValid, upgradeJsonSchemaTo202012 } from "@oh-my-pi/pi-ai/utils/schema";
import { isRecord } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { ToolSession } from "../../tools";
import { ToolError } from "../../tools/tool-errors";
import { isTodoPhase } from "../../tools/todo-shape";
import { EVAL_AGENT_BRIDGE_NAME, runEvalAgent } from "../agent-bridge";
import { EVAL_BUDGET_BRIDGE_NAME, type EvalBudgetResult, runEvalBudget } from "../budget-bridge";
import { EVAL_COMPLETION_BRIDGE_NAME, runEvalCompletion } from "../completion-bridge";
import { EVAL_CONCURRENCY_BRIDGE_NAME, type EvalConcurrencyResult, runEvalConcurrency } from "../concurrency-bridge";
import type { JsStatusEvent } from "./shared/types";

export type { JsStatusEvent } from "./shared/types";

interface ToolBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

type ToolValue =
	| string
	| EvalBudgetResult
	| EvalConcurrencyResult
	| {
			text: string;
			details?: unknown;
			images?: Array<{ mimeType: string; data: string }>;
			hasError?: boolean;
	  };
function toolResultHasError(result: AgentToolResult): boolean {
	if ((result as { isError?: unknown }).isError === true) {
		return true;
	}
	if (!(result.details && typeof result.details === "object")) {
		return false;
	}
	return (result.details as { isError?: unknown }).isError === true;
}

function isTodoMutationOperation(value: unknown): boolean {
	switch (value) {
		case "init":
		case "start":
		case "done":
		case "rm":
		case "drop":
		case "block":
		case "unblock":
		case "append":
			return true;
		default:
			return false;
	}
}

function persistTodoMutation(name: string, result: AgentToolResult, hasError: boolean, session: ToolSession): void {
	if (name !== "todo" || hasError) return;
	const details = result.details;
	if (!details || typeof details !== "object" || !("op" in details) || !("phases" in details)) return;
	if (!isTodoMutationOperation(details.op) || !Array.isArray(details.phases) || !details.phases.every(isTodoPhase)) {
		return;
	}
	session.persistTodoPhases?.(details.phases);
}

function getTool(session: ToolSession, name: string): AgentTool {
	const tool = session.getToolForEvalBridge ? session.getToolForEvalBridge(name) : session.getToolByName?.(name);
	if (!tool) {
		throw new ToolError(`Unknown tool from js runtime: ${name}`);
	}
	return tool;
}

const UNION_SCHEMA_KEYS = ["oneOf", "anyOf"] as const;

function schemaBranchDeclaresProperty(
	schema: unknown,
	property: string,
	value: unknown,
	visited: Set<unknown>,
): boolean {
	if (!isRecord(schema) || visited.has(schema)) return false;
	visited.add(schema);
	try {
		const properties = schema.properties;
		if (isRecord(properties) && Object.hasOwn(properties, property)) return true;

		// A bare `required` (no matching `properties` entry) still makes the field
		// part of the accepted shape — the repo validator enforces it — so it is
		// schema-owned, not harness intent.
		if (Array.isArray(schema.required) && schema.required.includes(property)) return true;

		// `dependentRequired: { trigger: [...] }` requires the field once its
		// trigger key is present in the value, so it applies to this candidate.
		const dependentRequired = schema.dependentRequired;
		if (isRecord(value) && isRecord(dependentRequired)) {
			for (const trigger in dependentRequired) {
				if (!Object.hasOwn(value, trigger)) continue;
				const deps = dependentRequired[trigger];
				if (Array.isArray(deps) && deps.includes(property)) return true;
			}
		}

		for (const key of UNION_SCHEMA_KEYS) {
			const branches = schema[key];
			if (!Array.isArray(branches)) continue;
			let matched = false;
			for (const branch of branches) {
				if (!isJsonSchemaValueValid(branch, value)) continue;
				matched = true;
				if (schemaBranchDeclaresProperty(branch, property, value, visited)) return true;
			}
			if (matched) continue;
			for (const branch of branches) {
				if (schemaBranchDeclaresProperty(branch, property, value, visited)) return true;
			}
		}

		const allOf = schema.allOf;
		if (Array.isArray(allOf)) {
			for (const branch of allOf) {
				if (schemaBranchDeclaresProperty(branch, property, value, visited)) return true;
			}
		}

		const conditional = schema.if;
		if (isRecord(conditional)) {
			const matches = isJsonSchemaValueValid(conditional, value);
			if (matches && schemaBranchDeclaresProperty(conditional, property, value, visited)) return true;
			const branch = matches ? schema.then : schema.else;
			if (schemaBranchDeclaresProperty(branch, property, value, visited)) return true;
		}

		const dependentSchemas = schema.dependentSchemas;
		if (isRecord(value) && isRecord(dependentSchemas)) {
			for (const dependency in dependentSchemas) {
				if (
					Object.hasOwn(value, dependency) &&
					schemaBranchDeclaresProperty(dependentSchemas[dependency], property, value, visited)
				) {
					return true;
				}
			}
		}

		return false;
	} finally {
		visited.delete(schema);
	}
}

/** Whether the schema branch selected by `value` declares `property`. */
export function schemaDeclaresProperty(schema: unknown, property: string, value: unknown): boolean {
	// Upgrade first so legacy draft-07 `dependencies` become the 2020-12
	// `dependentRequired`/`dependentSchemas` the validator and traversal both read.
	const resolved = upgradeJsonSchemaTo202012(dereferenceJsonSchema(schema));
	if (!isRecord(value) || !Object.hasOwn(value, property)) {
		return schemaBranchDeclaresProperty(resolved, property, value, new Set());
	}

	const withoutProperty = { ...value };
	delete withoutProperty[property];
	const candidate =
		!isJsonSchemaValueValid(resolved, value) && isJsonSchemaValueValid(resolved, withoutProperty)
			? withoutProperty
			: value;
	return schemaBranchDeclaresProperty(resolved, property, candidate, new Set());
}

function normalizeArgs(args: unknown, ownsIntent: boolean): unknown {
	if (!isRecord(args)) return args;
	// A schema-owned `i` is real data; never overwrite it with the placeholder.
	if (ownsIntent) return args;
	const record = { ...args };
	if (record[INTENT_FIELD] === undefined) {
		record[INTENT_FIELD] = "js prelude";
	}
	return record;
}

function validateArgsForBridge(
	tool: AgentTool,
	name: string,
	toolCallId: string,
	args: unknown,
	ownsIntent: boolean,
): unknown {
	if (!isRecord(args)) return args;
	// A schema-owned `i` is a declared parameter: validate it in place rather
	// than stripping the harness intent field, or the tool never executes.
	if (ownsIntent) {
		return validateToolArgumentsForDispatch(tool, { type: "toolCall", id: toolCallId, name, arguments: args }, args);
	}
	const intent = args[INTENT_FIELD];
	const stripped = { ...args };
	delete stripped[INTENT_FIELD];
	const validated = validateToolArgumentsForDispatch(
		tool,
		{ type: "toolCall", id: toolCallId, name, arguments: stripped },
		stripped,
	);
	return intent === undefined ? validated : { ...validated, [INTENT_FIELD]: intent };
}

function summarizeToolResult(
	name: string,
	args: unknown,
	result: AgentToolResult,
	text: string,
	hasError: boolean,
): JsStatusEvent {
	const record = (args && typeof args === "object" ? (args as Record<string, unknown>) : {}) as Record<
		string,
		unknown
	>;
	const details = (
		result.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {}
	) as Record<string, unknown>;
	const withError = (event: JsStatusEvent): JsStatusEvent =>
		hasError ? { ...event, hasError: true, error: text.slice(0, 500) } : event;

	switch (name) {
		case "read":
			return withError({ op: "read", path: record.path, chars: text.length, preview: text.slice(0, 500) });
		case "write":
			return withError({
				op: "write",
				path: record.path,
				chars: typeof record.content === "string" ? record.content.length : 0,
			});
		case "grep":
			return withError({
				op: "grep",
				pattern: record.pattern,
				path: record.path,
				count: details.matchCount ?? undefined,
			});
		case "glob":
			return withError({
				op: "glob",
				pattern: record.pattern,
				count: details.fileCount ?? undefined,
				matches: Array.isArray(details.files) ? details.files.slice(0, 20) : undefined,
			});
		case "bash":
			return withError({
				op: "run",
				cmd: record.command,
				code: typeof details.exitCode === "number" ? details.exitCode : undefined,
				output: text.slice(0, 500),
			});
		default:
			return withError({ op: name, chars: text.length });
	}
}

export async function callSessionTool(name: string, args: unknown, options: ToolBridgeOptions): Promise<ToolValue> {
	if (name === EVAL_COMPLETION_BRIDGE_NAME) {
		return await runEvalCompletion(args, options);
	}
	if (name === EVAL_AGENT_BRIDGE_NAME) {
		return await runEvalAgent(args, options);
	}
	if (name === EVAL_BUDGET_BRIDGE_NAME) {
		return await runEvalBudget(args, options);
	}
	if (name === EVAL_CONCURRENCY_BRIDGE_NAME) {
		return runEvalConcurrency(args, options);
	}
	if (name === "checkpoint" || name === "rewind") {
		// The session recognizes checkpoint/rewind only as direct toolResult
		// messages; a bridged call would report success without taking effect.
		throw new ToolError(`\`${name}\` cannot run through the eval bridge; call the direct \`${name}\` tool.`);
	}
	const tool = getTool(options.session, name);
	const ownsIntent = schemaDeclaresProperty(toolWireSchema(tool), INTENT_FIELD, args);
	const normalizedArgs = normalizeArgs(args, ownsIntent);
	const toolCallId = `js-${name}-${crypto.randomUUID()}`;
	try {
		const validatedArgs = validateArgsForBridge(tool, name, toolCallId, normalizedArgs, ownsIntent);
		const result = await tool.execute(
			toolCallId,
			validatedArgs,
			options.signal,
			undefined,
			options.session.getToolContext?.(),
		);
		const textBlocks = result.content.filter(
			(content): content is { type: "text"; text: string } =>
				content.type === "text" && typeof content.text === "string",
		);
		const imageBlocks = result.content.filter(
			(content): content is { type: "image"; mimeType: string; data: string } =>
				content.type === "image" && typeof content.mimeType === "string" && typeof content.data === "string",
		);
		const text = textBlocks.map(block => block.text).join("");
		const hasError = toolResultHasError(result);
		persistTodoMutation(name, result, hasError, options.session);
		options.emitStatus?.(summarizeToolResult(name, validatedArgs, result, text, hasError));
		if (result.details === undefined && imageBlocks.length === 0 && !hasError) {
			return text;
		}
		const value: Exclude<ToolValue, string> = {
			text,
			details: result.details,
		};
		if (imageBlocks.length > 0) {
			value.images = imageBlocks.map(block => ({
				mimeType: block.mimeType,
				data: block.data,
			}));
		}
		if (hasError) {
			value.hasError = true;
		}
		return value;
	} catch (error) {
		options.emitStatus?.({
			op: name,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
