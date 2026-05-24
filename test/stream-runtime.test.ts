import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeState, runAgentStream } from "../src/core/stream-runtime";
import { buildMessagesView } from "../src/core/ui-message-builder";

vi.mock("siyuan", () => ({
	fetchPost: vi.fn(),
	openTab: vi.fn(),
}));

vi.mock("ai", () => ({
	streamText: vi.fn(),
}));

async function* streamChunks(chunks: any[], error?: unknown): AsyncGenerator<any> {
	for (const chunk of chunks) {
		yield chunk;
	}
	if (error) throw error;
}

function makeResult(chunks: any[], messages: any[], toolCalls: any[] = [], error?: unknown): any {
	return {
		fullStream: streamChunks(chunks, error),
		toolCalls,
		response: { messages },
	};
}

function makeSetup(): any {
	return {
		model: {},
		tools: {},
		systemPrompt: "system",
	};
}

beforeEach(async () => {
	const { streamText } = await import("ai");
	(streamText as any).mockReset();
});

describe("mergeState", () => {
	it("returns empty messages for null state", () => {
		const result = mergeState(null);
		expect(result.messages).toEqual([]);
	});

	it("appends user message from inputMsgStr", () => {
		const result = mergeState(null, "hello");
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]).toEqual({ role: "user", content: "hello" });
	});

	it("converts lc:1 format messages to canonical AI SDK format", () => {
		const state = {
			messages: [
				{
					lc: 1,
					type: "constructor",
					id: ["langchain_core", "messages", "HumanMessage"],
					kwargs: { content: "old question" },
				},
				{
					lc: 1,
					type: "constructor",
					id: ["langchain_core", "messages", "AIMessage"],
					kwargs: {
						content: "old answer",
						additional_kwargs: { reasoning_content: "thinking..." },
					},
				},
			],
		};
		const result = mergeState(state, "new question");
		expect(result.messages).toHaveLength(3);
		expect(result.messages[0]).toEqual({ role: "user", content: "old question" });
		expect(result.messages[1]).toEqual({
			role: "assistant",
			content: [
				{ type: "reasoning", text: "thinking..." },
				{ type: "text", text: "old answer" },
			],
		});
		expect(result.messages[2]).toEqual({ role: "user", content: "new question" });
	});

	it("handles new format messages directly", () => {
		const state = {
			messages: [
				{ role: "user", content: "question" },
				{ role: "assistant", content: "answer" },
			],
		};
		const result = mergeState(state, "follow-up");
		expect(result.messages).toHaveLength(3);
		expect(result.messages[0]).toEqual({ role: "user", content: "question" });
		expect(result.messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "answer" }] });
		expect(result.messages[2]).toEqual({ role: "user", content: "follow-up" });
	});

	it("prepends compaction summary as system message", () => {
		const state = {
			messages: [],
			compaction: { summary: "Previous context", version: 1 },
		};
		const result = mergeState(state, "hello");
		expect(result.messages[0].role).toBe("system");
		expect(result.messages[0].content).toContain("Previous context");
		expect(result.messages[1]).toEqual({ role: "user", content: "hello" });
	});

	it("prepends todos as system message", () => {
		const state = {
			messages: [],
			todos: {
				goal: "Build feature",
				items: [{ content: "Step 1", status: "in_progress" }],
				updatedAt: Date.now(),
			},
		};
		const result = mergeState(state, "hello");
		expect(result.messages[0].role).toBe("system");
		expect(result.messages[0].content).toContain("Build feature");
	});

	it("does not carry messagesUi into merged runtime input", () => {
		const messagesUi = [{ role: "user", content: "prev" }];
		const state = { messages: [], messagesUi };
		const result = mergeState(state, "hello");
		expect((result as any).messagesUi).toBeUndefined();
	});
});

describe("runAgentStream", () => {
	it("persists user and assistant messages after a plain answer", async () => {
		const { streamText } = await import("ai");
		(streamText as any).mockReturnValue(makeResult(
			[{ type: "text-delta", text: "answer" }],
			[
				{ role: "assistant", content: [{ type: "text", text: "answer" }] },
			],
		));

		const result = await runAgentStream({
			setup: makeSetup(),
			input: mergeState(null, "hello"),
		});

		expect(result.completed).toBe(true);
		expect(result.lastState.messages).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		]);
		expect(result.lastState.messagesUi).toBeUndefined();
		expect(buildMessagesView(result.lastState).map((m: any) => m.role)).toEqual(["user", "assistant"]);
	});

	it("does not duplicate user when provider response includes input history", async () => {
		const { streamText } = await import("ai");
		(streamText as any).mockReturnValue(makeResult(
			[{ type: "text-delta", text: "answer" }],
			[
				{ role: "user", content: "hello" },
				{ role: "assistant", content: [{ type: "text", text: "answer" }] },
			],
		));

		const result = await runAgentStream({
			setup: makeSetup(),
			input: mergeState(null, "hello"),
		});

		expect(result.completed).toBe(true);
		expect(result.lastState.messages).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		]);
		expect(result.lastState.messagesUi).toBeUndefined();
		expect(buildMessagesView(result.lastState).map((m: any) => m.role)).toEqual(["user", "assistant"]);
	});

	it("passes persisted assistant context into the next model call", async () => {
		const { streamText } = await import("ai");
		(streamText as any).mockImplementation((opts: any) => makeResult(
			[{ type: "text-delta", text: "second" }],
			[
				...opts.messages,
				{ role: "assistant", content: [{ type: "text", text: "second" }] },
			],
		));

		await runAgentStream({
			setup: makeSetup(),
			input: mergeState({
				messages: [
					{ role: "user", content: "first" },
					{ role: "assistant", content: "first answer" },
				],
			}, "follow-up"),
		});

		expect((streamText as any).mock.calls[0][0].messages).toEqual([
			{ role: "user", content: "first" },
			{ role: "assistant", content: [{ type: "text", text: "first answer" }] },
			{ role: "user", content: "follow-up" },
		]);
	});

	it("persists tool calls, tool results, final answer, args, and writer events", async () => {
		const { streamText } = await import("ai");
		const firstMessages = [
			{
				role: "assistant",
				content: [{ type: "tool-call", toolCallId: "call-1", toolName: "search_documents", input: { query: "docs" } }],
			},
			{
				role: "tool",
				content: [{ type: "tool-result", toolCallId: "call-1", toolName: "search_documents", output: { type: "text", value: "found" } }],
			},
		];
		const finalMessages = [
			{ role: "assistant", content: [{ type: "text", text: "I found it." }] },
		];
		(streamText as any)
			.mockImplementationOnce((opts: any) => {
				opts.experimental_context.writer(JSON.stringify({
					__tool_type: "activity",
					category: "lookup",
					action: "search",
					label: "docs",
					toolCallId: "call-1",
				}));
				return makeResult(
					[
						{ type: "tool-call", toolCallId: "call-1", toolName: "search_documents", input: { query: "docs" } },
						{ type: "tool-result", toolCallId: "call-1", output: "found" },
					],
					firstMessages,
					[{ toolCallId: "call-1", toolName: "search_documents" }],
				);
			})
			.mockReturnValueOnce(makeResult(
				[{ type: "text-delta", text: "I found it." }],
				finalMessages,
			));

		const result = await runAgentStream({
			setup: makeSetup(),
			input: mergeState(null, "find docs"),
		});

		expect(result.lastState.messages).toEqual([
			{ role: "user", content: "find docs" },
			{ role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "search_documents", input: { query: "docs" } }] },
			{ role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "search_documents", output: { type: "text", value: "found" } }] },
			{ role: "assistant", content: [{ type: "text", text: "I found it." }] },
		]);
		expect(result.lastState.messagesUi).toBeUndefined();
		expect(result.lastState.toolUIEvents).toBeUndefined();
		const ui = buildMessagesView(result.lastState);
		expect(ui.filter((m: any) => m.role === "user")).toHaveLength(1);
		expect(ui[1]).toMatchObject({
			role: "assistant",
			content: [{ type: "tool-call", toolCallId: "call-1", toolName: "search_documents", input: { query: "docs" } }],
		});
		expect(ui[2]).toMatchObject({
			type: "tool_message_ui",
			toolCallId: "call-1",
			toolName: "search_documents",
			status: "done",
			result: "found",
		});
		expect(ui[3]).toEqual({ role: "assistant", content: [{ type: "text", text: "I found it." }] });
	});

	it("does not copy previous step tool calls onto the final assistant UI message", async () => {
		const { streamText } = await import("ai");
		(streamText as any)
			.mockReturnValueOnce(makeResult(
				[
					{ type: "tool-call", toolCallId: "call-1", toolName: "search_documents", input: { query: "x" } },
					{ type: "tool-result", toolCallId: "call-1", output: "ok" },
				],
				[
					{ role: "user", content: "x" },
					{ role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "search_documents", input: { query: "x" } }] },
					{ role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "search_documents", output: { type: "text", value: "ok" } }] },
				],
				[{ toolCallId: "call-1", toolName: "search_documents" }],
			))
			.mockReturnValueOnce(makeResult(
				[{ type: "text-delta", text: "done" }],
				[
					{ role: "user", content: "x" },
					{ role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "search_documents", input: { query: "x" } }] },
					{ role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "search_documents", output: { type: "text", value: "ok" } }] },
					{ role: "assistant", content: [{ type: "text", text: "done" }] },
				],
			));

		const result = await runAgentStream({
			setup: makeSetup(),
			input: mergeState(null, "x"),
		});

		const assistantUi = buildMessagesView(result.lastState).filter((m: any) => m.role === "assistant");
		expect(assistantUi).toHaveLength(2);
		expect(assistantUi[0].content.filter((part: any) => part.type === "tool-call")).toHaveLength(1);
		expect(assistantUi[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "done" }] });
	});

	it("returns partial UI state and incomplete status when streaming fails", async () => {
		const { streamText } = await import("ai");
		(streamText as any).mockReturnValue(makeResult(
			[{ type: "text-delta", text: "partial" }],
			[],
			[],
			new Error("boom"),
		));

		const result = await runAgentStream({
			setup: makeSetup(),
			input: mergeState(null, "hello"),
		});

		expect(result.completed).toBe(false);
		expect(result.error).toBeInstanceOf(Error);
		expect(result.lastState.messages).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "text", text: "partial" }] },
		]);
		expect(result.lastState.messagesUi).toBeUndefined();
		expect(buildMessagesView(result.lastState).map((m: any) => m.role)).toEqual(["user", "assistant"]);
	});
});

describe("buildMessagesView", () => {
	it("builds tool cards from canonical messages and tool events", () => {
		const state = {
			messages: [
				{ role: "user", content: "find docs" },
				{ role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "search_documents", input: { query: "docs" } }] },
				{ role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "search_documents", output: { type: "text", value: "found" } }] },
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
			],
			toolUIEvents: [
				{
					id: "ev-1",
					source: "writer" as const,
					toolCallIndex: 0,
					toolCallId: "call-1",
					toolName: "search_documents",
					payload: { type: "text" as const, text: "searching" },
				},
			],
		};

		const view = buildMessagesView(state);
		expect(view).toHaveLength(4);
		expect(view[2]).toMatchObject({
			type: "tool_message_ui",
			toolCallId: "call-1",
			toolName: "search_documents",
			status: "done",
			result: "found",
		});
	});

	it("uses legacy messagesUi only to recover a partial assistant after the same trailing user", () => {
		const state = {
			messages: [{ role: "user", content: "hello" }],
			messagesUi: [
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "partial" },
			],
		};

		expect(buildMessagesView(state)).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "partial" },
		]);
	});
});
