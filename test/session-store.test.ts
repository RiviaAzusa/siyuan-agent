import { describe, expect, it } from "vitest";
import type { ScheduledTaskMeta } from "../src/types";
import { SessionStore } from "../src/core/session-store";

class FakePlugin {
	data: Record<string, any> = {};

	async loadData(_storageName: string): Promise<void> {}

	async saveData(storageName: string, content: any): Promise<void> {
		this.data[storageName] = content;
	}

	async removeData(storageName: string): Promise<void> {
		delete this.data[storageName];
	}
}

function createTask(): ScheduledTaskMeta {
	const now = Date.now();
	return {
		id: "task-1",
		title: "Daily Summary",
		prompt: "总结今天的工作",
		scheduleType: "recurring",
		cron: "0 18 * * *",
		timezone: "Asia/Shanghai",
		enabled: true,
		nextRunAt: now + 60_000,
		lastRunStatus: "idle",
		runCount: 0,
		createdAt: now,
		updatedAt: now,
	};
}

describe("SessionStore", () => {
	it("keeps chat and scheduled task sessions in the same index with separate kinds", async () => {
		const plugin = new FakePlugin();
		const store = new SessionStore(plugin as any);

		await store.ensureLoaded();
		const chatSessions = store.listSessions("chat");
		expect(chatSessions).toHaveLength(1);
		expect(store.getIndex().activeId).toBe(chatSessions[0].id);

		await store.createScheduledTaskSession(createTask());

		expect(store.listSessions("chat")).toHaveLength(1);
		const taskSessions = store.listSessions("scheduled_task");
		expect(taskSessions).toHaveLength(1);
		expect(taskSessions[0].group).toBe("scheduled_tasks");
		expect(taskSessions[0].task?.title).toBe("Daily Summary");
	});

	it("deleting a scheduled task session does not disturb the active chat session", async () => {
		const plugin = new FakePlugin();
		const store = new SessionStore(plugin as any);

		await store.ensureLoaded();
		const activeChatId = store.getIndex().activeId;
		await store.createScheduledTaskSession(createTask());
		await store.deleteSession("task-1");

		expect(store.getIndex().activeId).toBe(activeChatId);
		expect(store.listSessions("scheduled_task")).toHaveLength(0);
		expect(store.listSessions("chat")).toHaveLength(1);
	});
});
