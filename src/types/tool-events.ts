import type { AgentState, TodoList } from "./session";

export type ToolActivityAction =
	| "list"
	| "read"
	| "search"
	| "create"
	| "append"
	| "edit"
	| "move"
	| "rename"
	| "delete"
	| "other";

export interface ChunkParserState {
	inputState: AgentState;
	contentBuffer: string;
	reasoningBuffer: string;
	lastToolCallIndex: number;
	toolCallMap: Record<string, { index: number; name?: string }>;
	seenToolCallKeys: string[];
}

export type AgentStreamUiEvent =
	| {
		type: "text_delta";
		text: string;
	}
	| {
		type: "reasoning_delta";
		text: string;
	}
	| {
		type: "tool_call_start";
		toolName: string;
		toolCallIndex: number;
		toolCallId?: string;
		args?: unknown;
	}
	| {
		type: "tool_result";
		toolCallId?: string;
		toolName?: string;
		result: string;
	}
	| {
		type: "todos_update";
		todos: TodoList;
	};

export interface RunAgentStreamResult {
	lastState: AgentState;
	aborted: boolean;
	completed: boolean;
	error?: unknown;
}

export interface AgentRunMeta {
	userMessageIndex: number;
	startedAt: number;
	finishedAt?: number;
	durationMs?: number;
	status: "running" | "success" | "error" | "aborted";
}

/* ── Render-only message projections ───────────────────────────────── */

export interface ToolMessageUi {
	type: "tool_message_ui";
	toolCallId: string;
	toolName: string;
	status: "running" | "done" | "error";
	summary?: string;
	result?: string;
	activity?: {
		category: "lookup" | "change";
		action: ToolActivityAction;
		id?: string;
		path?: string;
		label?: string;
		meta?: string;
		open?: boolean;
	};
	startedAt: number;
	finishedAt?: number;
}

export interface ProcessingSummaryUi {
	type: "processing_summary_ui";
	status: "done" | "running" | "error";
	durationMs?: number;
	details: UiMessage[];
}

export interface RunChangeSummaryItemUi {
	action: ToolActivityAction;
	toolName: string;
	label: string;
	id?: string;
	path?: string;
	status: "ok" | "error";
	added?: number;
	removed?: number;
	meta?: string;
}

export interface RunChangeSummaryUi {
	type: "run_change_summary_ui";
	items: RunChangeSummaryItemUi[];
	total: number;
}

/**
 * A render-only message view element. This is derived from AgentState.messages
 * and must not be persisted as session state.
 */
export type UiMessage = Record<string, any> | ToolMessageUi | ProcessingSummaryUi | RunChangeSummaryUi;

export function isToolMessageUi(m: UiMessage): m is ToolMessageUi {
	return (m as any).type === "tool_message_ui";
}

export function isProcessingSummaryUi(m: UiMessage): m is ProcessingSummaryUi {
	return (m as any).type === "processing_summary_ui";
}

export function isRunChangeSummaryUi(m: UiMessage): m is RunChangeSummaryUi {
	return (m as any).type === "run_change_summary_ui";
}
