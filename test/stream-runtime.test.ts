import { describe, expect, it, vi } from "vitest";
import { mergeState } from "../src/core/stream-runtime";

vi.mock("siyuan", () => ({
	fetchPost: vi.fn(),
	openTab: vi.fn(),
}));

vi.mock("ai", () => ({
	streamText: vi.fn().mockReturnValue({
		fullStream: (async function* () {})(),
		toolCalls: [],
		response: { messages: [] },
	}),
}));

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

	it("converts lc:1 format messages to simple format", () => {
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
			content: "old answer",
			reasoning: "thinking...",
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
		expect(result.messages[1]).toEqual({ role: "assistant", content: "answer" });
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

	it("preserves messagesUi from saved state", () => {
		const messagesUi = [{ role: "user", content: "prev" }];
		const state = { messages: [], messagesUi };
		const result = mergeState(state, "hello");
		expect(result.messagesUi).toEqual(messagesUi);
	});
});
