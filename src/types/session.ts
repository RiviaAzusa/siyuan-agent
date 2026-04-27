import type { ToolUIEvent, UiMessage } from "./tool-events";
import type { ReasoningEffort } from "./model-config";

/* ── TodoList (agent plan management) ────────────────────────────────── */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	content: string;
	status: TodoStatus;
}

export interface TodoList {
	goal: string;
	items: TodoItem[];
	updatedAt: number;
}

/* ── Compaction metadata ────────────────────────────────────────────── */

export interface CompactionState {
	summary: string;
	summarizedTurnCount: number;
	lastCompactedAt: number;
	lastSource: "auto" | "manual";
	lastRequirement?: string;
	version: 1;
}

/* ── Agent state ────────────────────────────────────────────────────── */

export type AgentState = Record<string, any> & {
	messages?: any[];
	messagesUi?: UiMessage[];
	compaction?: CompactionState;
	todos?: TodoList;
	/** @deprecated kept for lazy migration only */
	toolUIEvents?: ToolUIEvent[];
};

/* ── Session types ──────────────────────────────────────────────────── */

export type SessionKind = "chat" | "scheduled_task";
export type SessionGroup = "chat_history" | "scheduled_tasks";
export type ScheduledTaskScheduleType = "once" | "recurring";
export type ScheduledTaskRunStatus = "idle" | "running" | "success" | "error";

export interface ScheduledTaskMeta {
	id: string;
	title: string;
	prompt: string;
	scheduleType: ScheduledTaskScheduleType;
	cron?: string;
	triggerAt?: number;
	timezone: string;
	enabled: boolean;
	nextRunAt?: number;
	lastRunAt?: number;
	lastRunStatus: ScheduledTaskRunStatus;
	lastRunError?: string;
	runCount: number;
	createdAt: number;
	updatedAt: number;
}

export interface SessionIndexEntry {
	id: string;
	title: string;
	created: number;
	updated: number;
	kind: SessionKind;
	group: SessionGroup;
	task?: ScheduledTaskMeta;
}

/** Persisted format for a single session. */
export interface SessionData {
	id: string;
	title: string;
	created: number;
	updated: number;
	kind: SessionKind;
	group: SessionGroup;
	task?: ScheduledTaskMeta;
	state: AgentState;
	/** Per-conversation model override (model config ID) */
	modelId?: string;
	/** Per-conversation reasoning effort control for providers that support it. */
	reasoningEffort?: ReasoningEffort;
}

/** Lightweight session index without messages. */
export interface SessionIndex {
	activeId: string;
	sessions: SessionIndexEntry[];
}
