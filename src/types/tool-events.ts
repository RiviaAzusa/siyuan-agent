import type { AgentState, TodoList } from "./session";

/* ── Tool UI event types ─────────────────────────────────────────────── */

export interface ToolUIEventText {
	type: "text";
	text: string;
}

export type ToolActivityCategory = "lookup" | "change" | "other";

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

export interface ToolUIEventActivity {
	type: "activity";
	category: ToolActivityCategory;
	action: ToolActivityAction;
	id?: string;
	path?: string;
	label?: string;
	meta?: string;
	open?: boolean;
}

export interface ToolUIEventCreatedDocument {
	type: "created_document";
	id: string;
	path?: string;
}

export interface ToolUIEventDocumentLink {
	type: "document_link";
	id: string;
	path?: string;
	label?: string;
	open?: boolean;
}

export interface ToolUIEventDocumentBlocks {
	type: "document_blocks";
	id: string;
	path?: string;
	blockCount: number;
	open?: boolean;
}

export interface ToolUIEventAppendBlock {
	type: "append_block";
	parentID: string;
	path?: string;
	blockIDs: string[];
	open?: boolean;
}

export interface ToolUIEventEditBlocks {
	type: "edit_blocks";
	documentIDs: string[];
	primaryDocumentID?: string;
	path?: string;
	editedCount: number;
	open?: boolean;
}

export interface ToolUIEventUnknownStructured {
	type: "unknown_structured";
	raw: string;
	payload?: Record<string, any>;
}

export type ToolUIEventPayload =
	| ToolUIEventText
	| ToolUIEventActivity
	| ToolUIEventCreatedDocument
	| ToolUIEventDocumentLink
	| ToolUIEventDocumentBlocks
	| ToolUIEventAppendBlock
	| ToolUIEventEditBlocks
	| ToolUIEventUnknownStructured;

export interface ToolUIEvent {
	id: string;
	source: "writer";
	toolCallIndex: number;
	toolCallId?: string;
	toolName?: string;
	payload: ToolUIEventPayload;
}

export interface ChunkParserState {
	inputState: AgentState;
	currentState: AgentState | null;
	contentBuffer: string;
	reasoningBuffer: string;
	pendingMessages: any[];
	pendingToolCalls: any[];
	toolUIEvents: ToolUIEvent[];
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
		result: string;
	}
	| {
		type: "tool_ui";
		event: ToolUIEvent;
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

/* ── ToolMessageUi: replaces raw ToolMessage in the UI layer ─────────── */

export interface ToolMessageUi {
	type: "tool_message_ui";
	toolCallId: string;
	toolName: string;
	status: "running" | "done" | "error";
	summary?: string;
	events: ToolUIEvent[];
	startedAt: number;
	finishedAt?: number;
}

/**
 * A single element in `messagesUi`.
 *   - HumanMessage / AIMessage are kept as LangChain objects (serialised dict).
 *   - ToolMessage is *never* stored; ToolMessageUi takes its place.
 */
export type UiMessage = Record<string, any> | ToolMessageUi;

export function isToolMessageUi(m: UiMessage): m is ToolMessageUi {
	return (m as any).type === "tool_message_ui";
}
