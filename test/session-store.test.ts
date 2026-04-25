import { describe, expect, it } from "vitest";
import type { ScheduledTaskMeta } from "../src/types";
import {
	INDEX_STORAGE,
	LEGACY_CHAT_HISTORY_STORAGE,
	SESSION_PREFIX,
	SessionStore,
	type PluginStorage,
} from "../src/core/session-store";
import { ScheduledTaskManager } from "../src/core/scheduled-task-manager";

type FakeStorage = PluginStorage & {
	data: Record<string, any>;
	loads: Record<string, number>;
	saves: Record<string, number>;
	removes: Record<string, number>;
	resetCounts(): void;
	seed(name: string, content: any): void;
};

function cloneData<T>(value: T): T {
	return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function createFakeStorage(): FakeStorage {
	const data: Record<string, any> = {};
	const loads: Record<string, number> = {};
	const saves: Record<string, number> = {};
	const removes: Record<string, number> = {};
	return {
		data,
		loads,
		saves,
		removes,
		resetCounts(): void {
			for (const key of Object.keys(loads)) delete loads[key];
			for (const key of Object.keys(saves)) delete saves[key];
			for (const key of Object.keys(removes)) delete removes[key];
		},
		seed(name: string, content: any): void {
			data[name] = cloneData(content);
		},
		async save(name: string, content: any): Promise<void> {
			saves[name] = (saves[name] || 0) + 1;
			data[name] = cloneData(content);
		},
		async load(name: string): Promise<any> {
			loads[name] = (loads[name] || 0) + 1;
			return cloneData(data[name] ?? undefined);
		},
		async remove(name: string): Promise<void> {
			removes[name] = (removes[name] || 0) + 1;
			delete data[name];
		},
	};
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

function createChatSession(id = "chat-1") {
	const now = Date.now();
	return {
		id,
		title: "Chat",
		created: now,
		updated: now,
		kind: "chat" as const,
		group: "chat_history" as const,
		state: {},
	};
}

function seedSession(storage: FakeStorage, session: ReturnType<typeof createChatSession> | any): void {
	storage.seed(SESSION_PREFIX + session.id, session);
}

function seedIndex(storage: FakeStorage, sessions: any[], activeId = "chat-1"): void {
	storage.seed(INDEX_STORAGE, {
		activeId,
		sessions: sessions.map((session) => ({
			id: session.id,
			title: session.title,
			created: session.created,
			updated: session.updated,
			kind: session.kind,
			group: session.group,
			task: session.task,
		})),
	});
}

describe("SessionStore", () => {
	it("keeps chat and scheduled task sessions in the same index with separate kinds", async () => {
		const store = new SessionStore(createFakeStorage());

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
		const store = new SessionStore(createFakeStorage());

		await store.ensureLoaded();
		const activeChatId = store.getIndex().activeId;
		await store.createScheduledTaskSession(createTask());
		await store.deleteSession("task-1");

		expect(store.getIndex().activeId).toBe(activeChatId);
		expect(store.listSessions("scheduled_task")).toHaveLength(0);
		expect(store.listSessions("chat")).toHaveLength(1);
	});

	it("clears persisted session files, index, and legacy chat history on uninstall cleanup", async () => {
		const storage = createFakeStorage();
		const store = new SessionStore(storage);

		await store.ensureLoaded();
		const chatSessionId = store.getIndex().activeId;
		await store.createScheduledTaskSession(createTask());
		await storage.save(LEGACY_CHAT_HISTORY_STORAGE, {
			activeId: "legacy-chat",
			sessions: [{ id: "legacy-chat", title: "Legacy", messages: [] }],
		});

		await store.clearPersistedData();

		expect(await storage.load(INDEX_STORAGE)).toBeUndefined();
		expect(await storage.load(SESSION_PREFIX + chatSessionId)).toBeUndefined();
		expect(await storage.load(SESSION_PREFIX + "task-1")).toBeUndefined();
		expect(await storage.load(LEGACY_CHAT_HISTORY_STORAGE)).toBeUndefined();
	});

	it("caches loaded sessions after the first storage read", async () => {
		const storage = createFakeStorage();
		const session = createChatSession();
		seedIndex(storage, [session], session.id);
		seedSession(storage, session);
		const store = new SessionStore(storage);

		await store.ensureLoaded();
		storage.resetCounts();
		const first = await store.loadSession(session.id);
		first.state.messages = [{ role: "human", content: "mutated outside cache" }];
		const second = await store.loadSession(session.id);

		expect(storage.loads[SESSION_PREFIX + session.id]).toBe(1);
		expect(second.state.messages).toBeUndefined();
	});

	it("coalesces concurrent loads for the same session", async () => {
		const storage = createFakeStorage();
		const session = createChatSession();
		seedIndex(storage, [session], session.id);
		seedSession(storage, session);
		const store = new SessionStore(storage);

		await store.ensureLoaded();
		storage.resetCounts();
		await Promise.all([
			store.loadSession(session.id),
			store.loadSession(session.id),
			store.loadSession(session.id),
		]);

		expect(storage.loads[SESSION_PREFIX + session.id]).toBe(1);
	});

	it("serves saved sessions from cache without another storage read", async () => {
		const storage = createFakeStorage();
		const session = createChatSession();
		seedIndex(storage, [session], session.id);
		seedSession(storage, session);
		const store = new SessionStore(storage);

		await store.ensureLoaded();
		const loaded = await store.loadSession(session.id);
		loaded.title = "Updated";
		loaded.state.messages = [{ role: "human", content: "hello" }];
		await store.saveSession(loaded);
		storage.resetCounts();
		const reloaded = await store.loadSession(session.id);

		expect(storage.loads[SESSION_PREFIX + session.id]).toBeUndefined();
		expect(reloaded.title).toBe("Updated");
		expect(reloaded.state.messages).toHaveLength(1);
	});

	it("clears deleted and uninstall caches", async () => {
		const storage = createFakeStorage();
		const session = createChatSession();
		seedIndex(storage, [session], session.id);
		seedSession(storage, session);
		const store = new SessionStore(storage);

		await store.ensureLoaded();
		await store.loadSession(session.id);
		await store.deleteSession(session.id);
		const restored = { ...session, title: "Restored" };
		seedSession(storage, restored);
		await store.saveSessionIndexEntry({
			id: restored.id,
			title: restored.title,
			created: restored.created,
			updated: restored.updated,
			kind: restored.kind,
			group: restored.group,
		}, { notify: false });
		storage.resetCounts();
		expect((await store.loadSession(restored.id)).title).toBe("Restored");
		expect(storage.loads[SESSION_PREFIX + restored.id]).toBe(1);

		await store.clearPersistedData();
		seedIndex(storage, [restored], restored.id);
		seedSession(storage, restored);
		storage.resetCounts();
		expect((await store.loadSession(restored.id)).title).toBe("Restored");
		expect(storage.loads[INDEX_STORAGE]).toBe(1);
		expect(storage.loads[SESSION_PREFIX + restored.id]).toBe(1);
	});

	it("lets scheduled task scans use index metadata without loading task session files", async () => {
		const storage = createFakeStorage();
		const chat = createChatSession();
		const task = createTask();
		const taskSession = {
			id: task.id,
			title: task.title,
			created: task.createdAt,
			updated: task.updatedAt,
			kind: "scheduled_task" as const,
			group: "scheduled_tasks" as const,
			task,
			state: {},
		};
		seedIndex(storage, [chat, taskSession], chat.id);
		seedSession(storage, chat);
		seedSession(storage, taskSession);
		const store = new SessionStore(storage);
		const manager = new ScheduledTaskManager({
			store,
			getConfig: () => ({ apiKey: "" } as any),
			getTools: () => [],
		});

		await store.ensureLoaded();
		storage.resetCounts();
		await (manager as any).processDueTasks();
		expect(storage.loads[SESSION_PREFIX + task.id]).toBeUndefined();

		await manager.getTaskSession(task.id);
		await manager.getTaskSession(task.id);
		expect(storage.loads[SESSION_PREFIX + task.id]).toBe(1);
	});

	it("reconciles scheduled task index metadata without loading full task sessions", async () => {
		const storage = createFakeStorage();
		const chat = createChatSession();
		const task = {
			...createTask(),
			nextRunAt: undefined,
		};
		const taskSession = {
			id: task.id,
			title: task.title,
			created: task.createdAt,
			updated: task.updatedAt,
			kind: "scheduled_task" as const,
			group: "scheduled_tasks" as const,
			task,
			state: { messages: [{ role: "human", content: "history" }] },
		};
		seedIndex(storage, [chat, taskSession], chat.id);
		seedSession(storage, chat);
		seedSession(storage, taskSession);
		const store = new SessionStore(storage);
		const manager = new ScheduledTaskManager({
			store,
			getConfig: () => ({ apiKey: "" } as any),
			getTools: () => [],
		});

		await store.ensureLoaded();
		storage.resetCounts();
		await (manager as any).reconcileTaskSessions();

		expect(storage.loads[SESSION_PREFIX + task.id]).toBeUndefined();
		expect(storage.saves[INDEX_STORAGE]).toBe(1);
		expect(store.getSessionSummary(task.id)?.task?.nextRunAt).toBeTypeOf("number");
		expect(storage.data[SESSION_PREFIX + task.id].state.messages).toHaveLength(1);
	});
});
