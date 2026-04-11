import { describe, expect, it, vi, beforeEach } from "vitest";
import { McpClient, McpManager, mcpToolsToLangChain } from "../src/core/mcp-client";
import type { McpServerConfig } from "../src/types";

describe("McpClient", () => {
	const baseConfig: McpServerConfig = {
		id: "test-1",
		name: "Test Server",
		url: "http://localhost:3000/mcp",
		enabled: true,
	};

	it("constructs with correct config", () => {
		const client = new McpClient(baseConfig);
		expect(client.name).toBe("Test Server");
		expect(client.id).toBe("test-1");
		expect(client.enabled).toBe(true);
	});

	it("respects enabled flag", () => {
		const client = new McpClient({ ...baseConfig, enabled: false });
		expect(client.enabled).toBe(false);
	});
});

describe("mcpToolsToLangChain", () => {
	it("creates LangChain tools from MCP tool definitions", () => {
		const client = new McpClient({
			id: "srv1",
			name: "Test",
			url: "http://localhost:3000/mcp",
			enabled: true,
		});

		const toolDefs = [
			{
				name: "search_web",
				description: "Search the web",
				inputSchema: {
					type: "object" as const,
					properties: {
						query: { type: "string", description: "Search query" },
						limit: { type: "number", description: "Max results" },
					},
					required: ["query"],
				},
			},
			{
				name: "get_weather",
				description: "Get weather for a location",
			},
		];

		const tools = mcpToolsToLangChain(client, toolDefs);
		expect(tools).toHaveLength(2);
		expect(tools[0].name).toBe("mcp_srv1_search_web");
		expect(tools[0].description).toContain("[MCP: Test]");
		expect(tools[0].description).toContain("Search the web");
		expect(tools[1].name).toBe("mcp_srv1_get_weather");
	});

	it("handles tools with no inputSchema", () => {
		const client = new McpClient({
			id: "srv1",
			name: "Test",
			url: "http://localhost:3000/mcp",
			enabled: true,
		});

		const tools = mcpToolsToLangChain(client, [{ name: "ping" }]);
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("mcp_srv1_ping");
	});
});

describe("McpManager", () => {
	it("starts with empty state", () => {
		const manager = new McpManager();
		expect(manager.getAllTools()).toEqual([]);
		expect(manager.getStatuses()).toEqual([]);
	});

	it("connectAll filters by enabled", async () => {
		const manager = new McpManager();
		// Using a non-existent server, so it will fail but we verify the filtering
		const configs: McpServerConfig[] = [
			{ id: "s1", name: "Enabled", url: "http://localhost:1/mcp", enabled: true },
			{ id: "s2", name: "Disabled", url: "http://localhost:2/mcp", enabled: false },
		];
		const statuses = await manager.connectAll(configs);
		// Only enabled servers are attempted
		expect(statuses).toHaveLength(1);
		expect(statuses[0].serverId).toBe("s1");
		expect(statuses[0].connected).toBe(false); // fails because no server
		expect(statuses[0].error).toBeDefined();
	});

	it("disconnectAll clears state", async () => {
		const manager = new McpManager();
		await manager.disconnectAll();
		expect(manager.getAllTools()).toEqual([]);
		expect(manager.getStatuses()).toEqual([]);
	});
});
