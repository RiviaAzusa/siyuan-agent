import type {
	AgentState,
	ToolMessageUi,
	ToolUIEvent,
	ToolUIEventPayload,
	UiMessage,
} from "../types";
import { isToolMessageUi } from "../types";

function genId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function msgType(m: any): string {
	if (typeof m?._getType === "function") return m._getType();
	if (m?.lc === 1 && Array.isArray(m.id)) {
		const cls = m.id[m.id.length - 1] as string;
		if (cls === "HumanMessage") return "human";
		if (cls === "AIMessage" || cls === "AIMessageChunk") return "ai";
		if (cls === "SystemMessage") return "system";
		if (cls === "ToolMessage") return "tool";
	}
	if (m?.role === "user") return "human";
	if (m?.role === "assistant") return "ai";
	if (m?.role === "system") return "system";
	if (m?.role === "tool") return "tool";
	return m?.type ?? m?.role ?? "";
}

function getMessageContent(m: any): string {
	const content = m?.kwargs?.content ?? m?.content;
	if (Array.isArray(content)) {
		return content
			.filter((part: any) => part?.type === "text")
			.map((part: any) => typeof part.text === "string" ? part.text : "")
			.join("");
	}
	return typeof content === "string" ? content : "";
}

function getMessageToolCalls(m: any): any[] {
	const content = m?.kwargs?.content ?? m?.content;
	if (Array.isArray(content)) {
		return content
			.filter((part: any) => part?.type === "tool-call")
			.map((part: any) => ({
				id: part.toolCallId ?? part.id ?? "",
				toolCallId: part.toolCallId ?? part.id ?? "",
				name: part.toolName ?? part.name ?? "",
				toolName: part.toolName ?? part.name ?? "",
				args: part.input ?? part.args ?? {},
				input: part.input ?? part.args ?? {},
			}));
	}
	const tc = m?.kwargs?.tool_calls ?? m?.tool_calls ?? m?.toolCalls;
	return Array.isArray(tc) ? tc : [];
}

function getToolCallId(tc: any): string {
	const id = tc?.id ?? tc?.tool_call_id ?? tc?.toolCallId;
	return typeof id === "string" ? id : "";
}

function getToolCallName(tc: any): string {
	return tc?.name ?? tc?.toolName ?? "unknown";
}

function getToolResultParts(msg: any): any[] {
	const content = msg?.kwargs?.content ?? msg?.content;
	if (Array.isArray(content)) {
		return content.filter((part: any) => part?.type === "tool-result" || part?.type === "tool-error");
	}
	if (msg?.role === "tool" || msgType(msg) === "tool") {
		return [{
			type: "tool-result",
			toolCallId: msg.toolCallId ?? msg.tool_call_id ?? msg.kwargs?.tool_call_id ?? "",
			toolName: msg.toolName ?? msg.name ?? msg.kwargs?.name ?? "",
			output: msg.result ?? msg.content ?? msg.kwargs?.content ?? "",
		}];
	}
	return [];
}

function getToolResultText(part: any): string {
	const value = part?.output ?? part?.result ?? part?.error ?? "";
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && value.type === "text" && typeof value.value === "string") return value.value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function parseJsonValue(text: string): any {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function deriveToolActivityPayload(part: any, resultText: string): ToolUIEventPayload {
	const toolName = part.toolName || "";
	const input = part.input || {};
	const parsed = parseJsonValue(resultText);
	if (toolName === "list_notebooks" && Array.isArray(parsed)) {
		return { type: "activity", category: "lookup", action: "list", label: "笔记本", meta: `已列出 ${parsed.length} 个笔记本` };
	}
	if (toolName === "recent_documents") {
		const count = Array.isArray(parsed?.items) ? parsed.items.length : Array.isArray(parsed) ? parsed.length : undefined;
		return { type: "activity", category: "lookup", action: "list", label: "最近文档", meta: count === undefined ? undefined : `已浏览 ${count} 篇最近文档` };
	}
	if (toolName === "search_documents" || toolName === "search_fulltext") {
		const count = Array.isArray(parsed?.items) ? parsed.items.length : Array.isArray(parsed?.blocks) ? parsed.blocks.length : undefined;
		const label = typeof input.query === "string" ? input.query : "搜索";
		return { type: "activity", category: "lookup", action: "search", label, meta: count === undefined ? undefined : `命中 ${count} 条结果` };
	}
	if (toolName === "get_document" || toolName === "get_document_blocks" || toolName === "get_document_outline" || toolName === "read_block") {
		return { type: "activity", category: "lookup", action: "read", id: input.id, label: input.id || toolName };
	}
	return { type: "text", text: resultText };
}

function makeResultEvent(part: any, toolCallIndex: number): ToolUIEvent {
	const isError = part?.type === "tool-error" || part?.error !== undefined;
	const resultText = getToolResultText(part);
	return {
		id: genId(),
		source: "writer",
		toolCallIndex,
		toolCallId: part.toolCallId,
		toolName: part.toolName,
		payload: isError
			? { type: "text", text: `Error: ${resultText}` }
			: deriveToolActivityPayload(part, resultText),
	};
}

/**
 * Read-only projection builder for rendering message history.  It creates the
 * tool card view model from persisted `state.messages` and `toolUIEvents`;
 * callers must not write its output back into session state.
 */
export class UiMessageBuilder {
	private messages: UiMessage[] = [];
	private pendingToolMessages = new Map<string, ToolMessageUi>();
	private currentAiIndex: number | null = null;

	/** Seed from a legacy persisted `messagesUi` for read-only fallback. */
	static fromExisting(existing: UiMessage[]): UiMessageBuilder {
		const b = new UiMessageBuilder();
		b.messages = [...existing];
		return b;
	}

	/* ── Human ─────────────────────────────────────────────────────── */

	pushHuman(msg: Record<string, any>): void {
		this.currentAiIndex = null;
		this.messages.push(msg);
	}

	/* ── AI ─────────────────────────────────────────────────────────── */

	/**
	 * Push (or replace) an AI message dict.  During streaming this is
	 * called repeatedly with the incrementally-built serialised dict.
	 */
	pushOrUpdateAi(msg: Record<string, any>): void {
		if (this.currentAiIndex !== null) {
			const current = this.messages[this.currentAiIndex];
			if (current && !isToolMessageUi(current) && msgType(current) === "ai") {
				this.messages[this.currentAiIndex] = msg;
				return;
			}
			this.currentAiIndex = null;
		}

		const lastIndex = this.messages.length - 1;
		const last = this.messages[lastIndex];
		if (last && !isToolMessageUi(last) && msgType(last) === "ai") {
			this.messages[lastIndex] = msg;
			this.currentAiIndex = lastIndex;
			return;
		}

		this.messages.push(msg);
		this.currentAiIndex = this.messages.length - 1;
	}

	/* ── Tool lifecycle ────────────────────────────────────────────── */

	onToolCallStart(toolName: string, toolCallId: string): void {
		const tmu: ToolMessageUi = {
			type: "tool_message_ui",
			toolCallId,
			toolName,
			status: "running",
			events: [],
			startedAt: Date.now(),
		};
		this.pendingToolMessages.set(toolCallId, tmu);
		this.messages.push(tmu);
	}

	onToolUiEvent(event: ToolUIEvent): void {
		const id = event.toolCallId;
		if (!id) return;
		const tmu = this.pendingToolMessages.get(id);
		if (tmu) {
			tmu.events.push(event);
			return;
		}
		const existing = this.messages.find((m): m is ToolMessageUi =>
			isToolMessageUi(m) && m.toolCallId === id,
		);
		if (existing) {
			existing.events.push(event);
		}
	}

	onToolResult(toolCallId: string, error?: boolean, result?: string): void {
		const tmu = this.pendingToolMessages.get(toolCallId);
		if (tmu) {
			tmu.status = error ? "error" : "done";
			if (result !== undefined) tmu.result = result;
			tmu.finishedAt = Date.now();
			this.pendingToolMessages.delete(toolCallId);
		}
		this.currentAiIndex = null;
	}

	/* ── Finalise ──────────────────────────────────────────────────── */

	/**
	 * Walk the messages and ensure every AIMessage.tool_calls entry has
	 * a corresponding ToolMessageUi.  Any tool call without one gets a
	 * fallback entry injected right after the AI message.
	 */
	finalise(): UiMessage[] {
		/* Keep still-pending tool messages marked as running. */
		this.pendingToolMessages.clear();
		this.currentAiIndex = null;

		/* Ensure every AIMessage tool_call has a ToolMessageUi */
		const existing = new Set<string>();
		for (const m of this.messages) {
			if (isToolMessageUi(m)) {
				existing.add(m.toolCallId);
			}
		}

		const insertions: { afterIndex: number; tmu: ToolMessageUi }[] = [];
		for (let i = 0; i < this.messages.length; i++) {
			const m = this.messages[i];
			if (isToolMessageUi(m)) continue;
			if (msgType(m) !== "ai") continue;

			const toolCalls = getMessageToolCalls(m);
			for (const tc of toolCalls) {
				const tcId = getToolCallId(tc);
				if (!tcId || existing.has(tcId)) continue;
				existing.add(tcId);
				insertions.push({
					afterIndex: i,
					tmu: {
						type: "tool_message_ui",
						toolCallId: tcId,
						toolName: tc.name || "unknown",
						status: "done",
						events: [],
						startedAt: Date.now(),
						finishedAt: Date.now(),
					},
				});
			}
		}

		/* Insert in reverse so indices remain stable */
		for (let k = insertions.length - 1; k >= 0; k--) {
			const { afterIndex, tmu } = insertions[k];
			this.messages.splice(afterIndex + 1, 0, tmu);
		}

		return this.messages;
	}

	/** Return current snapshot (without finalise). */
	snapshot(): UiMessage[] {
		return [...this.messages];
	}
}

/* ── Migration helper ──────────────────────────────────────────────── */

/**
 * Build a render-only UiMessage array from `state.messages` + `toolUIEvents`.
 * This is a projection, not persisted state.
 */
export function buildMessagesViewFromParts(
	messages: any[],
	toolUIEvents: ToolUIEvent[],
): UiMessage[] {
	const builder = new UiMessageBuilder();
	const eventsByToolCallId = new Map<string, ToolUIEvent[]>();
	for (const ev of toolUIEvents || []) {
		if (!ev.toolCallId) continue;
		const arr = eventsByToolCallId.get(ev.toolCallId) || [];
		arr.push(ev);
		eventsByToolCallId.set(ev.toolCallId, arr);
	}

	for (const msg of messages || []) {
		const type = msgType(msg);
		if (type === "system") continue;

		if (type === "human" || type === "user") {
			builder.pushHuman(msg);
			continue;
		}

		if (type === "ai") {
			builder.pushOrUpdateAi(msg);
			const toolCalls = getMessageToolCalls(msg);
			for (const tc of toolCalls) {
				const tcId = getToolCallId(tc);
				if (!tcId) continue;
				builder.onToolCallStart(getToolCallName(tc), tcId);
				const events = eventsByToolCallId.get(tcId) || [];
				for (const ev of events) {
					builder.onToolUiEvent(ev);
				}
			}
			continue;
		}

		if (type === "tool") {
			for (const part of getToolResultParts(msg)) {
				const tcId = part.toolCallId;
				if (!tcId) continue;
				const mappedIndex = [...eventsByToolCallId.keys()].indexOf(tcId);
				const result = getToolResultText(part);
				builder.onToolUiEvent(makeResultEvent(part, mappedIndex));
				builder.onToolResult(tcId, part?.type === "tool-error" || part?.error !== undefined, result);
			}
			continue;
		}
	}

	return builder.finalise();
}

/**
 * Build render-only message history from an AgentState.
 *
 * Legacy `messagesUi` is used only when the canonical `messages` end with a
 * user turn that has no assistant response but the old UI layer has a matching
 * partial assistant after that same user. This preserves interrupted sessions
 * without letting `messagesUi` override canonical history.
 */
export function buildMessagesView(state: AgentState | undefined | null): UiMessage[] {
	const messages = Array.isArray(state?.messages) ? state!.messages : [];
	const toolUIEvents = Array.isArray(state?.toolUIEvents) ? state!.toolUIEvents : [];
	const view = buildMessagesViewFromParts(messages, toolUIEvents);
	const legacy = Array.isArray(state?.messagesUi) ? state!.messagesUi : [];
	if (!legacy.length || !messages.length) return view;

	const lastCanonical = messages[messages.length - 1];
	if (msgType(lastCanonical) !== "human" && msgType(lastCanonical) !== "user") return view;
	const canonicalContent = getMessageContent(lastCanonical);
	let legacyUserIdx = -1;
	for (let i = legacy.length - 1; i >= 0; i--) {
		const m = legacy[i];
		if (
			!isToolMessageUi(m) &&
			(msgType(m) === "human" || msgType(m) === "user") &&
			getMessageContent(m) === canonicalContent
		) {
			legacyUserIdx = i;
			break;
		}
	}
	if (legacyUserIdx < 0) return view;

	const legacyTail = legacy.slice(legacyUserIdx + 1);
	const hasLegacyAssistant = legacyTail.some((m) => !isToolMessageUi(m) && msgType(m) === "ai");
	if (!hasLegacyAssistant) return view;
	return [...view, ...legacyTail];
}

/** @deprecated Use buildMessagesView(state). New code must not persist messagesUi. */
export function migrateToMessagesUi(messages: any[], toolUIEvents: ToolUIEvent[]): UiMessage[] {
	return buildMessagesViewFromParts(messages, toolUIEvents);
}

/** @deprecated No-op compatibility shim. New code must not write messagesUi. */
export function ensureMessagesUi(_state: AgentState): boolean {
	return false;
}
