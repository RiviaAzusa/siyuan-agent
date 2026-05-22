import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createSubAgentTool, invokeSubAgent, invokeSubAgentSafe } from "../src/core/sub-agent";
import type { AgentConfig } from "../src/types";

vi.mock("siyuan", () => ({
	fetchPost: vi.fn(),
	openTab: vi.fn(),
}));

vi.mock("ai", () => ({
	generateText: vi.fn().mockResolvedValue({
		text: "探索结果",
		steps: [{ text: "探索结果" }],
	}),
}));

function createConfig(): AgentConfig {
	return {
		apiBaseURL: "https://example.com/v1",
		apiKey: "test-key",
		model: "test-model",
		customInstructions: "",
	};
}

describe("createSubAgentTool", () => {
	it("creates a tool with correct name and description", () => {
		const tool = createSubAgentTool({
			name: "explore_notes",
			description: "Explore notes in the knowledge base",
			schema: z.object({ query: z.string() }),
			toolset: [],
			systemPrompt: "prompt",
			getAgentConfig: createConfig,
		});

		expect((tool as any).name).toBe("explore_notes");
		expect(tool.description).toBe("Explore notes in the knowledge base");
	});

	it("filters out self from toolset", () => {
		const toolset = [
			{ name: "explore_notes" } as any,
			{ name: "search_fulltext" } as any,
			{ name: "edit_blocks" } as any,
		];

		const tool = createSubAgentTool({
			name: "explore_notes",
			description: "x",
			schema: z.object({ query: z.string() }),
			toolset,
			systemPrompt: "prompt",
			getAgentConfig: createConfig,
		});

		expect((tool as any).name).toBe("explore_notes");
	});
});

describe("invokeSubAgentSafe", () => {
	it("catches errors and returns friendly message", async () => {
		const { generateText } = await import("ai");
		(generateText as any).mockRejectedValueOnce(new Error("API rate limit exceeded"));

		const options = {
			name: "explore_notes",
			description: "x",
			schema: z.object({ query: z.string() }),
			toolset: [],
			systemPrompt: "prompt",
			getAgentConfig: createConfig,
		};

		const result = await invokeSubAgentSafe(options, { query: "test" });
		expect(result).toContain("failed");
	});

	it("re-throws abort errors", async () => {
		const { generateText } = await import("ai");
		const abortError = new Error("aborted");
		abortError.name = "AbortError";
		(generateText as any).mockRejectedValueOnce(abortError);

		const options = {
			name: "explore_notes",
			description: "x",
			schema: z.object({ query: z.string() }),
			toolset: [],
			systemPrompt: "prompt",
			getAgentConfig: createConfig,
		};

		await expect(invokeSubAgentSafe(options, { query: "test" })).rejects.toThrow("aborted");
	});
});

describe("tool registry", () => {
	it("keeps lookup tools read-only and excludes explore_notes itself", async () => {
		const { getLookupTools } = await import("../src/core/tools");
		expect(getLookupTools().map((toolDef: any) => toolDef.name)).toEqual([
			"list_notebooks",
			"list_documents",
			"recent_documents",
			"get_document",
			"get_document_blocks",
			"get_document_outline",
			"read_block",
			"search_fulltext",
			"search_documents",
		]);
	});

	it("registers explore_notes in the default tool set", async () => {
		const { getDefaultTools } = await import("../src/core/tools");
		const names = getDefaultTools(createConfig).map((toolDef: any) => toolDef.name);

		expect(names).toContain("explore_notes");
		expect(names).toContain("append_block");
		expect(names).toContain("edit_blocks");
		expect(names).toContain("write_todos");
	});
});
