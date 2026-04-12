import { describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { mergeState, runAgentStream } from "../src/core/stream-runtime";
import { isToolMessageUi } from "../src/types";
import type { AgentStreamUiEvent } from "../src/types";

type StreamChunk = [string, any];

function createAbortError(): Error {
	const error = new Error("aborted");
	error.name = "AbortError";
	return error;
}

function createAgent(items: Array<StreamChunk | Error>) {
	return {
		stream: async () => (async function* () {
			for (const item of items) {
				if (item instanceof Error) {
					throw item;
				}
				yield item;
			}
		})(),
	};
}

function getContents(messages: any[]): string[] {
	return messages.map((message) => String(message?.content ?? message?.kwargs?.content ?? ""));
}

function getTypes(messages: any[]): string[] {
	return messages.map((message) => String(message?._getType?.() ?? message?.type ?? ""));
}

function getUiAiContents(messagesUi: any[]): string[] {
	return messagesUi
		.filter((message) => !isToolMessageUi(message))
		.filter((message) => (message?.id?.[message.id.length - 1] ?? "") === "AIMessage")
		.map((message) => String(message?.kwargs?.content ?? message?.content ?? ""));
}

describe("runAgentStream", () => {
	it("keeps the latest values snapshot as the recovery source of truth", async () => {
		const input = mergeState(null, "hello");
		const finalState = {
			messages: [...input.messages, new AIMessage({ content: "done" })],
			marker: 2,
		};

		const result = await runAgentStream({
			agent: createAgent([
				["values", { messages: [...input.messages], marker: 1 }],
				["values", finalState],
			]),
			input,
		});

		expect(result.completed).toBe(true);
		expect(result.lastState.marker).toBe(2);
		expect(getContents(result.lastState.messages || [])).toEqual(["hello", "done"]);
	});

	it("persists a partial AI message when streaming aborts mid-response", async () => {
		const input = mergeState(null, "hello");

		const result = await runAgentStream({
			agent: createAgent([
				["messages", [{ _getType: () => "ai", content: "Hel" }, {}]],
				["messages", [{ _getType: () => "ai", content: "lo" }, {}]],
				createAbortError(),
			]),
			input,
		});

		expect(result.aborted).toBe(true);
		expect(result.completed).toBe(false);
		expect(getContents(result.lastState.messages || [])).toEqual(["hello", "Hello"]);
	});

	it("does not duplicate the final AI message when values already contain it", async () => {
		const input = mergeState(null, "hello");
		const finalAi = new AIMessage({ content: "Hello" });

		const result = await runAgentStream({
			agent: createAgent([
				["messages", [{ _getType: () => "ai", content: "Hello" }, {}]],
				["values", { messages: [...input.messages, finalAi] }],
			]),
			input,
		});

		expect(result.completed).toBe(true);
		expect(result.lastState.messages).toHaveLength(2);
		expect(getContents(result.lastState.messages || [])).toEqual(["hello", "Hello"]);
	});

	it("keeps assistant turns separated across tool boundaries on abort", async () => {
		const input = mergeState(null, "hello");

		const result = await runAgentStream({
			agent: createAgent([
				["messages", [{
					_getType: () => "ai",
					content: "Let me check. ",
					tool_call_chunks: [{ name: "search_fulltext", id: "call-1", args: { query: "foo" } }],
				}, {}]],
				["messages", [{
					_getType: () => "tool",
					content: "42",
					tool_call_id: "call-1",
				}, {}]],
				["messages", [{
					_getType: () => "ai",
					content: "The answer is 42",
				}, {}]],
				createAbortError(),
			]),
			input,
		});

		expect(result.aborted).toBe(true);
		expect(getTypes(result.lastState.messages || [])).toEqual(["human", "ai", "tool", "ai"]);
		expect(getContents(result.lastState.messages || [])).toEqual([
			"hello",
			"Let me check. ",
			"42",
			"The answer is 42",
		]);
	});

	it("persists tool results received after the latest values snapshot", async () => {
		const input = mergeState(null, "hello");
		const aiWithToolCall = new AIMessage({
			content: "",
			tool_calls: [{ name: "search_fulltext", args: { query: "foo" }, id: "call-1" }],
		});

		const result = await runAgentStream({
			agent: createAgent([
				["values", { messages: [...input.messages, aiWithToolCall] }],
				["messages", [{
					_getType: () => "tool",
					content: "42",
					tool_call_id: "call-1",
				}, {}]],
				createAbortError(),
			]),
			input,
		});

		expect(result.aborted).toBe(true);
		expect(getTypes(result.lastState.messages || [])).toEqual(["human", "ai", "tool"]);
		expect(getContents(result.lastState.messages || [])).toEqual(["hello", "", "42"]);
	});

	it("binds custom tool UI events back to the originating toolCallId", async () => {
		const input = mergeState(null, "search foo");
		const uiEvents: AgentStreamUiEvent[] = [];

		const result = await runAgentStream({
			agent: createAgent([
				["messages", [{
					_getType: () => "ai",
					content: "",
					tool_call_chunks: [{ name: "search_fulltext", id: "call-1", args: { query: "foo" } }],
				}, {}]],
				["custom", JSON.stringify({
					__tool_type: "activity",
					toolCallId: "call-1",
					category: "lookup",
					action: "search",
					label: "foo",
				})],
			]),
			input,
			onUiEvent: (event) => {
				uiEvents.push(event);
			},
		});

		expect(uiEvents).toEqual([
			expect.objectContaining({
				type: "tool_call_start",
				toolCallIndex: 0,
				toolCallId: "call-1",
				toolName: "search_fulltext",
			}),
			expect.objectContaining({
				type: "tool_ui",
				event: expect.objectContaining({
					toolCallId: "call-1",
					toolCallIndex: 0,
					toolName: "search_fulltext",
				}),
			}),
		]);
		expect(result.lastState.toolUIEvents).toEqual([
			expect.objectContaining({
				toolCallId: "call-1",
				toolCallIndex: 0,
				toolName: "search_fulltext",
			}),
		]);
	});

	it("does not synthesize an empty AI message when only tool calls were started before abort", async () => {
		const input = mergeState(null, "search foo");

		const result = await runAgentStream({
			agent: createAgent([
				["messages", [{
					_getType: () => "ai",
					content: "",
					tool_call_chunks: [{ name: "search_fulltext", id: "call-1" }],
				}, {}]],
				createAbortError(),
			]),
			input,
		});

		expect(result.aborted).toBe(true);
		expect(result.lastState.messages).toHaveLength(1);
		expect(getContents(result.lastState.messages || [])).toEqual(["search foo"]);
	});

	it("keeps one ui AI message when the same turn continues streaming after tool start", async () => {
		const input = mergeState(null, "search foo");

		const result = await runAgentStream({
			agent: createAgent([
				["messages", [{
					_getType: () => "ai",
					content: "我来看看",
					tool_call_chunks: [{ name: "search_fulltext", id: "call-1", args: { query: "foo" } }],
				}, {}]],
				["custom", JSON.stringify({
					__tool_type: "activity",
					toolCallId: "call-1",
					category: "lookup",
					action: "search",
					label: "foo",
				})],
				["messages", [{
					_getType: () => "ai",
					content: "，先整理结果",
				}, {}]],
				createAbortError(),
			]),
			input,
		});

		expect(result.aborted).toBe(true);
		expect(getUiAiContents(result.lastState.messagesUi || [])).toEqual(["我来看看，先整理结果"]);
		expect((result.lastState.messagesUi || []).filter((message) => isToolMessageUi(message))).toHaveLength(1);
	});

	it("starts a new ui AI message after a tool result closes the prior turn", async () => {
		const input = mergeState(null, "search foo");

		const result = await runAgentStream({
			agent: createAgent([
				["messages", [{
					_getType: () => "ai",
					content: "我来看看",
					tool_call_chunks: [{ name: "search_fulltext", id: "call-1", args: { query: "foo" } }],
				}, {}]],
				["messages", [{
					_getType: () => "tool",
					content: "42",
					tool_call_id: "call-1",
				}, {}]],
				["messages", [{
					_getType: () => "ai",
					content: "结果是 42",
				}, {}]],
				createAbortError(),
			]),
			input,
		});

		expect(result.aborted).toBe(true);
		expect(getUiAiContents(result.lastState.messagesUi || [])).toEqual(["我来看看", "结果是 42"]);
	});
});
