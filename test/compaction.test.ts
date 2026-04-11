import { describe, expect, it, vi } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { compactMessages, shouldCompact } from "../src/core/compaction";
import type { AgentState } from "../src/types";

vi.mock("siyuan", () => ({
	fetchPost: vi.fn(),
	openTab: vi.fn(),
}));

function humanMsg(text: string) {
	return new HumanMessage(text);
}
function aiMsg(text: string) {
	return new AIMessage(text);
}

function buildState(turnCount: number): AgentState {
	const messages: any[] = [];
	for (let i = 0; i < turnCount; i++) {
		messages.push(humanMsg(`Question ${i + 1}`));
		messages.push(aiMsg(`Answer ${i + 1}`));
	}
	return { messages };
}

describe("shouldCompact", () => {
	it("returns false for empty messages", () => {
		expect(shouldCompact({ messages: [] })).toBe(false);
	});

	it("returns false for state without messages", () => {
		expect(shouldCompact({})).toBe(false);
	});

	it("returns false for few turns", () => {
		const state = buildState(3);
		expect(shouldCompact(state, 10, 100000)).toBe(false);
	});

	it("returns true when turn threshold exceeded", () => {
		const state = buildState(15);
		expect(shouldCompact(state, 10, 100000)).toBe(true);
	});

	it("returns true when char threshold exceeded", () => {
		const state: AgentState = {
			messages: [
				humanMsg("a".repeat(5000)),
				aiMsg("b".repeat(8000)),
			],
		};
		expect(shouldCompact(state, 100, 10000)).toBe(true);
	});

	it("respects custom thresholds", () => {
		const state = buildState(6);
		expect(shouldCompact(state, 5, 100000)).toBe(true);
		expect(shouldCompact(state, 10, 100000)).toBe(false);
	});
});

describe("compactMessages", () => {
	const mockModel = {
		invoke: vi.fn().mockResolvedValue({
			content: "Summary of the conversation.",
		}),
	} as any;

	it("returns null when not enough turns to compact", async () => {
		const state = buildState(3);
		const result = await compactMessages(state, { model: mockModel, keepRecentTurns: 4 });
		expect(result).toBeNull();
	});

	it("compacts messages and returns summary", async () => {
		const state = buildState(8);
		expect(state.messages!.length).toBe(16);

		const result = await compactMessages(state, { model: mockModel, keepRecentTurns: 3 });
		expect(result).toBe("Summary of the conversation.");
		// Should keep only 3 recent turns (6 messages)
		expect(state.messages!.length).toBe(6);
		expect(state.compaction).toBeDefined();
		expect(state.compaction!.summary).toBe("Summary of the conversation.");
		expect(state.compaction!.summarizedTurnCount).toBe(5);
		expect(state.compaction!.lastSource).toBe("manual");
		expect(state.compaction!.version).toBe(1);
	});

	it("accumulates summarizedTurnCount across compactions", async () => {
		const state = buildState(8);
		state.compaction = {
			summary: "Previous summary",
			summarizedTurnCount: 3,
			lastCompactedAt: Date.now() - 10000,
			lastSource: "auto",
			version: 1,
		};

		await compactMessages(state, { model: mockModel, keepRecentTurns: 3 });
		expect(state.compaction!.summarizedTurnCount).toBe(8); // 3 + 5 new
	});

	it("passes requirement to the model", async () => {
		const state = buildState(8);
		await compactMessages(state, {
			model: mockModel,
			keepRecentTurns: 3,
			requirement: "Focus on code-related decisions",
		});
		expect(state.compaction!.lastRequirement).toBe("Focus on code-related decisions");
		const callArg = mockModel.invoke.mock.calls[mockModel.invoke.mock.calls.length - 1][0][0].content;
		expect(callArg).toContain("Focus on code-related decisions");
	});
});
