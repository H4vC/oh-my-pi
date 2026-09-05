import { describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { TodoTool, type TodoPhase, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

function createTool(name: string, execute: AgentTool["execute"], parameters: unknown = type({})): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters,
		concurrency: "parallel",
		execute,
	} as unknown as AgentTool;
}

function createSession(tools: AgentTool[]): ToolSession {
	const registry = new Map(tools.map(tool => [tool.name, tool]));
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getToolByName: name => registry.get(name),
	};
}

describe("callSessionTool", () => {
	it("injects js intent and summarizes text results", async () => {
		const execute = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "hello" }],
		});
		const session = createSession([createTool("read", execute)]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool(
			"read",
			{ path: "/tmp/demo.txt", [INTENT_FIELD]: "reading demo" },
			{
				session,
				emitStatus: event => {
					statuses.push(event);
				},
			},
		);

		expect(result).toBe("hello");
		expect(execute).toHaveBeenCalledWith(
			expect.stringMatching(/^js-read-/),
			{ path: "/tmp/demo.txt", [INTENT_FIELD]: "reading demo" },
			undefined,
			undefined,
			undefined,
		);
		expect(statuses).toEqual([expect.objectContaining({ op: "read", path: "/tmp/demo.txt", chars: 5 })]);
	});

	it("passes the session tool context to bridged executions", async () => {
		const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		const context = { settings: Settings.isolated() } as AgentToolContext;
		const session = {
			...createSession([createTool("bash", execute)]),
			getToolContext: () => context,
		};

		await callSessionTool("bash", { command: "true" }, { session });

		expect(execute).toHaveBeenCalledWith(
			expect.stringMatching(/^js-bash-/),
			{ command: "true", [INTENT_FIELD]: "js prelude" },
			undefined,
			undefined,
			context,
		);
	});

	it("persists only successful mutating todo calls executed through the eval bridge", async () => {
		let phases: TodoPhase[] = [
			{
				name: "Bridge reproduction",
				tasks: [{ content: "finish phase", status: "in_progress" }],
			},
		];
		const persistTodoPhases = vi.fn((_phases: TodoPhase[]) => {});
		const todoSession: ToolSession = {
			...createSession([]),
			getTodoPhases: () => phases,
			setTodoPhases: next => {
				phases = next;
			},
		};
		const todoTool = new TodoTool(todoSession);
		const bridgeTool = createTool(
			"todo",
			async (toolCallId, args, signal) => todoTool.execute(toolCallId, todoTool.parameters.assert(args), signal),
			todoTool.parameters,
		);
		const session: ToolSession = {
			...todoSession,
			getToolByName: name => (name === "todo" ? bridgeTool : undefined),
			persistTodoPhases,
		};

		await callSessionTool(
			"todo",
			{
				op: "done",
				phase: "Bridge reproduction",
				list: null,
				task: null,
				items: null,
				reason: null,
			},
			{ session },
		);

		expect(phases[0]?.tasks.map(task => task.status)).toEqual(["completed"]);
		expect(persistTodoPhases).toHaveBeenCalledWith(phases);

		persistTodoPhases.mockClear();
		await callSessionTool("todo", { op: "view" }, { session });
		await callSessionTool("todo", { op: "done", task: "missing" }, { session });
		expect(persistTodoPhases).not.toHaveBeenCalled();
	});

	it("keeps lenient bridge fallback while removing provider parse markers", async () => {
		const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "recovered" }] });
		const tool = createTool("custom", execute, type({ required: "string" }));
		tool.lenientArgValidation = true;
		const session = createSession([tool]);

		await callSessionTool(
			"custom",
			{
				__parseError: "trailing comma",
				__rawJson: '{"recovered":"yes",}',
				recovered: "yes",
				[INTENT_FIELD]: "recovering call",
			},
			{ session },
		);

		expect(execute).toHaveBeenCalledWith(
			expect.stringMatching(/^js-custom-/),
			{ recovered: "yes", [INTENT_FIELD]: "recovering call" },
			undefined,
			undefined,
			undefined,
		);
	});

	it("preserves a schema-owned `i` argument instead of stripping it as harness intent", async () => {
		// A tool whose OWN schema declares `i` (e.g. an MCP server that exposes
		// it, including as required) must receive the caller value verbatim.
		// Stripping it made `validateToolArgumentsForDispatch` report the field
		// missing and the tool never executed.
		const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "echoed" }] });
		const tool = createTool("echo", execute, type({ i: "string" }));
		const session = createSession([tool]);

		await callSessionTool("echo", { i: "hello" }, { session });

		expect(execute).toHaveBeenCalledWith(
			expect.stringMatching(/^js-echo-/),
			{ i: "hello" },
			undefined,
			undefined,
			undefined,
		);
	});

	it("preserves `i` declared inside schema combinators (oneOf / anyOf)", async () => {
		const executeOneOf = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "oneOf" }] });
		const toolOneOf = createTool("one_of_tool", executeOneOf, {
			type: "object",
			oneOf: [
				{
					type: "object",
					properties: { i: { type: "string" } },
					required: ["i"],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: { other: { type: "number" } },
					required: ["other"],
					additionalProperties: false,
				},
			],
		});

		const executeArkOr = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "arkOr" }] });
		const toolArkOr = createTool(
			"ark_or_tool",
			executeArkOr,
			type.or(type({ i: "string" }), type({ count: "number" })),
		);

		const session = createSession([toolOneOf, toolArkOr]);

		await callSessionTool("one_of_tool", { i: "one-of-value" }, { session });
		expect(executeOneOf).toHaveBeenCalledWith(
			expect.stringMatching(/^js-one_of_tool-/),
			{ i: "one-of-value" },
			undefined,
			undefined,
			undefined,
		);

		await callSessionTool("one_of_tool", { other: 1, i: "py prelude" }, { session });
		expect(executeOneOf).toHaveBeenLastCalledWith(
			expect.stringMatching(/^js-one_of_tool-/),
			{ other: 1, i: "py prelude" },
			undefined,
			undefined,
			undefined,
		);

		await callSessionTool("ark_or_tool", { i: "ark-or-value" }, { session });
		expect(executeArkOr).toHaveBeenCalledWith(
			expect.stringMatching(/^js-ark_or_tool-/),
			{ i: "ark-or-value" },
			undefined,
			undefined,
			undefined,
		);

		await callSessionTool("ark_or_tool", { count: 1, i: "py prelude" }, { session });
		expect(executeArkOr).toHaveBeenLastCalledWith(
			expect.stringMatching(/^js-ark_or_tool-/),
			{ count: 1, i: "py prelude" },
			undefined,
			undefined,
			undefined,
		);
	});

	it("selects intent ownership across `if` discriminator branches", async () => {
		const executeIf = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "if" }] });
		const toolIf = createTool("if_tool", executeIf, {
			type: "object",
			if: {
				properties: { i: { const: "special" } },
				required: ["i"],
			},
			// oxlint-disable-next-line unicorn/no-thenable -- `then` is a JSON Schema conditional keyword, not a promise.
			then: {
				properties: { i: { type: "string" }, x: { type: "number" } },
				required: ["x"],
				additionalProperties: false,
			},
			else: {
				properties: { y: { type: "number" } },
				required: ["y"],
				additionalProperties: false,
			},
		});
		const session = createSession([toolIf]);

		await callSessionTool("if_tool", { i: "special", x: 1 }, { session });
		expect(executeIf).toHaveBeenLastCalledWith(
			expect.stringMatching(/^js-if_tool-/),
			{ i: "special", x: 1 },
			undefined,
			undefined,
			undefined,
		);

		await callSessionTool("if_tool", { i: "py prelude", y: 1 }, { session });
		expect(executeIf).toHaveBeenLastCalledWith(
			expect.stringMatching(/^js-if_tool-/),
			{ i: "py prelude", y: 1 },
			undefined,
			undefined,
			undefined,
		);
	});

	it("returns structured tool results when details or images are present", async () => {
		const session = createSession([
			createTool("custom", async () => ({
				content: [
					{ type: "text", text: "done" },
					{ type: "image", mimeType: "image/png", data: "abc123" },
				],
				details: { ok: true },
			})),
		]);

		const result = await callSessionTool("custom", {}, { session });

		expect(result).toEqual({
			text: "done",
			details: { ok: true },
			images: [{ mimeType: "image/png", data: "abc123" }],
		});
	});

	it("marks structured results when the underlying tool reports an error", async () => {
		const session = createSession([
			createTool("mcp__demo_fail", async () => ({
				content: [{ type: "text", text: "Error: bad input" }],
				details: { serverName: "demo", mcpToolName: "fail", isError: true },
			})),
		]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool(
			"mcp__demo_fail",
			{},
			{ session, emitStatus: event => statuses.push(event) },
		);

		expect(result).toEqual({
			text: "Error: bad input",
			details: { serverName: "demo", mcpToolName: "fail", isError: true },
			hasError: true,
		});
		expect(statuses).toEqual([
			expect.objectContaining({
				op: "mcp__demo_fail",
				chars: 16,
				hasError: true,
				error: "Error: bad input",
			}),
		]);
	});

	it("marks results with top-level isError", async () => {
		const session = createSession([
			createTool(
				"custom",
				async () =>
					({
						content: [{ type: "text", text: "preview mismatch" }],
						isError: true,
					}) as AgentToolResult,
			),
		]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool("custom", {}, { session, emitStatus: event => statuses.push(event) });

		expect(result).toEqual({
			text: "preview mismatch",
			details: undefined,
			hasError: true,
		});
		expect(statuses).toEqual([
			expect.objectContaining({
				op: "custom",
				chars: 16,
				hasError: true,
				error: "preview mismatch",
			}),
		]);
	});

	it("throws when the requested tool is not available in the session registry", async () => {
		const session = createSession([]);

		await expect(callSessionTool("missing", {}, { session })).rejects.toThrow("Unknown tool from js runtime");
	});

	it("executes the bridge-authorized tool instead of the raw registry tool", async () => {
		const rawExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "raw" }] });
		const authorizedExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "authorized" }] });
		const session = {
			...createSession([createTool("write", rawExecute)]),
			getToolForEvalBridge: () => createTool("write", authorizedExecute),
		};

		const result = await callSessionTool("write", { path: "out.txt", content: "data" }, { session });

		expect(result).toBe("authorized");
		expect(authorizedExecute).toHaveBeenCalledTimes(1);
		expect(rawExecute).not.toHaveBeenCalled();
	});

	it("rejects checkpoint and rewind before reaching the registry", async () => {
		const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		const session = createSession([createTool("checkpoint", execute), createTool("rewind", execute)]);

		await expect(callSessionTool("checkpoint", { goal: "g" }, { session })).rejects.toThrow(
			"cannot run through the eval bridge",
		);
		await expect(callSessionTool("rewind", { report: "r" }, { session })).rejects.toThrow(
			"cannot run through the eval bridge",
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("rejects a registry tool excluded from the eval bridge", async () => {
		const rawExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "raw" }] });
		const session = {
			...createSession([createTool("write", rawExecute)]),
			getToolForEvalBridge: () => undefined,
		};

		await expect(callSessionTool("write", { path: "out.txt", content: "data" }, { session })).rejects.toThrow(
			"Unknown tool from js runtime",
		);
		expect(rawExecute).not.toHaveBeenCalled();
	});
});
