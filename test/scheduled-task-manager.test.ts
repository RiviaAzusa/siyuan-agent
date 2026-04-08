import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { SessionIndexEntry } from "../src/types";
import {
	appendTaskRunState,
	buildScheduledTaskRunPrompt,
	calculateNextRunAt,
	sortScheduledTaskEntries,
} from "../src/core/scheduled-task-manager";

describe("scheduled task helpers", () => {
	it("calculates the next recurring run in the task timezone", () => {
		const nextRun = calculateNextRunAt({
			scheduleType: "recurring",
			cron: "0 18 * * *",
			timezone: "Asia/Shanghai",
		}, new Date("2026-04-08T09:00:00+08:00").getTime());

		expect(nextRun).toBe(new Date("2026-04-08T18:00:00+08:00").getTime());
	});

	it("returns undefined for expired one-time tasks", () => {
		expect(calculateNextRunAt({
			scheduleType: "once",
			triggerAt: new Date("2026-04-08T10:00:00+08:00").getTime(),
			timezone: "Asia/Shanghai",
		}, new Date("2026-04-08T11:00:00+08:00").getTime())).toBeUndefined();
	});

	it("sorts running tasks first, then enabled tasks by next run", () => {
		const entries: SessionIndexEntry[] = [
			{
				id: "task-3",
				title: "Later",
				created: 1,
				updated: 3,
				kind: "scheduled_task",
				group: "scheduled_tasks",
				task: { id: "task-3", title: "Later", prompt: "", scheduleType: "recurring", cron: "0 18 * * *", timezone: "Asia/Shanghai", enabled: true, nextRunAt: 300, lastRunStatus: "idle", runCount: 0, createdAt: 1, updatedAt: 3 },
			},
			{
				id: "task-1",
				title: "Running",
				created: 1,
				updated: 1,
				kind: "scheduled_task",
				group: "scheduled_tasks",
				task: { id: "task-1", title: "Running", prompt: "", scheduleType: "recurring", cron: "0 18 * * *", timezone: "Asia/Shanghai", enabled: true, nextRunAt: 400, lastRunStatus: "running", runCount: 0, createdAt: 1, updatedAt: 1 },
			},
			{
				id: "task-2",
				title: "Soon",
				created: 1,
				updated: 2,
				kind: "scheduled_task",
				group: "scheduled_tasks",
				task: { id: "task-2", title: "Soon", prompt: "", scheduleType: "recurring", cron: "0 18 * * *", timezone: "Asia/Shanghai", enabled: true, nextRunAt: 200, lastRunStatus: "idle", runCount: 0, createdAt: 1, updatedAt: 2 },
			},
		];

		expect(sortScheduledTaskEntries(entries).map((entry) => entry.id)).toEqual(["task-1", "task-2", "task-3"]);
	});

	it("appends each execution run as a new message batch", () => {
		const merged = appendTaskRunState(
			{ messages: [new HumanMessage({ content: "old" })], toolUIEvents: [{ id: "1" }] as any },
			{ messages: [new AIMessage({ content: "new" })], toolUIEvents: [{ id: "2" }] as any },
		);

		expect(merged.messages).toHaveLength(2);
		expect(merged.toolUIEvents).toHaveLength(2);
	});

	it("builds a readable scheduled task prompt prefix", () => {
		const prompt = buildScheduledTaskRunPrompt({
			id: "task-1",
			title: "Daily Summary",
			prompt: "总结今天",
			scheduleType: "recurring",
			cron: "0 18 * * *",
			timezone: "Asia/Shanghai",
			enabled: true,
			lastRunStatus: "idle",
			runCount: 0,
			createdAt: 1,
			updatedAt: 1,
		}, new Date("2026-04-08T18:00:00+08:00").getTime());

		expect(prompt).toContain("定时任务执行时间");
		expect(prompt).toContain("任务名称：Daily Summary");
		expect(prompt).toContain("总结今天");
	});
});
