/**
 * Pure helper functions and shared interfaces for chat-panel.
 * Extracted from chat-panel.ts for maintainability.
 */

import type { AgentState, UiMessage, ToolMessageUi } from "../types";
import { isToolMessageUi } from "../types";
import type { ModelServiceConfig, McpServerConfig } from "../types";
import { defaultTranslator, type Translator } from "../i18n";

/* ── Interfaces ──────────────────────────────────────────────────────── */

export interface AssistantMessageShell {
	el: HTMLElement;
	contentEl: HTMLElement;
	stackEl: HTMLElement;
}

export interface ActivityBlockRefs {
	el: HTMLElement;
	category: "lookup" | "change";
	currentEl: HTMLElement;
	archiveEl: HTMLDetailsElement;
	archiveListEl: HTMLElement;
}

export type SettingsSection = "general" | "model-services" | "default-models";

export interface ComposerKeyEvent {
	key: string;
	shiftKey: boolean;
	isComposing?: boolean;
	keyCode?: number;
}

export interface SettingsDraft {
	customInstructions: string;
	guideDoc: { id: string; title: string } | null;
	defaultNotebook: { id: string; name: string } | null;
	modelServices: ModelServiceConfig[];
	defaultModelId: string;
	subAgentModelId: string;
	mcpServers: McpServerConfig[];
	notebookOptions: Array<{ id: string; name: string }>;
}

/* ── Pure functions ──────────────────────────────────────────────────── */

export function shouldSendComposerOnKeydown(e: ComposerKeyEvent): boolean {
	if (e.key !== "Enter" || e.shiftKey) return false;
	if (e.isComposing || e.keyCode === 229) return false;
	return true;
}

/** Extract the role string from either a live BaseMessage or a serialised dict. */
export function msgType(m: any): string {
	// Live BaseMessage instance
	if (typeof m._getType === "function") return m._getType();
	// LangChain JS serialised format
	if (m.lc === 1 && Array.isArray(m.id)) {
		const cls = m.id[m.id.length - 1] as string;
		if (cls === "HumanMessage") return "human";
		if (cls === "AIMessage" || cls === "AIMessageChunk") return "ai";
		if (cls === "SystemMessage") return "system";
		if (cls === "ToolMessage") return "tool";
	}
	// New simple format
	if (m.role === "user") return "human";
	if (m.role === "assistant") return "ai";
	if (m.role === "system") return "system";
	if (m.role === "tool") return "tool";
	// Legacy plain-object
	return m.type ?? m.role ?? "";
}

export function sessionTitle(state: AgentState): string {
	const msgs = state?.messages || [];
	const first = msgs.find((m: any) => {
		const t = msgType(m);
		return t === "human" || t === "user";
	});
	if (!first) return "New Chat";
	const text = getMessageContent(first).replace(/^>.*\n\n/s, "").trim();
	return text.length > 30 ? text.slice(0, 30) + "..." : text;
}

export function cloneMessage(raw: Record<string, any>): Record<string, any> {
	const clone: Record<string, any> = { ...raw };
	if (raw.kwargs) clone.kwargs = { ...raw.kwargs };
	if (raw.toolCalls) clone.toolCalls = [...raw.toolCalls];
	return clone;
}

export function getMessageContent(raw: Record<string, any>): string {
	const content = raw.kwargs?.content ?? raw.content;
	if (Array.isArray(content)) {
		return content
			.filter((part: any) => part?.type === "text")
			.map((part: any) => typeof part.text === "string" ? part.text : "")
			.join("");
	}
	return typeof content === "string" ? content : "";
}

export function getMessageReasoning(raw: Record<string, any>): string {
	const content = raw.kwargs?.content ?? raw.content;
	if (Array.isArray(content)) {
		return content
			.filter((part: any) => part?.type === "reasoning")
			.map((part: any) => typeof part.text === "string" ? part.text : "")
			.join("");
	}
	const reasoning = raw.kwargs?.additional_kwargs?.reasoning_content
		?? raw.additional_kwargs?.reasoning_content
		?? raw.kwargs?.lc_kwargs?.additional_kwargs?.reasoning_content
		?? raw.lc_kwargs?.additional_kwargs?.reasoning_content
		?? raw.reasoning;
	return typeof reasoning === "string" ? reasoning : "";
}

export function getMessageToolCalls(raw: Record<string, any>): any[] {
	const content = raw.kwargs?.content ?? raw.content;
	if (Array.isArray(content)) {
		return content
			.filter((part: any) => part?.type === "tool-call")
			.map((part: any) => ({
				...part,
				id: part.toolCallId ?? part.id ?? "",
				name: part.toolName ?? part.name ?? "",
				args: part.input ?? part.args ?? {},
			}));
	}
	const toolCalls = raw.kwargs?.tool_calls ?? raw.tool_calls ?? raw.toolCalls;
	return Array.isArray(toolCalls) ? toolCalls : [];
}

export function getMessageToolCallId(raw: Record<string, any>): string {
	const content = raw.kwargs?.content ?? raw.content;
	if (Array.isArray(content)) {
		const part = content.find((p: any) => p?.toolCallId || p?.tool_call_id);
		const id = part?.toolCallId ?? part?.tool_call_id;
		return typeof id === "string" ? id : "";
	}
	const toolCallId = raw.kwargs?.tool_call_id ?? raw.tool_call_id ?? raw.toolCallId;
	return typeof toolCallId === "string" ? toolCallId : "";
}

export function getToolCallId(raw: Record<string, any>): string {
	const toolCallId = raw?.id ?? raw?.tool_call_id ?? raw?.toolCallId;
	return typeof toolCallId === "string" ? toolCallId : "";
}

export function setMessageContent(raw: Record<string, any>, content: string): void {
	if (raw.kwargs && "content" in raw.kwargs) {
		raw.kwargs.content = content;
	} else {
		raw.content = content;
	}
}

export function setMessageToolCalls(raw: Record<string, any>, toolCalls: any[]): void {
	if (raw.kwargs && ("tool_calls" in raw.kwargs || raw.lc === 1)) {
		raw.kwargs = raw.kwargs || {};
		raw.kwargs.tool_calls = toolCalls;
	} else if ("toolCalls" in raw) {
		raw.toolCalls = toolCalls;
	} else {
		raw.tool_calls = toolCalls;
	}
}

export function normalizeMessagesForDisplay(messages: any[]): any[] {
	const normalized: any[] = [];
	for (const raw of messages || []) {
		const type = msgType(raw);
		if (type !== "ai") {
			normalized.push(raw);
			continue;
		}

		const prev = normalized[normalized.length - 1];
		if (prev && msgType(prev) === "ai") {
			const merged = cloneMessage(prev);
			setMessageContent(merged, getMessageContent(prev) + getMessageContent(raw));
			setMessageToolCalls(merged, [...getMessageToolCalls(prev), ...getMessageToolCalls(raw)]);
			normalized[normalized.length - 1] = merged;
			continue;
		}

		normalized.push(cloneMessage(raw));
	}
	return normalized;
}

export function escapeHtml(text: string): string {
	const map: Record<string, string> = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#039;",
	};
	return text.replace(/[&<>"']/g, (m) => map[m] || m);
}

/* ── Tool display helpers ────────────────────────────────────────────── */

export function getToolCategory(toolName?: string): "lookup" | "change" {
	const changeTools = ["edit_blocks", "append_block", "create_document", "move_document", "rename_document", "delete_document", "toggle_todo", "create_scheduled_task", "update_scheduled_task", "delete_scheduled_task"];
	return changeTools.includes(toolName || "") ? "change" : "lookup";
}

export function getToolAction(toolName?: string): string {
	const map: Record<string, string> = {
		list_notebooks: "list",
		list_documents: "list",
		recent_documents: "list",
		get_document: "read",
		get_document_blocks: "read",
		get_document_outline: "read",
		read_block: "read",
		search_fulltext: "search",
		search_documents: "search",
		search_todos: "search",
		get_todo_stats: "search",
		explore_notes: "search",
		append_block: "append",
		edit_blocks: "edit",
		create_document: "create",
		move_document: "move",
		rename_document: "rename",
		delete_document: "delete",
		toggle_todo: "edit",
		create_scheduled_task: "create",
		list_scheduled_tasks: "list",
		update_scheduled_task: "edit",
		delete_scheduled_task: "delete",
	};
	return map[toolName || ""] || "other";
}

export function getToolDisplayTitle(toolName: string, i18n: Translator = defaultTranslator): string {
	return i18n.t(`chat.toolTitle.${toolName}`, undefined, toolName);
}

export function getActionLabel(action: string, i18n: Translator = defaultTranslator): string {
	return i18n.t(`chat.action.${action}`, undefined, action === "other" ? "" : action);
}
