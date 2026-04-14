import type { Plugin } from "siyuan";
import type {
	ScheduledTaskMeta,
	SessionData,
	SessionGroup,
	SessionIndex,
	SessionIndexEntry,
	SessionKind,
} from "../types";

export const INDEX_STORAGE = "chat-sessions-index";
export const SESSION_PREFIX = "chat-session-";
export const LEGACY_CHAT_HISTORY_STORAGE = "chat-history";

/* ── persistence abstraction ────────────────────────────────────────────
 *  SiYuan's Plugin.saveData / loadData internally use `fetchPost`, which
 *  silently swallows the callback when `processMessage` returns false
 *  (response.code < 0). This leaves the returned Promise unresolved
 *  forever. We bypass fetchPost with native fetch to avoid the hang.
 * ──────────────────────────────────────────────────────────────────── */

export interface PluginStorage {
	save(name: string, data: any): Promise<void>;
	load(name: string): Promise<any>;
	remove(name: string): Promise<void>;
}

export function createPluginStorage(plugin: Plugin): PluginStorage {
	function storagePath(name: string): string {
		return `/data/storage/petal/${plugin.name}/${name.replace(/[/\\]+/g, "")}`;
	}

	return {
		async save(name: string, data: any): Promise<void> {
			const p = storagePath(name);
			const blob = typeof data === "object"
				? new Blob([JSON.stringify(data)], { type: "application/json" })
				: new Blob([data]);
			const file = new File([blob], p.split("/").pop()!);
			const fd = new FormData();
			fd.append("path", p);
			fd.append("file", file);
			fd.append("isDir", "false");
			const resp = await fetch("/api/file/putFile", { method: "POST", body: fd });
			const json = await resp.json();
			if (json.code !== 0) {
				throw new Error(json.msg || `putFile error code ${json.code}`);
			}
			plugin.data[name] = data;
		},

		async load(name: string): Promise<any> {
			const p = storagePath(name);
			const resp = await fetch("/api/file/getFile", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: p }),
			});
			if (resp.status === 202) {
				plugin.data[name] = "";
				return undefined;
			}
			const ct = resp.headers.get("content-type") || "";
			if (ct.includes("application/json")) {
				const data = await resp.json();
				plugin.data[name] = data;
				return data;
			}
			const text = await resp.text();
			plugin.data[name] = text;
			return text;
		},

		async remove(name: string): Promise<void> {
			const p = storagePath(name);
			const resp = await fetch("/api/file/removeFile", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: p }),
			});
			const json = await resp.json();
			if (json.code !== 0) {
				throw new Error(json.msg || `removeFile error code ${json.code}`);
			}
		},
	};
}

function genId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function cloneTaskMeta(task?: ScheduledTaskMeta): ScheduledTaskMeta | undefined {
	return task ? { ...task } : undefined;
}

function cloneSessionIndexEntry(entry: SessionIndexEntry): SessionIndexEntry {
	return {
		...entry,
		task: cloneTaskMeta(entry.task),
	};
}

function makeSessionIndexEntry(session: SessionData): SessionIndexEntry {
	return {
		id: session.id,
		title: session.title,
		created: session.created,
		updated: session.updated,
		kind: session.kind,
		group: session.group,
		task: cloneTaskMeta(session.task),
	};
}

function inferSessionKind(raw: any): SessionKind {
	return raw?.kind === "scheduled_task" ? "scheduled_task" : "chat";
}

function inferSessionGroup(kind: SessionKind, raw: any): SessionGroup {
	if (raw?.group === "scheduled_tasks") return "scheduled_tasks";
	if (raw?.group === "chat_history") return "chat_history";
	return kind === "scheduled_task" ? "scheduled_tasks" : "chat_history";
}

function normalizeTaskMeta(raw: any, fallback?: ScheduledTaskMeta): ScheduledTaskMeta | undefined {
	const source = raw && typeof raw === "object" ? raw : fallback;
	if (!source || typeof source !== "object") return undefined;
	const now = Date.now();
	const createdAt = Number(source.createdAt) || now;
	const updatedAt = Number(source.updatedAt) || createdAt;
	const scheduleType = source.scheduleType === "once" ? "once" : "recurring";
	const title = typeof source.title === "string" && source.title.trim() ? source.title.trim() : "未命名任务";
	const prompt = typeof source.prompt === "string" ? source.prompt : "";
	const timezone = typeof source.timezone === "string" && source.timezone.trim()
		? source.timezone
		: Intl.DateTimeFormat().resolvedOptions().timeZone;
	const lastRunStatus = source.lastRunStatus === "running"
		|| source.lastRunStatus === "success"
		|| source.lastRunStatus === "error"
		? source.lastRunStatus
		: "idle";

	return {
		id: typeof source.id === "string" && source.id.trim() ? source.id : genId(),
		title,
		prompt,
		scheduleType,
		cron: typeof source.cron === "string" && source.cron.trim() ? source.cron.trim() : undefined,
		triggerAt: Number.isFinite(source.triggerAt) ? Number(source.triggerAt) : undefined,
		timezone,
		enabled: source.enabled !== false,
		nextRunAt: Number.isFinite(source.nextRunAt) ? Number(source.nextRunAt) : undefined,
		lastRunAt: Number.isFinite(source.lastRunAt) ? Number(source.lastRunAt) : undefined,
		lastRunStatus,
		lastRunError: typeof source.lastRunError === "string" && source.lastRunError ? source.lastRunError : undefined,
		runCount: Number.isFinite(source.runCount) ? Number(source.runCount) : 0,
		createdAt,
		updatedAt,
	};
}

function normalizeSessionData(raw: any, fallbackId?: string, fallbackEntry?: SessionIndexEntry): SessionData {
	const now = Date.now();
	const kind = inferSessionKind({ ...fallbackEntry, ...raw });
	const group = inferSessionGroup(kind, { ...fallbackEntry, ...raw });
	const task = kind === "scheduled_task"
		? normalizeTaskMeta(raw?.task, fallbackEntry?.task)
		: undefined;
	const created = Number(raw?.created) || Number(fallbackEntry?.created) || now;
	const updated = Number(raw?.updated) || Number(fallbackEntry?.updated) || created;
	const title = typeof raw?.title === "string" && raw.title.trim()
		? raw.title.trim()
		: task?.title || fallbackEntry?.title || "New Chat";
	return {
		id: typeof raw?.id === "string" && raw.id.trim() ? raw.id : (fallbackId || genId()),
		title,
		created,
		updated,
		kind,
		group,
		task,
		state: raw?.state && typeof raw.state === "object" ? raw.state : {},
	};
}

function makeChatSessionData(): SessionData {
	const now = Date.now();
	return {
		id: genId(),
		title: "New Chat",
		created: now,
		updated: now,
		kind: "chat",
		group: "chat_history",
		state: {},
	};
}

export function makeScheduledTaskSessionData(task: ScheduledTaskMeta): SessionData {
	const now = Date.now();
	return {
		id: task.id,
		title: task.title,
		created: task.createdAt || now,
		updated: task.updatedAt || now,
		kind: "scheduled_task",
		group: "scheduled_tasks",
		task: cloneTaskMeta(task),
		state: {},
	};
}

export function isScheduledTaskSession(session: SessionData | SessionIndexEntry): boolean {
	return session.kind === "scheduled_task";
}

export class SessionStore {
	private readonly listeners = new Set<() => void>();
	private sessionIndex: SessionIndex = { activeId: "", sessions: [] };
	private loadPromise: Promise<void> | null = null;
	private loaded = false;

	constructor(private readonly storage: PluginStorage) {}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		if (!this.loadPromise) {
			this.loadPromise = this.loadInternal().finally(() => {
				this.loadPromise = null;
			});
		}
		await this.loadPromise;
	}

	getIndex(): SessionIndex {
		return {
			activeId: this.sessionIndex.activeId,
			sessions: this.sessionIndex.sessions.map(cloneSessionIndexEntry),
		};
	}

	listSessions(kind?: SessionKind): SessionIndexEntry[] {
		const sessions = this.sessionIndex.sessions.map(cloneSessionIndexEntry);
		return kind ? sessions.filter((session) => session.kind === kind) : sessions;
	}

	getSessionSummary(id: string): SessionIndexEntry | undefined {
		const entry = this.sessionIndex.sessions.find((session) => session.id === id);
		return entry ? cloneSessionIndexEntry(entry) : undefined;
	}

	async loadSession(id: string): Promise<SessionData> {
		await this.ensureLoaded();
		const key = SESSION_PREFIX + id;
		const raw = await this.storage.load(key);
		const fallbackEntry = this.sessionIndex.sessions.find((entry) => entry.id === id);
		if (!raw) {
			if (fallbackEntry) {
				const fallbackSession = normalizeSessionData({
					id,
					title: fallbackEntry.title,
					created: fallbackEntry.created,
					updated: fallbackEntry.updated,
					kind: fallbackEntry.kind,
					group: fallbackEntry.group,
					task: fallbackEntry.task,
					state: {},
				}, id, fallbackEntry);
				await this.saveSession(fallbackSession, { notify: false, persistActiveId: false });
				return fallbackSession;
			}
			const chatSession = makeChatSessionData();
			await this.saveSession(chatSession, { notify: false, persistActiveId: this.sessionIndex.activeId === "" });
			return chatSession;
		}
		return normalizeSessionData(raw, id, fallbackEntry);
	}

	async createChatSession(): Promise<SessionData> {
		await this.ensureLoaded();
		const session = makeChatSessionData();
		await this.saveSession(session, { persistActiveId: true });
		return session;
	}

	async createScheduledTaskSession(task: ScheduledTaskMeta): Promise<SessionData> {
		await this.ensureLoaded();
		const session = makeScheduledTaskSessionData(task);
		await this.saveSession(session, { persistActiveId: false });
		return session;
	}

	async saveSession(
		session: SessionData,
		options: { notify?: boolean; persistActiveId?: boolean } = {},
	): Promise<void> {
		await this.ensureLoaded();
		const normalized = normalizeSessionData(session, session.id);
		normalized.title = normalized.task?.title || normalized.title;
		normalized.updated = normalized.task?.updatedAt || normalized.updated;
		if (normalized.task) {
			normalized.task.updatedAt = normalized.updated;
		}
		const existingIndex = this.sessionIndex.sessions.findIndex((entry) => entry.id === normalized.id);
		const nextEntry = makeSessionIndexEntry(normalized);
		if (existingIndex >= 0) {
			this.sessionIndex.sessions[existingIndex] = nextEntry;
		} else {
			this.sessionIndex.sessions.push(nextEntry);
		}
		if (options.persistActiveId && normalized.kind === "chat") {
			this.sessionIndex.activeId = normalized.id;
		}
		await this.persistIndex();
		await this.storage.save(SESSION_PREFIX + normalized.id, normalized);
		if (options.notify !== false) {
			this.notify();
		}
	}

	async setActiveChatSession(id: string): Promise<void> {
		await this.ensureLoaded();
		const entry = this.sessionIndex.sessions.find((session) => session.id === id && session.kind === "chat");
		if (!entry) return;
		this.sessionIndex.activeId = id;
		await this.persistIndex();
		this.notify();
	}

	async deleteSession(id: string): Promise<void> {
		await this.ensureLoaded();
		const index = this.sessionIndex.sessions.findIndex((session) => session.id === id);
		if (index < 0) return;
		const [removed] = this.sessionIndex.sessions.splice(index, 1);
		await this.storage.remove(SESSION_PREFIX + id);
		if (removed.kind === "chat" && this.sessionIndex.activeId === id) {
			const chatSessions = this.sessionIndex.sessions.filter((session) => session.kind === "chat");
			if (chatSessions.length === 0) {
				const created = makeChatSessionData();
				this.sessionIndex.sessions.push(makeSessionIndexEntry(created));
				this.sessionIndex.activeId = created.id;
				await this.storage.save(SESSION_PREFIX + created.id, created);
			} else {
				const next = [...chatSessions].sort((a, b) => b.updated - a.updated)[0];
				this.sessionIndex.activeId = next.id;
			}
		}
		await this.persistIndex();
		this.notify();
	}

	async clearPersistedData(): Promise<void> {
		const rawIndex = await this.storage.load(INDEX_STORAGE);
		const sessionIds = rawIndex && Array.isArray(rawIndex.sessions)
			? rawIndex.sessions
				.map((entry: any) => (typeof entry?.id === "string" ? entry.id.trim() : ""))
				.filter((id: string) => Boolean(id))
			: [];

		for (const id of sessionIds) {
			await this.removeIfPresent(SESSION_PREFIX + id);
		}
		await this.removeIfPresent(INDEX_STORAGE);
		await this.removeIfPresent(LEGACY_CHAT_HISTORY_STORAGE);

		this.sessionIndex = { activeId: "", sessions: [] };
		this.loaded = false;
		this.loadPromise = null;
	}

	private async loadInternal(): Promise<void> {
		const rawIndex = await this.storage.load(INDEX_STORAGE);
		if (rawIndex && Array.isArray(rawIndex.sessions)) {
			this.sessionIndex = {
				activeId: typeof rawIndex.activeId === "string" ? rawIndex.activeId : "",
				sessions: rawIndex.sessions.map((entry: any) => {
					const kind = inferSessionKind(entry);
					const group = inferSessionGroup(kind, entry);
					return {
						id: typeof entry?.id === "string" && entry.id.trim() ? entry.id : genId(),
						title: typeof entry?.title === "string" && entry.title.trim() ? entry.title.trim() : "New Chat",
						created: Number(entry?.created) || Date.now(),
						updated: Number(entry?.updated) || Number(entry?.created) || Date.now(),
						kind,
						group,
						task: kind === "scheduled_task" ? normalizeTaskMeta(entry?.task) : undefined,
					};
				}),
			};
		} else {
			await this.migrateLegacyStore();
		}
		await this.ensureChatSeed();
		await this.persistIndex();
		this.loaded = true;
		this.notify();
	}

	private async migrateLegacyStore(): Promise<void> {
		const legacy = await this.storage.load(LEGACY_CHAT_HISTORY_STORAGE);
		if (legacy && Array.isArray(legacy.sessions) && legacy.sessions.length > 0) {
			const entries: SessionIndexEntry[] = [];
			for (const rawSession of legacy.sessions) {
				const session = normalizeSessionData({
					id: rawSession.id,
					title: rawSession.title || "New Chat",
					created: rawSession.created || Date.now(),
					updated: rawSession.updated || Date.now(),
					kind: "chat",
					group: "chat_history",
					state: {
						messages: (rawSession.messages || []).map((message: any) => ({
							role: message.role === "user" ? "human" : message.role,
							content: message.content,
						})),
					},
				});
				entries.push(makeSessionIndexEntry(session));
				await this.storage.save(SESSION_PREFIX + session.id, session);
			}
			this.sessionIndex = {
				activeId: typeof legacy.activeId === "string" ? legacy.activeId : entries[0].id,
				sessions: entries,
			};
			return;
		}
		const session = makeChatSessionData();
		this.sessionIndex = {
			activeId: session.id,
			sessions: [makeSessionIndexEntry(session)],
		};
		await this.storage.save(SESSION_PREFIX + session.id, session);
	}

	private async ensureChatSeed(): Promise<void> {
		const chatSessions = this.sessionIndex.sessions.filter((session) => session.kind === "chat");
		if (chatSessions.length === 0) {
			const session = makeChatSessionData();
			this.sessionIndex.sessions.push(makeSessionIndexEntry(session));
			this.sessionIndex.activeId = session.id;
			await this.storage.save(SESSION_PREFIX + session.id, session);
			return;
		}
		const hasActiveChat = chatSessions.some((session) => session.id === this.sessionIndex.activeId);
		if (!hasActiveChat) {
			const next = [...chatSessions].sort((a, b) => b.updated - a.updated)[0];
			this.sessionIndex.activeId = next.id;
		}
	}

	private async persistIndex(): Promise<void> {
		await this.storage.save(INDEX_STORAGE, this.sessionIndex);
	}

	private async removeIfPresent(name: string): Promise<void> {
		const existing = await this.storage.load(name);
		if (existing === undefined) return;
		await this.storage.remove(name);
	}
}
