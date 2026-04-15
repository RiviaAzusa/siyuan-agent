import { describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createSubAgentTool, invokeSubAgent, invokeSubAgentSafe } from "../src/core/sub-agent";
import type { AgentConfig } from "../src/types";

vi.mock("siyuan", () => ({
	fetchPost: vi.fn(),
	openTab: vi.fn(),
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
	it("invokes the child agent with query-only input and no writer bridge", async () => {
		const invoke = vi.fn().mockResolvedValue({
			messages: [new AIMessage({ content: "探索结果" })],
		});
		const createAgent = vi.fn().mockResolvedValue({ invoke });
		const writer = vi.fn();
		const callbacks = [vi.fn()];
		const signal = new AbortController().signal;

		const options = {
			name: "explore_notes",
			description: "x",
			schema: z.object({ query: z.string() }),
			toolset: [
				{ name: "explore_notes" } as any,
				{ name: "search_fulltext" } as any,
				{ name: "edit_blocks" } as any,
			],
			systemPrompt: "prompt",
			getAgentConfig: createConfig,
			createAgent,
		};

		const result = await invokeSubAgent(
			options,
			{ query: "帮我看看最近在写什么" },
			{
				state: {
					messages: [
						new HumanMessage({ content: "这条历史消息不能传给 sub-agent" }),
						new AIMessage({ content: "也不要传这条" }),
					],
				},
				toolCallId: "parent-call-1",
				config: { callbacks },
				context: { userId: "u-1" },
				signal,
				writer,
			} as any,
		);

		expect(result).toBe("探索结果");
		expect(createAgent).toHaveBeenCalledWith(
			createConfig(),
			[expect.objectContaining({ name: "search_fulltext" }), expect.objectContaining({ name: "edit_blocks" })],
			"prompt",
			expect.objectContaining({ id: "__legacy__", model: "test-model" }),
		);
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(invoke).toHaveBeenCalledWith(
			{
				messages: [expect.any(HumanMessage)],
			},
			expect.objectContaining({
				recursionLimit: 12,
				signal,
				context: { userId: "u-1" },
				callbacks,
			}),
		);

		const invokeOptions = invoke.mock.calls[0][1];
		expect(invoke.mock.calls[0][0].messages).toHaveLength(1);
		expect(invoke.mock.calls[0][0].messages[0].content).toBe("帮我看看最近在写什么");
		expect(invokeOptions).not.toHaveProperty("writer");
		expect(invokeOptions).not.toHaveProperty("state");
		expect(writer).not.toHaveBeenCalled();
	});

	it("returns a readable fallback when the child agent has no final ai text", async () => {
		const invoke = vi.fn().mockResolvedValue({
			messages: [
				new HumanMessage({ content: "question" }),
				new ToolMessage({ content: "lookup", tool_call_id: "call-1" }),
			],
		});
		const createAgent = vi.fn().mockResolvedValue({ invoke });

		const options = {
			name: "explore_notes",
			description: "x",
			schema: z.object({ query: z.string() }),
			toolset: [],
			systemPrompt: "prompt",
			getAgentConfig: createConfig,
			createAgent,
		};

		const result = await invokeSubAgent(
			options,
			{ query: "没有答案时怎么办" },
			{
				state: {},
				toolCallId: "parent-call-2",
				config: {},
				context: undefined,
				signal: undefined,
				writer: vi.fn(),
			} as any,
		);

		expect(result).toBe("Explore 子智能体未返回最终文本结果。");
	});

	it("invokeSubAgentSafe catches errors and returns friendly message", async () => {
		const invoke = vi.fn().mockRejectedValue(new Error("API rate limit exceeded"));
		const createAgent = vi.fn().mockResolvedValue({ invoke });

		const options = {
			name: "explore_notes",
			description: "x",
			schema: z.object({ query: z.string() }),
			toolset: [],
			systemPrompt: "prompt",
			getAgentConfig: createConfig,
			createAgent,
		};

		const result = await invokeSubAgentSafe(
			options,
			{ query: "test" },
			{
				state: {},
				toolCallId: "parent-call-3",
				config: {},
				context: undefined,
				signal: undefined,
				writer: vi.fn(),
			} as any,
		);

		expect(result).toBe("[子智能体执行失败] API rate limit exceeded");
	});

	it("invokeSubAgentSafe re-throws abort errors", async () => {
		const abortError = new Error("aborted");
		abortError.name = "AbortError";
		const invoke = vi.fn().mockRejectedValue(abortError);
		const createAgent = vi.fn().mockResolvedValue({ invoke });

		const options = {
			name: "explore_notes",
			description: "x",
			schema: z.object({ query: z.string() }),
			toolset: [],
			systemPrompt: "prompt",
			getAgentConfig: createConfig,
			createAgent,
		};

		await expect(invokeSubAgentSafe(
			options,
			{ query: "test" },
			{
				state: {},
				toolCallId: "parent-call-4",
				config: {},
				context: undefined,
				signal: undefined,
				writer: vi.fn(),
			} as any,
		)).rejects.toThrow("aborted");
	});

	it("truncates excessively long sub-agent output", async () => {
		const longText = "a".repeat(10000);
		const invoke = vi.fn().mockResolvedValue({
			messages: [new AIMessage({ content: longText })],
		});
		const createAgent = vi.fn().mockResolvedValue({ invoke });

		const options = {
			name: "explore_notes",
			description: "x",
			schema: z.object({ query: z.string() }),
			toolset: [],
			systemPrompt: "prompt",
			getAgentConfig: createConfig,
			createAgent,
		};

		const result = await invokeSubAgent(
			options,
			{ query: "test" },
			{
				state: {},
				toolCallId: "parent-call-5",
				config: {},
				context: undefined,
				signal: undefined,
				writer: vi.fn(),
			} as any,
		);

		expect(result.length).toBeLessThan(8100);
		expect(result).toContain("...(已截断)");
	});
});

describe("tool registry", () => {
	it("keeps lookup tools read-only and excludes explore_notes itself", async () => {
		const { getLookupTools } = await import("../src/core/tools");
		expect(getLookupTools().map((toolDef) => toolDef.name)).toEqual([
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
		const names = getDefaultTools(createConfig).map((toolDef) => toolDef.name);

		expect(names).toContain("explore_notes");
		expect(names).toContain("append_block");
		expect(names).toContain("edit_blocks");
		expect(names).toContain("write_todos");
	});

	it("creates a langchain tool shell around the sub-agent helper", () => {
		const toolDef = createSubAgentTool({
			name: "explore_notes",
			description: "x",
			schema: z.object({ query: z.string() }),
			toolset: [],
			systemPrompt: "prompt",
			getAgentConfig: createConfig,
			createAgent: vi.fn(),
		});

		expect(toolDef.name).toBe("explore_notes");
		expect(toolDef.description).toBe("x");
	});
});
