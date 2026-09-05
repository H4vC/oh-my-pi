import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { DeferredMCPTool, MCPTool, type MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { createMockConnection, createMockTransport } from "./mcp-test-utils";

type CapturedRequest = {
	method: string;
	params: Record<string, unknown> | undefined;
};

const unusedContext = {} as CustomToolContext;

function createSearchToolDefinition(): MCPToolDefinition {
	return {
		name: "search",
		description: "Search symbols or file locations",
		inputSchema: {
			type: "object",
			properties: {
				symbol: { type: "string" },
				language: { type: "string" },
				file: { type: "string" },
				line: { type: "number" },
				column: { type: "number" },
				filters: { type: "object" },
				exact: { type: "boolean" },
			},
			required: ["symbol", "language"],
		},
	};
}

function createCapturedConnection(calls: CapturedRequest[]): MCPServerConnection {
	const transport = createMockTransport(
		new Map([["tools/call", [{ content: [{ type: "text", text: "ok" }] }]]]),
		(method, params) => calls.push({ method, params }),
	);
	return createMockConnection({ tools: {} }, transport);
}

const imageToolDefinition: MCPToolDefinition = {
	name: "read_image_with_model",
	description: "Read an image from a local filesystem path",
	inputSchema: {
		type: "object",
		properties: {
			image_path: { type: "string" },
		},
		required: ["image_path"],
	},
};

async function createLocalImageContext(
	tempDir: TempDir,
): Promise<{ context: CustomToolContext; expectedPath: string }> {
	const artifactsDir = tempDir.join("artifacts");
	const writtenPath = path.join(artifactsDir, "local", "image-issue.png");
	await Bun.write(writtenPath, "png bytes");
	const expectedPath = await fs.realpath(writtenPath);
	return {
		context: {
			localProtocolOptions: {
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "session-id",
			},
		} as CustomToolContext,
		expectedPath,
	};
}

describe("MCP tool arguments", () => {
	it("omits optional empty placeholders before tools/call", async () => {
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), createSearchToolDefinition());

		await tool.execute(
			"call-1",
			{ symbol: "Foo", language: "", file: "", line: 0, filters: {}, exact: false },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: {
					name: "search",
					arguments: { symbol: "Foo", language: "", line: 0, exact: false },
				},
			},
		]);
	});

	it("omits optional empty placeholders for deferred MCP tools", async () => {
		const calls: CapturedRequest[] = [];
		const connection = createCapturedConnection(calls);
		const tool = new DeferredMCPTool("intellij-index", createSearchToolDefinition(), async () => connection);

		await tool.execute(
			"call-1",
			{ symbol: "Foo", language: "TypeScript", file: "", column: "", filters: {} },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: {
					name: "search",
					arguments: { symbol: "Foo", language: "TypeScript" },
				},
			},
		]);
	});

	it("strips the harness intent field before tools/call", async () => {
		// Regression: the harness injects `i` into every tool's wire schema and
		// the eval `tool.*` bridge forwards it verbatim. Strict-schema MCP
		// servers (e.g. Linear) reject every such call with
		// `unrecognized_keys: ["i"]`. The MCP boundary owns the contract; `i`
		// must never reach `tools/call`.
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), createSearchToolDefinition());

		await tool.execute(
			"call-1",
			{ [INTENT_FIELD]: "looking up Foo", symbol: "Foo", language: "TypeScript", file: "" },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: { name: "search", arguments: { symbol: "Foo", language: "TypeScript" } },
			},
		]);
	});

	it("strips the harness intent field for deferred MCP tools", async () => {
		const calls: CapturedRequest[] = [];
		const connection = createCapturedConnection(calls);
		const tool = new DeferredMCPTool("intellij-index", createSearchToolDefinition(), async () => connection);

		await tool.execute(
			"call-1",
			{ [INTENT_FIELD]: "deferred lookup", symbol: "Bar", language: "TypeScript" },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: { name: "search", arguments: { symbol: "Bar", language: "TypeScript" } },
			},
		]);
	});

	it("preserves `i` when the server's own schema declares it", async () => {
		// A server that legitimately exposes `i` as one of its parameters
		// must receive the caller-supplied value untouched. The boundary
		// guard checks the server's declared `properties` and steps aside.
		const calls: CapturedRequest[] = [];
		const definition: MCPToolDefinition = {
			name: "echo",
			description: "Echo a single token",
			inputSchema: {
				type: "object",
				properties: { i: { type: "string" } },
				required: ["i"],
			},
		};
		const tool = new MCPTool(createCapturedConnection(calls), definition);

		await tool.execute("call-1", { i: "hello" }, undefined, unusedContext, undefined);

		expect(calls).toEqual([{ method: "tools/call", params: { name: "echo", arguments: { i: "hello" } } }]);
	});

	it("preserves `i` only for the selected schema combinator branch", async () => {
		const calls: CapturedRequest[] = [];
		const definition: MCPToolDefinition = {
			name: "combinator_echo",
			description: "Echo with oneOf",
			inputSchema: {
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
						properties: { count: { type: "number" } },
						required: ["count"],
						additionalProperties: false,
					},
				],
			},
		};
		const tool = new MCPTool(createCapturedConnection(calls), definition);

		await tool.execute("call-1", { i: "branch-value" }, undefined, unusedContext, undefined);
		await tool.execute("call-2", { count: 1, i: "py prelude" }, undefined, unusedContext, undefined);

		expect(calls).toEqual([
			{ method: "tools/call", params: { name: "combinator_echo", arguments: { i: "branch-value" } } },
			{ method: "tools/call", params: { name: "combinator_echo", arguments: { count: 1 } } },
		]);
	});

	it("selects intent ownership across `if` discriminator branches", async () => {
		const calls: CapturedRequest[] = [];
		const definition: MCPToolDefinition = {
			name: "conditional_echo",
			description: "Echo gated by an if/then/else discriminator",
			inputSchema: {
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
			},
		};
		const tool = new MCPTool(createCapturedConnection(calls), definition);

		await tool.execute("call-1", { i: "special", x: 1 }, undefined, unusedContext, undefined);
		await tool.execute("call-2", { i: "py prelude", y: 1 }, undefined, unusedContext, undefined);

		expect(calls).toEqual([
			{ method: "tools/call", params: { name: "conditional_echo", arguments: { i: "special", x: 1 } } },
			{ method: "tools/call", params: { name: "conditional_echo", arguments: { y: 1 } } },
		]);
	});

	it("preserves `i` required via `required` or legacy draft-07 `dependencies`", async () => {
		const requiredCalls: CapturedRequest[] = [];
		const requiredTool = new MCPTool(createCapturedConnection(requiredCalls), {
			name: "required_echo",
			description: "Requires i without declaring it in properties",
			inputSchema: { type: "object", required: ["i"] },
		});
		await requiredTool.execute("call-1", { i: "hello" }, undefined, unusedContext, undefined);
		expect(requiredCalls).toEqual([
			{ method: "tools/call", params: { name: "required_echo", arguments: { i: "hello" } } },
		]);

		const legacyCalls: CapturedRequest[] = [];
		const legacyTool = new MCPTool(createCapturedConnection(legacyCalls), {
			name: "legacy_echo",
			description: "draft-07 dependencies requires i when x is present",
			inputSchema: {
				type: "object",
				properties: { x: { type: "number" } },
				required: ["x"],
				dependencies: { x: ["i"] },
			},
		});
		await legacyTool.execute("call-1", { x: 1, i: "hello" }, undefined, unusedContext, undefined);
		expect(legacyCalls).toEqual([
			{ method: "tools/call", params: { name: "legacy_echo", arguments: { x: 1, i: "hello" } } },
		]);
	});

	it("resolves local image arguments before forwarding tools/call", async () => {
		using tempDir = TempDir.createSync("@pi-mcp-local-image-");
		const calls: CapturedRequest[] = [];
		const { context, expectedPath } = await createLocalImageContext(tempDir);
		const tool = new MCPTool(createCapturedConnection(calls), imageToolDefinition);

		await tool.execute("call-1", { image_path: "local://image-issue.png" }, undefined, context, undefined);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: { name: "read_image_with_model", arguments: { image_path: expectedPath } },
			},
		]);
	});
});
