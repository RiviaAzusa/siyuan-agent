import type { ToolUIEvent } from "../types";

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
	/** Inferred run status based on message content */
	status: "success" | "error" | "unknown";
}

const SCHEDULED_PREFIX = "定时任务执行时间：";
const TASK_TITLE_PREFIX = "任务名称：";
const ERROR_MARKER = "定时任务执行失败";

function msgType(m: any): string {
	if (typeof m._getType === "function") return m._getType();
	if (m.lc === 1 && Array.isArray(m.id)) {
		const cls = m.id[m.id.length - 1] as string;
		if (cls === "HumanMessage") return "human";
		if (cls === "AIMessage" || cls === "AIMessageChunk") return "ai";
		if (cls === "SystemMessage") return "system";
		if (cls === "ToolMessage") return "tool";
	}
	return m.type ?? m.role ?? "";
}

function getContent(m: any): string {
	const content = m.kwargs?.content ?? m.content;
	return typeof content === "string" ? content : "";
}

function isScheduledRunStart(m: any): boolean {
	return (msgType(m) === "human" || msgType(m) === "user") &&
		getContent(m).startsWith(SCHEDULED_PREFIX);
}

function extractRunAt(content: string): string | undefined {
	const line = content.split("\n")[0];
	if (line.startsWith(SCHEDULED_PREFIX)) {
		return line.slice(SCHEDULED_PREFIX.length).trim();
	}
	return undefined;
}

function extractTaskTitle(content: string): string | undefined {
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith(TASK_TITLE_PREFIX)) {
			return trimmed.slice(TASK_TITLE_PREFIX.length).trim();
		}
	}
	return undefined;
}

function inferRunStatus(messages: any[]): "success" | "error" | "unknown" {
	for (const m of messages) {
		const content = getContent(m);
		if (content.includes(ERROR_MARKER)) return "error";
	}
	const hasAi = messages.some(m => {
		const t = msgType(m);
		return t === "ai";
	});
	return hasAi ? "success" : "unknown";
}

function getToolCallIndices(messages: any[]): Set<number> {
	const indices = new Set<number>();
	let idx = -1;
	for (const m of messages) {
		const toolCalls = m.kwargs?.tool_calls ?? m.tool_calls;
		if (Array.isArray(toolCalls)) {
			for (const _tc of toolCalls) {
				idx++;
				indices.add(idx);
			}
		}
	}
	return indices;
}

/**
 * Split a scheduled task session's messages into per-execution run groups.
 * 
 * Each run starts with a human message whose content begins with "定时任务执行时间：".
 * If no such messages are found (legacy data), all messages are returned as a single group.
 */
export function groupTaskRuns(messages: any[], toolUIEvents: ToolUIEvent[]): TaskRunGroup[] {
	if (!messages || messages.length === 0) return [];

	// Find run boundaries
	const boundaries: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (isScheduledRunStart(messages[i])) {
			boundaries.push(i);
		}
	}

	// No scheduled prefix found → legacy fallback as single group
	if (boundaries.length === 0) {
		return [{
			startIndex: 0,
			endIndex: messages.length - 1,
			messages,
			toolUIEvents,
			status: inferRunStatus(messages),
		}];
	}

	// Build tool call index → run mapping
	// We need to count tool calls across all messages to match toolUIEvent indices
	let globalToolCallIdx = -1;
	const toolCallRunMap = new Map<number, number>();  // toolCallIndex → run boundary index
	for (let i = 0; i < messages.length; i++) {
		const runIdx = findRunBoundary(i, boundaries);
		const toolCalls = messages[i].kwargs?.tool_calls ?? messages[i].tool_calls;
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

		// Collect toolUIEvents for this run
		const runToolUIEvents = toolUIEvents.filter(ev => {
			const runIdx = toolCallRunMap.get(ev.toolCallIndex);
			return runIdx === start;
		});

		groups.push({
			startIndex: start,
			endIndex: end,
			runAt: extractRunAt(content),
			taskTitle: extractTaskTitle(content),
			messages: runMessages,
			toolUIEvents: runToolUIEvents,
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
