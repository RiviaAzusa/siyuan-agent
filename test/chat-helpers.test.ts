import { describe, expect, it } from "vitest";
import { applyApprovedRiskLevelsToApprovals, getToolApprovalRiskLevel, sessionTitle, shouldSendComposerOnKeydown } from "../src/ui/chat-helpers";

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

describe("getToolApprovalRiskLevel", () => {
	it("classifies normal change tools separately from delete tools", () => {
		expect(getToolApprovalRiskLevel("edit_blocks")).toBe("change");
		expect(getToolApprovalRiskLevel("create_document")).toBe("change");
		expect(getToolApprovalRiskLevel("delete_document")).toBe("delete");
		expect(getToolApprovalRiskLevel("delete_scheduled_task")).toBe("delete");
		expect(getToolApprovalRiskLevel("get_document")).toBeUndefined();
	});
});

describe("applyApprovedRiskLevelsToApprovals", () => {
	it("approves only approvals in the selected risk level", () => {
		const result = applyApprovedRiskLevelsToApprovals([
			{ approvalId: "a", toolCallId: "call-a", toolName: "edit_blocks", status: "pending" },
			{ approvalId: "b", toolCallId: "call-b", toolName: "delete_document", status: "pending" },
		], ["change"]);

		expect(result.changed).toBe(true);
		expect(result.approvals).toEqual([
			{ approvalId: "a", toolCallId: "call-a", toolName: "edit_blocks", status: "approved" },
			{ approvalId: "b", toolCallId: "call-b", toolName: "delete_document", status: "pending" },
		]);
	});
});
