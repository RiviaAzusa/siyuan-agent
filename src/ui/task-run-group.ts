import type { ToolUIEvent, UiMessage } from "../types";
import { isToolMessageUi } from "../types";
import { buildMessagesView } from "../core/ui-message-builder";

/**
 * Represents a single execution run within a scheduled task session.
 * Messages are split by human messages starting with the scheduled task prefix.
 */
export interface TaskRunGroup {
	/** Index of the first message in this run group (within the full messages array) */
	startIndex: number;
	/** Index of the last message in this run group (inclusive) */
	endIndex: number;
	/** Execution timestamp extracted from the prompt prefix */
	runAt?: string;
	/** Task title extracted from the prompt */
	taskTitle?: string;
	/** Messages belonging to this run */
	messages: any[];
	/** ToolUIEvents associated with this run's tool call indices */
	toolUIEvents: ToolUIEvent[];
	/** UiMessages for this run (when available) */
	messagesUi: UiMessage[];
	/** Inferred run status based on message content */
	status: "success" | "error" | "unknown";
}

const SCHEDULED_PREFIXES = ["\u5b9a\u65f6\u4efb\u52a1\u6267\u884c\u65f6\u95f4\uff1a", "Scheduled task run time: "];
const TASK_TITLE_PREFIXES = ["\u4efb\u52a1\u540d\u79f0\uff1a", "Task name: "];
const ERROR_MARKERS = ["\u5b9a\u65f6\u4efb\u52a1\u6267\u884c\u5931\u8d25", "Scheduled task execution failed"];

function msgType(m: any): string {
	if (typeof m._getType === "function") return m._getType();
	if (m.lc === 1 && Array.isArray(m.id)) {
		const cls = m.id[m.id.length - 1] as string;
		if (cls === "HumanMessage") return "human";
		if (cls === "AIMessage" || cls === "AIMessageChunk") return "ai";
		if (cls === "SystemMessage") return "system";
		if (cls === "ToolMessage") return "tool";
	}
	if (m.role === "user") return "human";
	if (m.role === "assistant") return "ai";
	if (m.role === "system") return "system";
	if (m.role === "tool") return "tool";
	return m.type ?? m.role ?? "";
}

function getContent(m: any): string {
	const content = m.kwargs?.content ?? m.content;
	return typeof content === "string" ? content : "";
}

function isScheduledRunStart(m: any): boolean {
	return (msgType(m) === "human" || msgType(m) === "user") &&
		SCHEDULED_PREFIXES.some((prefix) => getContent(m).startsWith(prefix));
}

function extractRunAt(content: string): string | undefined {
	const line = content.split("\n")[0];
	for (const prefix of SCHEDULED_PREFIXES) {
		if (line.startsWith(prefix)) {
			return line.slice(prefix.length).trim();
		}
	}
	return undefined;
}

function extractTaskTitle(content: string): string | undefined {
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		for (const prefix of TASK_TITLE_PREFIXES) {
			if (trimmed.startsWith(prefix)) {
				return trimmed.slice(prefix.length).trim();
			}
		}
	}
	return undefined;
}

function inferRunStatus(messages: any[]): "success" | "error" | "unknown" {
	for (const m of messages) {
		const content = getContent(m);
		if (ERROR_MARKERS.some((marker) => content.includes(marker))) return "error";
	}
	const hasAi = messages.some(m => {
		const t = msgType(m);
		return t === "ai";
	});
	return hasAi ? "success" : "unknown";
}

/**
 * Split a scheduled task session's messages into per-execution run groups.
 * 
 * Each run starts with a human message whose content begins with a scheduled task run prefix.
 * If no such messages are found (legacy data), all messages are returned as a single group.
 *
 * `messagesUi` is accepted only as a legacy read fallback. Each group builds a
 * fresh render projection from its canonical messages.
 */
export function groupTaskRuns(messages: any[], toolUIEvents: ToolUIEvent[], messagesUi?: UiMessage[]): TaskRunGroup[] {
	if (!messages || messages.length === 0) return [];

	// Find run boundaries
	const boundaries: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (isScheduledRunStart(messages[i])) {
			boundaries.push(i);
		}
	}

	/* Build messagesUi run boundaries in parallel */
	const uiBoundaries: number[] = [];
	const uiArr = Array.isArray(messagesUi) ? messagesUi : [];
	for (let i = 0; i < uiArr.length; i++) {
		const m = uiArr[i];
		if (!isToolMessageUi(m) && isScheduledRunStart(m)) {
			uiBoundaries.push(i);
		}
	}

	// No scheduled prefix found → legacy fallback as single group
	if (boundaries.length === 0) {
		return [{
			startIndex: 0,
			endIndex: messages.length - 1,
			messages,
			toolUIEvents,
			messagesUi: buildMessagesView({ messages, toolUIEvents, messagesUi: uiArr }),
			status: inferRunStatus(messages),
		}];
	}

	// Build tool call index → run mapping
	let globalToolCallIdx = -1;
	const toolCallRunMap = new Map<number, number>();
	for (let i = 0; i < messages.length; i++) {
		const runIdx = findRunBoundary(i, boundaries);
		const toolCalls = messages[i].kwargs?.tool_calls ?? messages[i].tool_calls ?? messages[i].toolCalls;
		if (Array.isArray(toolCalls)) {
			for (const _tc of toolCalls) {
				globalToolCallIdx++;
				toolCallRunMap.set(globalToolCallIdx, runIdx);
			}
		}
	}

	const groups: TaskRunGroup[] = [];
	for (let b = 0; b < boundaries.length; b++) {
		const start = boundaries[b];
		const end = b + 1 < boundaries.length ? boundaries[b + 1] - 1 : messages.length - 1;
		const runMessages = messages.slice(start, end + 1);
		const content = getContent(messages[start]);

		const runToolUIEvents = toolUIEvents.filter(ev => {
			const runIdx = toolCallRunMap.get(ev.toolCallIndex);
			return runIdx === start;
		});

		let runMessagesUi: UiMessage[] = [];
		if (uiBoundaries.length > 0) {
			const uiStart = uiBoundaries[b] ?? 0;
			const uiEnd = b + 1 < uiBoundaries.length ? uiBoundaries[b + 1] : uiArr.length;
			runMessagesUi = uiArr.slice(uiStart, uiEnd);
		}
		const viewMessages = buildMessagesView({
			messages: runMessages,
			toolUIEvents: runToolUIEvents,
			messagesUi: runMessagesUi,
		});

		groups.push({
			startIndex: start,
			endIndex: end,
			runAt: extractRunAt(content),
			taskTitle: extractTaskTitle(content),
			messages: runMessages,
			toolUIEvents: runToolUIEvents,
			messagesUi: viewMessages,
			status: inferRunStatus(runMessages),
		});
	}

	return groups;
}

function findRunBoundary(msgIndex: number, boundaries: number[]): number {
	let result = boundaries[0];
	for (const b of boundaries) {
		if (b <= msgIndex) result = b;
		else break;
	}
	return result;
}
