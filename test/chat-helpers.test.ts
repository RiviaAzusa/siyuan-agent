import { describe, expect, it } from "vitest";
import { shouldSendComposerOnKeydown } from "../src/ui/chat-helpers";

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
