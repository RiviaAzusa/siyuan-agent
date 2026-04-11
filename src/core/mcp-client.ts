/**
 * MCP (Model Context Protocol) Client
 *
 * Connects to MCP servers via Streamable HTTP transport and exposes their
 * tools as LangChain StructuredToolInterface instances.
 *
 * Protocol reference: https://modelcontextprotocol.io/specification/2025-03-26
 *
 * Streamable HTTP transport:
 * - POST to server endpoint with JSON-RPC request body
 * - Response is JSON-RPC result
 * - SSE streaming for notifications (optional)
 */
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { McpServerConfig } from "../types";

/* ── JSON-RPC types ──────────────────────────────────────────────────── */

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: Record<string, unknown>;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number;
	result?: any;
	error?: { code: number; message: string; data?: any };
}

/* ── MCP protocol types ──────────────────────────────────────────────── */

interface McpToolDefinition {
	name: string;
	description?: string;
	inputSchema?: {
		type: "object";
		properties?: Record<string, any>;
		required?: string[];
	};
}

interface McpToolResult {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	isError?: boolean;
}

/* ── MCP Client ──────────────────────────────────────────────────────── */

export class McpClient {
	private config: McpServerConfig;
	private nextId = 1;
	private sessionId: string | null = null;

	constructor(config: McpServerConfig) {
		this.config = config;
	}

	get name(): string { return this.config.name; }
	get id(): string { return this.config.id; }
	get enabled(): boolean { return this.config.enabled; }

	/** Send a JSON-RPC request to the MCP server */
	private async rpc(method: string, params?: Record<string, unknown>): Promise<any> {
		const request: JsonRpcRequest = {
			jsonrpc: "2.0",
			id: this.nextId++,
			method,
			params,
		};

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"Accept": "application/json, text/event-stream",
		};
		if (this.config.apiKey) {
			headers["Authorization"] = `Bearer ${this.config.apiKey}`;
		}
		if (this.sessionId) {
			headers["Mcp-Session-Id"] = this.sessionId;
		}

		const resp = await fetch(this.config.url, {
			method: "POST",
			headers,
			body: JSON.stringify(request),
		});

		// Capture session ID from response
		const sessionHeader = resp.headers.get("Mcp-Session-Id");
		if (sessionHeader) {
			this.sessionId = sessionHeader;
		}

		if (!resp.ok) {
			throw new Error(`MCP server ${this.config.name} returned ${resp.status}: ${await resp.text()}`);
		}

		const contentType = resp.headers.get("Content-Type") || "";
		if (contentType.includes("text/event-stream")) {
			// SSE response — parse the first complete JSON-RPC result
			return this.parseSSEResponse(resp);
		}

		const result: JsonRpcResponse = await resp.json();
		if (result.error) {
			throw new Error(`MCP error [${result.error.code}]: ${result.error.message}`);
		}
		return result.result;
	}

	/** Parse SSE stream to extract JSON-RPC response */
	private async parseSSEResponse(resp: Response): Promise<any> {
		const text = await resp.text();
		const lines = text.split("\n");
		for (const line of lines) {
			if (line.startsWith("data: ")) {
				try {
					const data: JsonRpcResponse = JSON.parse(line.slice(6));
					if (data.error) {
						throw new Error(`MCP error [${data.error.code}]: ${data.error.message}`);
					}
					return data.result;
				} catch (e) {
					if (e instanceof SyntaxError) continue;
					throw e;
				}
			}
		}
		throw new Error(`No valid JSON-RPC response in SSE stream from ${this.config.name}`);
	}

	/** Initialize the MCP session */
	async initialize(): Promise<{ serverName: string; tools: McpToolDefinition[] }> {
		const initResult = await this.rpc("initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "siyuan-agent", version: "1.0.0" },
		});

		// Send initialized notification (no response expected)
		try {
			await this.rpc("notifications/initialized");
		} catch (_) {
			// Notifications may return empty/204
		}

		const serverName = initResult?.serverInfo?.name || this.config.name;
		const toolsResult = await this.rpc("tools/list");
		const tools: McpToolDefinition[] = toolsResult?.tools || [];

		return { serverName, tools };
	}

	/** Call a tool on the MCP server */
	async callTool(name: string, args: Record<string, unknown>): Promise<string> {
		const result: McpToolResult = await this.rpc("tools/call", { name, arguments: args });
		const parts = (result?.content || []).map((c) => {
			if (c.type === "text") return c.text || "";
			if (c.type === "image") return `[image: ${c.mimeType}]`;
			if (c.type === "resource") return c.text || "[resource]";
			return JSON.stringify(c);
		});
		const output = parts.join("\n");
		if (result?.isError) {
			return `[MCP Error] ${output}`;
		}
		return output;
	}

	/** Close the MCP session */
	async close(): Promise<void> {
		if (this.sessionId) {
			try {
				const headers: Record<string, string> = {};
				if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
				if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;
				await fetch(this.config.url, { method: "DELETE", headers });
			} catch (_) { /* best effort */ }
			this.sessionId = null;
		}
	}
}

/* ── Convert MCP tool definitions → LangChain tools ──────────────────── */

/** Convert a JSON Schema property to a Zod schema (basic types) */
function jsonSchemaToZod(prop: any): z.ZodType {
	if (!prop) return z.any();
	const desc = prop.description || undefined;
	switch (prop.type) {
		case "string":
			return desc ? z.string().describe(desc) : z.string();
		case "number":
		case "integer":
			return desc ? z.number().describe(desc) : z.number();
		case "boolean":
			return desc ? z.boolean().describe(desc) : z.boolean();
		case "array":
			return desc ? z.array(jsonSchemaToZod(prop.items || {})).describe(desc) : z.array(jsonSchemaToZod(prop.items || {}));
		default:
			return desc ? z.any().describe(desc) : z.any();
	}
}

/** Build a Zod object schema from an MCP tool's inputSchema */
function buildZodSchema(inputSchema?: McpToolDefinition["inputSchema"]): z.ZodObject<any> {
	if (!inputSchema?.properties) return z.object({});
	const shape: Record<string, z.ZodType> = {};
	const required = new Set(inputSchema.required || []);
	for (const [key, prop] of Object.entries(inputSchema.properties)) {
		const zodType = jsonSchemaToZod(prop);
		shape[key] = required.has(key) ? zodType : zodType.optional();
	}
	return z.object(shape);
}

/** Create LangChain tools from an MCP client's tool list */
export function mcpToolsToLangChain(
	client: McpClient,
	toolDefs: McpToolDefinition[],
): StructuredToolInterface[] {
	return toolDefs.map((def) => {
		const schema = buildZodSchema(def.inputSchema);
		return tool(
			async (args) => {
				try {
					return await client.callTool(def.name, args);
				} catch (err) {
					return `[MCP tool error: ${def.name}] ${String(err)}`;
				}
			},
			{
				name: `mcp_${client.id}_${def.name}`,
				description: `[MCP: ${client.name}] ${def.description || def.name}`,
				schema,
			},
		);
	});
}

/* ── Manager: orchestrates multiple MCP clients ──────────────────────── */

export interface McpConnectionStatus {
	serverId: string;
	serverName: string;
	connected: boolean;
	toolCount: number;
	error?: string;
}

export class McpManager {
	private clients: Map<string, McpClient> = new Map();
	private tools: Map<string, StructuredToolInterface[]> = new Map();
	private statuses: Map<string, McpConnectionStatus> = new Map();

	/** Connect to all enabled MCP servers and collect their tools */
	async connectAll(configs: McpServerConfig[]): Promise<McpConnectionStatus[]> {
		// Close existing connections
		await this.disconnectAll();

		const results: McpConnectionStatus[] = [];
		const enabledConfigs = configs.filter((c) => c.enabled);

		await Promise.allSettled(
			enabledConfigs.map(async (config) => {
				const status: McpConnectionStatus = {
					serverId: config.id,
					serverName: config.name,
					connected: false,
					toolCount: 0,
				};
				try {
					const client = new McpClient(config);
					const { serverName, tools: toolDefs } = await client.initialize();
					const lcTools = mcpToolsToLangChain(client, toolDefs);
					this.clients.set(config.id, client);
					this.tools.set(config.id, lcTools);
					status.connected = true;
					status.serverName = serverName;
					status.toolCount = lcTools.length;
				} catch (err) {
					status.error = String(err);
				}
				this.statuses.set(config.id, status);
				results.push(status);
			}),
		);

		return results;
	}

	/** Get all tools from all connected MCP servers */
	getAllTools(): StructuredToolInterface[] {
		const allTools: StructuredToolInterface[] = [];
		for (const tools of this.tools.values()) {
			allTools.push(...tools);
		}
		return allTools;
	}

	/** Get connection statuses */
	getStatuses(): McpConnectionStatus[] {
		return Array.from(this.statuses.values());
	}

	/** Disconnect all MCP servers */
	async disconnectAll(): Promise<void> {
		const closePromises = Array.from(this.clients.values()).map((c) => c.close());
		await Promise.allSettled(closePromises);
		this.clients.clear();
		this.tools.clear();
		this.statuses.clear();
	}

	/** Disconnect a specific server */
	async disconnect(serverId: string): Promise<void> {
		const client = this.clients.get(serverId);
		if (client) {
			await client.close();
			this.clients.delete(serverId);
			this.tools.delete(serverId);
			this.statuses.delete(serverId);
		}
	}
}
