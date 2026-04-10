import type {
	AgentState,
	ToolMessageUi,
	ToolUIEvent,
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
	return m?.type ?? m?.role ?? "";
}

function getMessageContent(m: any): string {
	const content = m?.kwargs?.content ?? m?.content;
	return typeof content === "string" ? content : "";
}

function getMessageToolCalls(m: any): any[] {
	const tc = m?.kwargs?.tool_calls ?? m?.tool_calls;
	return Array.isArray(tc) ? tc : [];
}

function getToolCallId(tc: any): string {
	const id = tc?.id ?? tc?.tool_call_id;
	return typeof id === "string" ? id : "";
}

/**
 * Unified builder that maintains `messagesUi` during both streaming and
 * history replay.  Every tool call produces exactly one ToolMessageUi,
 * even when the tool emits no writer events (fallback).
 *
 * Usage during streaming:
 *   1. `pushHuman(humanMsg)`
 *   2. `pushAiChunk(serialisedDict)` — call repeatedly; the builder
 *      accumulates content / tool_calls into the latest AIMessage.
 *   3. `onToolCallStart(toolName, toolCallId)` — creates a pending ToolMessageUi.
 *   4. `onToolUiEvent(event)` — routes the event to the matching ToolMessageUi.
 *   5. `onToolResult(toolCallId)` — finalises the ToolMessageUi.
 *   6. `finalise()` — generates fallback ToolMessageUi for any tool call that
 *      never received events, and returns the complete `UiMessage[]`.
 */
export class UiMessageBuilder {
	private messages: UiMessage[] = [];
	private pendingToolMessages = new Map<string, ToolMessageUi>();

	/** Seed from an existing persisted `messagesUi`. */
	static fromExisting(existing: UiMessage[]): UiMessageBuilder {
		const b = new UiMessageBuilder();
		b.messages = [...existing];
		return b;
	}

	/* ── Human ─────────────────────────────────────────────────────── */

	pushHuman(msg: Record<string, any>): void {
		this.messages.push(msg);
	}

	/* ── AI ─────────────────────────────────────────────────────────── */

	/**
	 * Push (or replace) an AI message dict.  During streaming this is
	 * called repeatedly with the incrementally-built serialised dict.
	 */
	pushOrUpdateAi(msg: Record<string, any>): void {
		const last = this.messages[this.messages.length - 1];
		if (last && !isToolMessageUi(last) && msgType(last) === "ai") {
			this.messages[this.messages.length - 1] = msg;
		} else {
			this.messages.push(msg);
		}
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
		}
	}

	onToolResult(toolCallId: string, error?: boolean): void {
		const tmu = this.pendingToolMessages.get(toolCallId);
		if (tmu) {
			tmu.status = error ? "error" : "done";
			tmu.finishedAt = Date.now();
			this.pendingToolMessages.delete(toolCallId);
		}
	}

	/* ── Finalise ──────────────────────────────────────────────────── */

	/**
	 * Walk the messages and ensure every AIMessage.tool_calls entry has
	 * a corresponding ToolMessageUi.  Any tool call without one gets a
	 * fallback entry injected right after the AI message.
	 */
	finalise(): UiMessage[] {
		/* Close any still-pending tool messages */
		for (const tmu of this.pendingToolMessages.values()) {
			tmu.status = "done";
			tmu.finishedAt = tmu.finishedAt || Date.now();
		}
		this.pendingToolMessages.clear();

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
 * Build a `messagesUi` array from legacy `state.messages` + `state.toolUIEvents`.
 * Good-enough for display; not pixel-perfect with old rendering.
 */
export function migrateToMessagesUi(
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
				builder.onToolCallStart(tc.name || "unknown", tcId);
				const events = eventsByToolCallId.get(tcId) || [];
				for (const ev of events) {
					builder.onToolUiEvent(ev);
				}
				builder.onToolResult(tcId);
			}
			continue;
		}

		/* type === "tool" — skip raw tool messages in UI */
	}

	return builder.finalise();
}

/**
 * Lazy-migrate a persisted `AgentState`: if `messagesUi` is absent but
 * `messages` exist, generate `messagesUi` from the legacy data.
 * Returns true if migration was performed.
 */
export function ensureMessagesUi(state: AgentState): boolean {
	if (Array.isArray(state.messagesUi) && state.messagesUi.length > 0) {
		return false;
	}
	if (!Array.isArray(state.messages) || state.messages.length === 0) {
		state.messagesUi = [];
		return false;
	}
	state.messagesUi = migrateToMessagesUi(
		state.messages,
		Array.isArray(state.toolUIEvents) ? state.toolUIEvents : [],
	);
	return true;
}
