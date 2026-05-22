import { describe, expect, it, vi } from "vitest";
import { shouldCompact } from "../src/core/compaction";
import type { AgentState } from "../src/types";

vi.mock("siyuan", () => ({
	fetchPost: vi.fn(),
	openTab: vi.fn(),
}));

function humanMsg(text: string) {
	return { role: "user", content: text };
}
function aiMsg(text: string) {
	return { role: "assistant", content: text };
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
