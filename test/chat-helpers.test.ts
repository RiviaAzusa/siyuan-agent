import { describe, expect, it } from "vitest";
import { sessionTitle, shouldSendComposerOnKeydown } from "../src/ui/chat-helpers";

describe("shouldSendComposerOnKeydown", () => {
	it("sends on plain Enter", () => {
		expect(shouldSendComposerOnKeydown({
			key: "Enter",
			shiftKey: false,
		})).toBe(true);
	});

	it("does not send on Shift+Enter", () => {
		expect(shouldSendComposerOnKeydown({
			key: "Enter",
			shiftKey: true,
		})).toBe(false);
	});

	it("does not send while IME composition is active", () => {
		expect(shouldSendComposerOnKeydown({
			key: "Enter",
			shiftKey: false,
			isComposing: true,
		})).toBe(false);
	});

	it("does not send for IME process key events", () => {
		expect(shouldSendComposerOnKeydown({
			key: "Enter",
			shiftKey: false,
			keyCode: 229,
		})).toBe(false);
	});
});

describe("sessionTitle", () => {
	it("uses the first canonical user message", () => {
		expect(sessionTitle({
			messages: [
				{ role: "user", content: "从1 数到100 测试." },
				{ role: "assistant", content: "ok" },
			],
		})).toBe("从1 数到100 测试.");
	});

	it("does not use assistant-only state as a title", () => {
		expect(sessionTitle({
			messages: [
				{ role: "assistant", content: "answer" },
			],
		})).toBe("New Chat");
	});
});
