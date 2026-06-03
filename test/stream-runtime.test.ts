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
		expect(result.lastState.runMeta).toHaveLength(1);
		expect(result.lastState.runMeta?.[0]).toMatchObject({
			userMessageIndex: 0,
			status: "success",
		});
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

	it("persists tool calls, tool results, final answer, and args", async () => {
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
			.mockReturnValueOnce(
				makeResult(
					[
						{ type: "tool-call", toolCallId: "call-1", toolName: "search_documents", input: { query: "docs" } },
						{ type: "tool-result", toolCallId: "call-1", output: "found" },
					],
					firstMessages,
					[{ toolCallId: "call-1", toolName: "search_documents" }],
				)
			)
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
		const ui = buildMessagesView(result.lastState);
		expect(ui.filter((m: any) => m.role === "user")).toHaveLength(1);
		expect(ui[1]).toMatchObject({
			type: "processing_summary_ui",
			status: "done",
		});
		expect((ui[1] as any).details[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "tool-call", toolCallId: "call-1", toolName: "search_documents", input: { query: "docs" } }],
		});
		expect((ui[1] as any).details[1]).toMatchObject({
			type: "tool_message_ui",
			toolCallId: "call-1",
			toolName: "search_documents",
			status: "done",
			result: "found",
		});
		expect(ui[2]).toEqual({ role: "assistant", content: [{ type: "text", text: "I found it." }] });
	});

	it("unwraps text tool output before emitting UI tool_result events", async () => {
		const { streamText } = await import("ai");
		const editResult = JSON.stringify({ results: [{ oldId: "old", newIds: ["new"], rootDocId: "doc", status: "ok" }] });
		(streamText as any)
			.mockReturnValueOnce(makeResult(
				[
					{ type: "tool-call", toolCallId: "call-1", toolName: "edit_blocks", input: { blocks: [{ id: "old", content: "updated" }] } },
					{ type: "tool-result", toolCallId: "call-1", toolName: "edit_blocks", output: { type: "text", value: editResult } },
				],
				[
					{ role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "edit_blocks", input: { blocks: [{ id: "old", content: "updated" }] } }] },
					{ role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "edit_blocks", output: { type: "text", value: editResult } }] },
				],
				[{ toolCallId: "call-1", toolName: "edit_blocks" }],
			))
			.mockReturnValueOnce(makeResult(
				[{ type: "text-delta", text: "done" }],
				[{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			));

		const seen: any[] = [];
		await runAgentStream({
			setup: makeSetup(),
			input: mergeState(null, "edit"),
			onUiEvent: (event) => {
				if (event.type === "tool_result") seen.push(event);
			},
		});

		expect(seen[0]).toMatchObject({
			type: "tool_result",
			toolName: "edit_blocks",
			result: editResult,
		});
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
		expect(assistantUi).toHaveLength(1);
		expect(assistantUi[0]).toEqual({ role: "assistant", content: [{ type: "text", text: "done" }] });
		const processing = buildMessagesView(result.lastState).find((m: any) => m.type === "processing_summary_ui") as any;
		expect(processing.details[0].content.filter((part: any) => part.type === "tool-call")).toHaveLength(1);
	});

	it("updates state.todos through the tool runtime context", async () => {
		const { streamText } = await import("ai");
		const todos = {
			goal: "Cleanup",
			items: [{ content: "Remove writer", status: "completed" }],
			updatedAt: 123,
		};
		(streamText as any).mockImplementationOnce((opts: any) => {
			opts.experimental_context.setTodos(todos);
			return makeResult(
				[{ type: "text-delta", text: "done" }],
				[{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			);
		});

		const seen: any[] = [];
		const result = await runAgentStream({
			setup: makeSetup(),
			input: mergeState(null, "plan"),
			onUiEvent: (event) => {
				if (event.type === "todos_update") seen.push(event.todos);
			},
		});

		expect(result.lastState.todos).toEqual(todos);
		expect(seen).toEqual([todos]);
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
		expect(buildMessagesView(result.lastState).map((m: any) => m.role)).toEqual(["user", "assistant"]);
	});
});

describe("buildMessagesView", () => {
	it("builds tool cards from canonical messages", () => {
		const state = {
			messages: [
				{ role: "user", content: "find docs" },
				{ role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "search_documents", input: { query: "docs" } }] },
				{ role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "search_documents", output: { type: "text", value: "found" } }] },
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
			],
		};

		const view = buildMessagesView(state);
		expect(view).toHaveLength(3);
		expect(view[1]).toMatchObject({
			type: "processing_summary_ui",
			status: "done",
		});
		expect((view[1] as any).details[1]).toMatchObject({
			type: "tool_message_ui",
			toolCallId: "call-1",
			toolName: "search_documents",
			status: "done",
			result: "found",
		});
		expect(view[2]).toEqual({ role: "assistant", content: [{ type: "text", text: "done" }] });
	});

	it("adds a change summary for edit tools but not lookup tools", () => {
		const editResult = JSON.stringify({
			__tool_type: "edit_blocks",
			results: [
				{ oldId: "b1", newIds: ["b2"], rootDocId: "doc1", status: "ok" },
				{ oldId: "b3", newIds: ["b4"], rootDocId: "doc1", status: "ok" },
			],
		});
		const state = {
			messages: [
				{ role: "user", content: "edit this" },
				{ role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "edit_blocks", input: { blocks: [{ id: "b1", content: "new" }] } }] },
				{ role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "edit_blocks", output: { type: "text", value: editResult } }] },
				{ role: "assistant", content: [{ type: "tool-call", toolCallId: "call-2", toolName: "search_documents", input: { query: "x" } }] },
				{ role: "tool", content: [{ type: "tool-result", toolCallId: "call-2", toolName: "search_documents", output: { type: "text", value: "found" } }] },
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
			],
		};

		const summary = buildMessagesView(state).find((m: any) => m.type === "run_change_summary_ui") as any;
		expect(summary).toMatchObject({
			type: "run_change_summary_ui",
			total: 1,
			items: [{ action: "edit", toolName: "edit_blocks", id: "b2", blockId: "b2", blockIds: ["b2", "b4"], status: "ok" }],
		});
	});

	it("derives change tool display from tool-call input instead of successful tool result", () => {
		const state = {
			messages: [
				{ role: "user", content: "create doc" },
				{
					role: "assistant",
					content: [{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "create_document",
						input: {
							notebook: "20260212103518-btwmq6l",
							path: "/Test/AI工具测试文档",
							markdown: "# AI 工具测试文档",
						},
					}],
				},
				{
					role: "tool",
					content: [{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "create_document",
						output: { type: "text", value: JSON.stringify({ id: "result-doc", notebook: "nb", path: "/Wrong/Path" }) },
					}],
				},
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
			],
		};

		const processing = buildMessagesView(state).find((m: any) => m.type === "processing_summary_ui") as any;
		const tool = processing.details.find((m: any) => m.type === "tool_message_ui");
		expect(tool).toMatchObject({
			toolName: "create_document",
			status: "done",
			activity: {
				category: "change",
				action: "create",
				label: "/Test/AI工具测试文档",
				path: "/Test/AI工具测试文档",
				meta: "Created document",
				open: false,
			},
		});
		expect(tool.activity.id).toBeUndefined();
	});

	it("uses edit_blocks input for the friendly activity and keeps failed result text", () => {
		const state = {
			messages: [
				{ role: "user", content: "edit todo" },
				{
					role: "assistant",
					content: [{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "edit_blocks",
						input: {
							blocks: [{
								id: "20260524230326-dx2xwl8",
								content: "- [x] 完成 CRUD 功能测试\n- [ ] 编写测试报告",
							}],
						},
					}],
				},
				{
					role: "tool",
					content: [{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "edit_blocks",
						output: { type: "text", value: JSON.stringify({ results: [{ status: "error", error: "boom", rootDocId: "ignored-doc" }] }) },
					}],
				},
				{ role: "assistant", content: [{ type: "text", text: "failed" }] },
			],
		};

		const processing = buildMessagesView(state).find((m: any) => m.type === "processing_summary_ui") as any;
		const tool = processing.details.find((m: any) => m.type === "tool_message_ui");
		expect(tool).toMatchObject({
			toolName: "edit_blocks",
			status: "error",
			activity: {
				category: "change",
				action: "edit",
				label: "20260524230326-dx2xwl8",
				meta: "Edited 1 block(s)",
				open: false,
			},
		});
		expect(tool.activity.id).toBeUndefined();
		expect(tool.result).toContain("boom");
	});

	it("marks call_error tool results as failed when the result is a plain error object", () => {
		const state = {
			messages: [
				{ role: "user", content: "test error" },
				{ role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "call_error", input: { message: "debug boom" } }] },
				{ role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "call_error", output: { type: "text", value: JSON.stringify({ message: "debug boom" }) } }] },
				{ role: "assistant", content: [{ type: "text", text: "failed" }] },
			],
		};

		const processing = buildMessagesView(state).find((m: any) => m.type === "processing_summary_ui") as any;
		const tool = processing.details.find((m: any) => m.type === "tool_message_ui");
		expect(tool).toMatchObject({
			toolName: "call_error",
			status: "error",
		});
		expect(tool.result).toContain("debug boom");
	});

});
