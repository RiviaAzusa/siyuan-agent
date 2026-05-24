import { describe, expect, it } from "vitest";
import { groupTaskRuns, type TaskRunGroup } from "../src/ui/task-run-group";

function makeLcMsg(role: "human" | "ai" | "tool", content: string, toolCalls?: any[]) {
	const classMap: Record<string, string> = {
		human: "HumanMessage",
		ai: "AIMessage",
		tool: "ToolMessage",
	};
	return {
		lc: 1,
		id: ["langchain_core", "messages", classMap[role]],
		kwargs: {
			content,
			...(toolCalls ? { tool_calls: toolCalls } : {}),
		},
	};
}

describe("groupTaskRuns", () => {
	it("splits multiple normal executions into separate groups", () => {
		const messages = [
			makeLcMsg("human", "定时任务执行时间：2026/4/8 18:00:00\n\n任务名称：日报\n\n以下是本次定时任务的用户指令，请直接执行：\n生成日报"),
			makeLcMsg("ai", "已为您生成日报。"),
			makeLcMsg("human", "定时任务执行时间：2026/4/9 18:00:00\n\n任务名称：日报\n\n以下是本次定时任务的用户指令，请直接执行：\n生成日报"),
			makeLcMsg("ai", "已为您生成日报。"),
			makeLcMsg("human", "定时任务执行时间：2026/4/10 18:00:00\n\n任务名称：日报\n\n以下是本次定时任务的用户指令，请直接执行：\n生成日报"),
			makeLcMsg("ai", "已为您生成日报。"),
		];

		const groups = groupTaskRuns(messages);
		expect(groups).toHaveLength(3);
		expect(groups[0].runAt).toBe("2026/4/8 18:00:00");
		expect(groups[0].taskTitle).toBe("日报");
		expect(groups[0].messages).toHaveLength(2);
		expect(groups[0].status).toBe("success");
		expect(groups[1].runAt).toBe("2026/4/9 18:00:00");
		expect(groups[1].messages).toHaveLength(2);
		expect(groups[2].runAt).toBe("2026/4/10 18:00:00");
		expect(groups[2].messages).toHaveLength(2);
	});

	it("correctly marks error runs", () => {
		const messages = [
			makeLcMsg("human", "定时任务执行时间：2026/4/8 18:00:00\n\n任务名称：测试任务\n\n以下是本次定时任务的用户指令，请直接执行：\n生成日报"),
			makeLcMsg("ai", "已为您生成日报。"),
			makeLcMsg("human", "定时任务执行时间：2026/4/9 18:00:00\n\n任务名称：测试任务\n\n以下是本次定时任务的用户指令，请直接执行：\n生成日报"),
			makeLcMsg("human", "定时任务执行失败\n\nAPI Key expired"),
		];

		const groups = groupTaskRuns(messages);
		expect(groups).toHaveLength(2);
		expect(groups[0].status).toBe("success");
		expect(groups[1].status).toBe("error");
	});

	it("falls back to single group for legacy data without prefix", () => {
		const messages = [
			makeLcMsg("human", "Hello, please do something"),
			makeLcMsg("ai", "Done!"),
			makeLcMsg("human", "Another message"),
			makeLcMsg("ai", "OK"),
		];

		const groups = groupTaskRuns(messages);
		expect(groups).toHaveLength(1);
		expect(groups[0].runAt).toBeUndefined();
		expect(groups[0].messages).toHaveLength(4);
		expect(groups[0].status).toBe("success");
	});

	it("returns empty array for empty messages", () => {
		expect(groupTaskRuns([])).toHaveLength(0);
		expect(groupTaskRuns(undefined as any)).toHaveLength(0);
	});

	it("handles a single run correctly", () => {
		const messages = [
			makeLcMsg("human", "定时任务执行时间：2026/4/8 09:00:00\n\n任务名称：早间摘要\n\n以下是本次定时任务的用户指令，请直接执行：\n总结笔记"),
			makeLcMsg("ai", "这是您的早间摘要", [{ name: "search_fulltext", id: "tc1" }]),
			makeLcMsg("tool", "搜索结果..."),
		];

		const groups = groupTaskRuns(messages);
		expect(groups).toHaveLength(1);
		expect(groups[0].runAt).toBe("2026/4/8 09:00:00");
		expect(groups[0].taskTitle).toBe("早间摘要");
		expect(groups[0].messages).toHaveLength(3);
		expect(groups[0].startIndex).toBe(0);
		expect(groups[0].endIndex).toBe(2);
	});

	it("builds visible history from simple-format scheduled task messages", () => {
		const messages = [
			{ role: "user", content: "Scheduled task run time: 2026/4/8 09:00:00\n\nTask name: Morning\n\nRun it" },
			{ role: "assistant", content: "Task result" },
		];

		const groups = groupTaskRuns(messages);
		expect(groups).toHaveLength(1);
		expect(groups[0].runAt).toBe("2026/4/8 09:00:00");
		expect(groups[0].taskTitle).toBe("Morning");
		expect(groups[0].viewMessages).toEqual(messages);
	});

	it("builds tool cards from each run's canonical messages", () => {
		const messages = [
			makeLcMsg("human", "定时任务执行时间：2026/4/8 18:00:00\n\n任务名称：任务A\n\n以下是本次定时任务的用户指令，请直接执行：\nA"),
			makeLcMsg("ai", "A result", [{ name: "search_fulltext", id: "tc1" }]),
			makeLcMsg("tool", "result A"),
			makeLcMsg("human", "定时任务执行时间：2026/4/9 18:00:00\n\n任务名称：任务B\n\n以下是本次定时任务的用户指令，请直接执行：\nB"),
			makeLcMsg("ai", "B result", [{ name: "get_document", id: "tc2" }]),
			makeLcMsg("tool", "result B"),
		];

		const groups = groupTaskRuns(messages);
		expect(groups).toHaveLength(2);
		expect(groups[0].viewMessages.some((m: any) => m.type === "processing_summary_ui")).toBe(true);
		expect(groups[1].viewMessages.some((m: any) => m.type === "processing_summary_ui")).toBe(true);
	});

	it("handles mixed success and failure across runs", () => {
		const messages = [
			makeLcMsg("human", "定时任务执行时间：2026/4/8 18:00:00\n\n任务名称：任务\n\n指令"),
			makeLcMsg("ai", "完成"),
			makeLcMsg("human", "定时任务执行时间：2026/4/9 18:00:00\n\n任务名称：任务\n\n指令"),
			makeLcMsg("human", "定时任务执行失败\n\nconnection refused"),
			makeLcMsg("human", "定时任务执行时间：2026/4/10 18:00:00\n\n任务名称：任务\n\n指令"),
			makeLcMsg("ai", "完成"),
		];

		const groups = groupTaskRuns(messages);
		expect(groups).toHaveLength(3);
		expect(groups[0].status).toBe("success");
		expect(groups[1].status).toBe("error");
		expect(groups[2].status).toBe("success");
	});
});
