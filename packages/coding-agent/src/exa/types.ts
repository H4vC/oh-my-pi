/**
 * Exa MCP Types
 *
 * Types for the Exa MCP client and tool implementations.
 *
 * @deprecated Unused by the coding agent; Exa search lives in `web/search/providers/exa`. Will be removed in the next major.
 * @module
 */
import type { TSchema } from "@oh-my-pi/pi-ai";

/** @deprecated MCP tool definition from server; use `MCPToolDefinition` from `mcp/types`. Will be removed in the next major. */
export interface MCPTool {
	name: string;
	description?: string;
	inputSchema: TSchema;
}

/** @deprecated Tool wrapper config for the deprecated `MCPWrappedTool`; no replacement. Will be removed in the next major. */
export interface MCPToolWrapperConfig {
	/** Our tool name (e.g., "exa_search") */
	name: string;
	/** Display label for UI */
	label: string;
	/** MCP tool name to call (e.g., "web_search_exa") */
	mcpToolName: string;
	/** Whether this is a websets tool (uses different MCP endpoint) */
	isWebsetsTool?: boolean;
}

/** @deprecated Raw Exa search result; use `searchExa` from `web/search/providers/exa`, whose `SearchResponse.sources` carry results (`web/search/types`). Will be removed in the next major. */
export interface ExaSearchResult {
	id?: string;
	title?: string;
	url?: string;
	author?: string;
	publishedDate?: string;
	text?: string;
	highlights?: string[];
	image?: string;
	favicon?: string;
}

/** @deprecated Raw Exa search response; use `searchExa` from `web/search/providers/exa`, which returns `SearchResponse` (`web/search/types`). Will be removed in the next major. */
export interface ExaSearchResponse {
	results?: ExaSearchResult[];
	statuses?: Array<{ id: string; status: string; source?: string }>;
	costDollars?: { total: number };
	searchTime?: number;
	requestId?: string;
}
