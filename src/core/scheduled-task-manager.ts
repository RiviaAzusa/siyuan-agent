import { showMessage } from "siyuan";
import { CronExpressionParser } from "cron-parser";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type {
	AgentConfig,
	AgentState,
	ScheduledTaskMeta,
	ScheduledTaskRunStatus,
	ScheduledTaskScheduleType,
	SessionData,
	SessionIndexEntry,
} from "../types";
import { makeAgent, makeTracer } from "./agent";
import { mergeState, runAgentStream } from "./stream-runtime";
import { SessionStore } from "./session-store";

const TASK_TICK_INTERVAL = 30_000;

export interface ScheduledTaskInput {
	title: string;
	prompt: string;
	scheduleType: ScheduledTaskScheduleType;
	cron?: string;
	triggerAt?: number;
	timezone?: string;
	enabled?: boolean;
}

export interface ScheduledTaskUpdateInput {
	title?: string;
	prompt?: string;
	scheduleType?: ScheduledTaskScheduleType;
	cron?: string;
	triggerAt?: number;
	timezone?: string;
	enabled?: boolean;
}

interface ScheduledTaskManagerOptions {
	store: SessionStore;
	getConfig: () => AgentConfig | Promise<AgentConfig>;
	getTools: () => StructuredToolInterface[];
}

function cloneTask(task: ScheduledTaskMeta): ScheduledTaskMeta {
	return { ...task };
}

function nowTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function normalizeTimestamp(value?: number): number | undefined {
	return Number.isFinite(value) ? Number(value) : undefined;
}

function normalizeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function assertTaskFields(task: Pick<ScheduledTaskMeta, "title" | "prompt" | "scheduleType" | "cron" | "triggerAt">): void {
	if (!task.title.trim()) {
		throw new Error("Task title is required.");
	}
	if (!task.prompt.trim()) {
		throw new Error("Task prompt is required.");
	}
	if (task.scheduleType === "once" && !normalizeTimestamp(task.triggerAt)) {
		throw new Error("One-time task requires triggerAt.");
	}
	if (task.scheduleType === "recurring" && !(task.cron || "").trim()) {
		throw new Error("Recurring task requires cron expression.");
	}
}

export function buildScheduledTaskRunPrompt(task: ScheduledTaskMeta, runAt: number): string {
	return [
		`定时任务执行时间：${new Date(runAt).toLocaleString()}`,
		`任务名称：${task.title}`,
		"以下是本次定时任务的用户指令，请直接执行：",
		task.prompt,
	].join("\n\n");
}

export function appendTaskRunState(existingState: AgentState | undefined, latestState: AgentState): AgentState {
	return {
		...existingState,
		messages: [
			...(Array.isArray(existingState?.messages) ? existingState!.messages : []),
			...(Array.isArray(latestState.messages) ? latestState.messages : []),
		],
		toolUIEvents: [
			...(Array.isArray(existingState?.toolUIEvents) ? existingState!.toolUIEvents : []),
			...(Array.isArray(latestState.toolUIEvents) ? latestState.toolUIEvents : []),
		],
	};
}

export function calculateNextRunAt(task: Pick<ScheduledTaskMeta, "scheduleType" | "cron" | "triggerAt" | "timezone">, fromTime = Date.now()): number | undefined {
	if (task.scheduleType === "once") {
		const triggerAt = normalizeTimestamp(task.triggerAt);
		return triggerAt && triggerAt > fromTime ? triggerAt : undefined;
	}
	if (!task.cron) {
		throw new Error("Recurring task requires cron expression");
	}
	const tz = task.timezone || nowTimeZone();
	const interval = CronExpressionParser.parse(task.cron, {
		currentDate: new Date(fromTime),
		tz,
	});
	return interval.next().toDate().getTime();
}

export function sortScheduledTaskEntries(entries: SessionIndexEntry[]): SessionIndexEntry[] {
	return [...entries].sort((a, b) => {
		const taskA = a.task;
		const taskB = b.task;
		const runningA = taskA?.lastRunStatus === "running" ? 1 : 0;
		const runningB = taskB?.lastRunStatus === "running" ? 1 : 0;
		if (runningA !== runningB) return runningB - runningA;
		const enabledA = taskA?.enabled ? 1 : 0;
		const enabledB = taskB?.enabled ? 1 : 0;
		if (enabledA !== enabledB) return enabledB - enabledA;
		const nextA = taskA?.nextRunAt ?? Number.MAX_SAFE_INTEGER;
		const nextB = taskB?.nextRunAt ?? Number.MAX_SAFE_INTEGER;
		if (enabledA && enabledB && nextA !== nextB) return nextA - nextB;
		return b.updated - a.updated;
	});
}

export class ScheduledTaskManager {
	private readonly listeners = new Set<() => void>();
	private readonly runningTaskIds = new Set<string>();
	private readonly queuedTaskIds = new Set<string>();
	private readonly pendingRuns: Array<{ taskId: string; reason: "manual" | "schedule" }> = [];
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private draining = false;
	private started = false;
	private visibilityHandler: (() => void) | null = null;

	constructor(private readonly options: ScheduledTaskManagerOptions) {}

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

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		await this.options.store.ensureLoaded();
		await this.reconcileTaskSessions();
		this.tickTimer = setInterval(() => {
			void this.processDueTasks();
		}, TASK_TICK_INTERVAL);
		this.visibilityHandler = () => {
			void this.processDueTasks();
		};
		window.addEventListener("focus", this.visibilityHandler);
		document.addEventListener("visibilitychange", this.visibilityHandler);
		await this.processDueTasks();
	}

	stop(): void {
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		if (this.visibilityHandler) {
			window.removeEventListener("focus", this.visibilityHandler);
			document.removeEventListener("visibilitychange", this.visibilityHandler);
			this.visibilityHandler = null;
		}
		this.started = false;
	}

	listTaskEntries(): SessionIndexEntry[] {
		return sortScheduledTaskEntries(this.options.store.listSessions("scheduled_task"));
	}

	async getTaskSession(taskId: string): Promise<SessionData | null> {
		const summary = this.options.store.getSessionSummary(taskId);
		if (!summary || summary.kind !== "scheduled_task") return null;
		return this.options.store.loadSession(taskId);
	}

	async createTask(input: ScheduledTaskInput): Promise<SessionData> {
		await this.options.store.ensureLoaded();
		const now = Date.now();
		const timezone = input.timezone?.trim() || nowTimeZone();
		const task: ScheduledTaskMeta = {
			id: this.createTaskId(),
			title: input.title.trim(),
			prompt: input.prompt.trim(),
			scheduleType: input.scheduleType,
			cron: input.scheduleType === "recurring" ? input.cron?.trim() : undefined,
			triggerAt: input.scheduleType === "once" ? normalizeTimestamp(input.triggerAt) : undefined,
			timezone,
			enabled: input.enabled !== false,
			nextRunAt: undefined,
			lastRunStatus: "idle",
			runCount: 0,
			createdAt: now,
			updatedAt: now,
		};
		assertTaskFields(task);
		task.nextRunAt = task.enabled ? calculateNextRunAt(task, now) : undefined;
		const session = await this.options.store.createScheduledTaskSession(task);
		this.notify();
		return session;
	}

	async updateTask(taskId: string, patch: ScheduledTaskUpdateInput): Promise<SessionData> {
		const session = await this.requireTaskSession(taskId);
		const currentTask = session.task!;
		const updatedAt = Date.now();
		const nextTask: ScheduledTaskMeta = {
			...currentTask,
			title: patch.title !== undefined ? patch.title.trim() : currentTask.title,
			prompt: patch.prompt !== undefined ? patch.prompt.trim() : currentTask.prompt,
			scheduleType: patch.scheduleType || currentTask.scheduleType,
			cron: patch.scheduleType === "once"
				? undefined
				: patch.cron !== undefined
					? patch.cron?.trim() || undefined
					: currentTask.cron,
			triggerAt: patch.scheduleType === "recurring"
				? undefined
				: patch.triggerAt !== undefined
					? normalizeTimestamp(patch.triggerAt)
					: currentTask.triggerAt,
			timezone: patch.timezone?.trim() || currentTask.timezone || nowTimeZone(),
			enabled: patch.enabled ?? currentTask.enabled,
			updatedAt,
		};
		assertTaskFields(nextTask);
		nextTask.nextRunAt = nextTask.enabled ? calculateNextRunAt(nextTask, updatedAt) : undefined;
		const nextSession: SessionData = {
			...session,
			title: nextTask.title,
			updated: updatedAt,
			task: nextTask,
		};
		await this.options.store.saveSession(nextSession);
		this.notify();
		return nextSession;
	}

	async deleteTask(taskId: string): Promise<void> {
		await this.requireTaskSession(taskId);
		this.runningTaskIds.delete(taskId);
		this.queuedTaskIds.delete(taskId);
		const nextQueue = this.pendingRuns.filter((item) => item.taskId !== taskId);
		this.pendingRuns.length = 0;
		this.pendingRuns.push(...nextQueue);
		await this.options.store.deleteSession(taskId);
		this.notify();
	}

	async setTaskEnabled(taskId: string, enabled: boolean): Promise<SessionData> {
		return this.updateTask(taskId, { enabled });
	}

	async runTaskNow(taskId: string): Promise<void> {
		await this.requireTaskSession(taskId);
		this.enqueueRun(taskId, "manual");
	}

	private createTaskId(): string {
		return `task-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	}

	private async requireTaskSession(taskId: string): Promise<SessionData> {
		const session = await this.getTaskSession(taskId);
		if (!session || !session.task) {
			throw new Error(`Scheduled task ${taskId} not found`);
		}
		return session;
	}

	private async reconcileTaskSessions(): Promise<void> {
		const taskEntries = this.options.store.listSessions("scheduled_task");
		for (const entry of taskEntries) {
			const session = await this.options.store.loadSession(entry.id);
			if (!session.task) continue;
			const normalizedTask = {
				...session.task,
				timezone: session.task.timezone || nowTimeZone(),
			};
			if (normalizedTask.enabled && !normalizedTask.nextRunAt) {
				normalizedTask.nextRunAt = calculateNextRunAt(normalizedTask, Date.now());
			}
			const nextSession: SessionData = {
				...session,
				title: normalizedTask.title,
				updated: normalizedTask.updatedAt,
				task: normalizedTask,
			};
			await this.options.store.saveSession(nextSession, { notify: false });
		}
	}

	private async processDueTasks(): Promise<void> {
		await this.options.store.ensureLoaded();
		const now = Date.now();
		const entries = this.options.store.listSessions("scheduled_task");
		for (const entry of entries) {
			const task = entry.task;
			if (!task || !task.enabled) continue;
			if (!task.nextRunAt || task.nextRunAt > now) continue;
			this.enqueueRun(entry.id, "schedule");
		}
	}

	private enqueueRun(taskId: string, reason: "manual" | "schedule"): void {
		if (this.runningTaskIds.has(taskId) || this.queuedTaskIds.has(taskId)) return;
		this.queuedTaskIds.add(taskId);
		this.pendingRuns.push({ taskId, reason });
		void this.drainQueue();
	}

	private async drainQueue(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.pendingRuns.length > 0) {
				const next = this.pendingRuns.shift();
				if (!next) continue;
				this.queuedTaskIds.delete(next.taskId);
				await this.executeTask(next.taskId, next.reason);
			}
		} finally {
			this.draining = false;
		}
	}

	private async executeTask(taskId: string, reason: "manual" | "schedule"): Promise<void> {
		if (this.runningTaskIds.has(taskId)) return;
		const session = await this.getTaskSession(taskId);
		if (!session?.task) return;
		this.runningTaskIds.add(taskId);
		const startedAt = Date.now();
		const task = cloneTask(session.task);
		task.lastRunStatus = "running";
		task.lastRunError = undefined;
		task.updatedAt = startedAt;
		const runningSession: SessionData = {
			...session,
			title: task.title,
			updated: startedAt,
			task,
		};
		await this.options.store.saveSession(runningSession);
		this.notify();

		let latestState: AgentState = {};
		let finalStatus: ScheduledTaskRunStatus = "success";
		let lastError: string | undefined;
		try {
			const config = await this.options.getConfig();
			if (!config.apiKey) {
				throw new Error("Please configure API Key in plugin settings first.");
			}
			const agent = await makeAgent(config, this.options.getTools());
			const tracer = makeTracer(config);
			const input = mergeState(null, buildScheduledTaskRunPrompt(task, startedAt));
			const result = await runAgentStream({
				agent,
				input,
				callbacks: tracer ? [tracer] : undefined,
			});
			latestState = result.lastState;
			if (result.error) {
				throw result.error;
			}
		} catch (error) {
			finalStatus = "error";
			lastError = normalizeError(error);
			latestState = appendTaskRunState(undefined, mergeState(null, `定时任务执行失败\n\n${lastError}`) as AgentState);
		}

		const finishedAt = Date.now();
		const finishedTask = cloneTask(task);
		finishedTask.lastRunAt = finishedAt;
		finishedTask.lastRunStatus = finalStatus;
		finishedTask.lastRunError = lastError;
		finishedTask.runCount += 1;
		finishedTask.updatedAt = finishedAt;
		if (finishedTask.scheduleType === "once") {
			finishedTask.nextRunAt = undefined;
			if (finalStatus === "success") {
				finishedTask.enabled = false;
			}
		} else if (finishedTask.enabled) {
			finishedTask.nextRunAt = calculateNextRunAt(finishedTask, finishedAt);
		}

		const finishedSession: SessionData = {
			...runningSession,
			title: finishedTask.title,
			updated: finishedAt,
			task: finishedTask,
			state: appendTaskRunState(runningSession.state, latestState),
		};
		await this.options.store.saveSession(finishedSession);
		this.runningTaskIds.delete(taskId);
		this.notify();
		const statusText = finalStatus === "success" ? "已完成" : `失败：${lastError}`;
		showMessage(`⏰ 定时任务「${finishedTask.title}」${reason === "manual" ? "手动执行" : "执行"}${statusText ? `，${statusText}` : ""}`);
	}
}
