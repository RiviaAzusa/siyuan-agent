import type {
	AgentRunMeta,
	AgentState,
	ProcessingSummaryUi,
	RunChangeSummaryItemUi,
	RunChangeSummaryUi,
	ToolMessageUi,
	UiMessage,
} from "../types";
import { isProcessingSummaryUi, isRunChangeSummaryUi, isToolMessageUi } from "../types";

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

function getMessageReasoning(m: any): string {
	const content = m?.kwargs?.content ?? m?.content;
	if (Array.isArray(content)) {
		return content
			.filter((part: any) => part?.type === "reasoning")
			.map((part: any) => typeof part.text === "string" ? part.text : "")
			.join("");
	}
	const reasoning = m?.kwargs?.additional_kwargs?.reasoning_content
		?? m?.additional_kwargs?.reasoning_content
		?? m?.reasoning;
	return typeof reasoning === "string" ? reasoning : "";
}

function cloneMessage(raw: Record<string, any>): Record<string, any> {
	return JSON.parse(JSON.stringify(raw));
}

function cloneAiWithParts(raw: Record<string, any>, keep: (part: any) => boolean): Record<string, any> | null {
	const cloned = cloneMessage(raw);
	const content = cloned.kwargs?.content ?? cloned.content;
	if (Array.isArray(content)) {
		const next = content.filter(keep);
		if (next.length === 0) return null;
		if (cloned.kwargs?.content) cloned.kwargs.content = next;
		else cloned.content = next;
		return cloned;
	}
	const text = typeof content === "string" ? content : "";
	if (!text || !keep({ type: "text", text })) return null;
	return cloned;
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
	if (value && typeof value === "object" && value.type === "json") {
		try {
			return JSON.stringify(value.value ?? null);
		} catch {
			return String(value.value ?? "");
		}
	}
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

function parseToolResultJson(text: string): any {
	const parsed = parseJsonValue(text);
	if (parsed !== null) return parsed;
	return undefined;
}

type ToolActivityProjection = NonNullable<ToolMessageUi["activity"]>;

function deriveToolActivity(part: any, resultText: string): ToolActivityProjection | undefined {
	const toolName = part.toolName || "";
	const input = part.input || {};
	const parsed = parseJsonValue(resultText);
	if (toolName === "list_notebooks" && Array.isArray(parsed)) {
		return { category: "lookup", action: "list", label: "笔记本", meta: `已列出 ${parsed.length} 个笔记本` };
	}
	if (toolName === "list_documents") {
		const count = Array.isArray(parsed?.items) ? parsed.items.length : undefined;
		return { category: "lookup", action: "list", path: parsed?.path, label: parsed?.path || input.path || "文档", meta: count === undefined ? undefined : `已列出 ${count} 篇文档` };
	}
	if (toolName === "recent_documents") {
		const count = Array.isArray(parsed?.items) ? parsed.items.length : Array.isArray(parsed) ? parsed.length : undefined;
		return { category: "lookup", action: "list", label: "最近文档", meta: count === undefined ? undefined : `已浏览 ${count} 篇最近文档` };
	}
	if (toolName === "search_documents" || toolName === "search_fulltext") {
		const count = Array.isArray(parsed?.items) ? parsed.items.length : Array.isArray(parsed?.blocks) ? parsed.blocks.length : undefined;
		const label = typeof input.query === "string" ? input.query : typeof input.keyword === "string" ? input.keyword : "搜索";
		return { category: "lookup", action: "search", label, meta: count === undefined ? undefined : `命中 ${count} 条结果` };
	}
	if (toolName === "get_document" || toolName === "get_document_blocks" || toolName === "get_document_outline" || toolName === "read_block") {
		const count = Array.isArray(parsed) ? parsed.length : Array.isArray(parsed?.blocks) ? parsed.blocks.length : undefined;
		return { category: "lookup", action: "read", id: input.id, label: input.id || toolName, meta: count === undefined ? undefined : `读取 ${count} 项`, open: true };
	}
	if (toolName === "edit_blocks") {
		const results = Array.isArray(parsed?.results) ? parsed.results : [];
		const ok = results.filter((item: any) => item?.status !== "error");
		const first = ok[0] || results[0];
		return { category: "change", action: "edit", id: first?.rootDocId || input.blocks?.[0]?.id, label: first?.rootDocId || input.blocks?.[0]?.id || toolName, meta: ok.length ? `已编辑 ${ok.length} 项` : undefined, open: true };
	}
	if (toolName === "append_block") {
		const count = countAppendBlocks(parsed);
		return { category: "change", action: "append", id: input.parentID, label: input.parentID || toolName, meta: count === undefined ? undefined : `已追加 ${count} 个块`, open: true };
	}
	if (toolName === "create_document") {
		return { category: "change", action: "create", id: parsed?.id, path: parsed?.path || input.path, label: parsed?.path || input.path || parsed?.id || toolName, meta: "已创建文档", open: true };
	}
	if (toolName === "move_document") {
		const count = Array.isArray(parsed?.fromIDs) ? parsed.fromIDs.length : Array.isArray(input.fromIDs) ? input.fromIDs.length : undefined;
		return { category: "change", action: "move", id: (parsed?.fromIDs || input.fromIDs || [])[0], label: (parsed?.fromIDs || input.fromIDs || [])[0] || toolName, meta: parsed?.toID || input.toID ? `目标 ${parsed?.toID || input.toID}` : count ? `已移动 ${count} 项` : undefined };
	}
	if (toolName === "rename_document") {
		return { category: "change", action: "rename", id: parsed?.id || input.id, label: parsed?.title || input.title || parsed?.id || input.id || toolName, meta: "已重命名", open: true };
	}
	if (toolName === "delete_document") {
		return { category: "change", action: "delete", id: parsed?.id || input.id, label: parsed?.id || input.id || toolName, meta: "已删除" };
	}
	if (toolName === "create_scheduled_task") {
		return { category: "change", action: "create", id: parsed?.id, label: parsed?.title || input.title || toolName, meta: "已创建定时任务" };
	}
	if (toolName === "update_scheduled_task") {
		return { category: "change", action: "edit", id: parsed?.id || input.taskId, label: parsed?.title || input.title || input.taskId || toolName, meta: "已更新定时任务" };
	}
	if (toolName === "delete_scheduled_task") {
		return { category: "change", action: "delete", id: parsed?.taskId || input.taskId, label: parsed?.taskId || input.taskId || toolName, meta: "已删除定时任务" };
	}
	if (toolName === "list_scheduled_tasks") {
		const count = Array.isArray(parsed) ? parsed.length : undefined;
		return { category: "lookup", action: "list", label: "定时任务", meta: count === undefined ? undefined : `已列出 ${count} 项` };
	}
	return undefined;
}

function isInternalUiMessage(m: UiMessage): boolean {
	return isToolMessageUi(m) || isProcessingSummaryUi(m) || isRunChangeSummaryUi(m);
}

function getRunMetaForUser(runMeta: AgentRunMeta[], userMessageIndex: number): AgentRunMeta | undefined {
	for (let i = runMeta.length - 1; i >= 0; i--) {
		if (runMeta[i]?.userMessageIndex === userMessageIndex) return runMeta[i];
	}
	return undefined;
}

function statusFromRunMeta(meta?: AgentRunMeta): ProcessingSummaryUi["status"] {
	if (!meta) return "done";
	if (meta.status === "running") return "running";
	if (meta.status === "error" || meta.status === "aborted") return "error";
	return "done";
}

const changeToolActions: Record<string, RunChangeSummaryItemUi["action"]> = {
	edit_blocks: "edit",
	append_block: "append",
	create_document: "create",
	move_document: "move",
	rename_document: "rename",
	delete_document: "delete",
	toggle_todo: "edit",
	create_scheduled_task: "create",
	update_scheduled_task: "edit",
	delete_scheduled_task: "delete",
};

function resultStatusFromParsed(parsed: any): "ok" | "error" {
	if (Array.isArray(parsed?.results) && parsed.results.some((item: any) => item?.status === "error")) return "error";
	if (parsed?.ok === false || parsed?.error) return "error";
	return "ok";
}

function countAppendBlocks(parsed: any): number | undefined {
	if (!Array.isArray(parsed)) return undefined;
	let count = 0;
	for (const item of parsed) {
		const operations = Array.isArray(item?.doOperations) ? item.doOperations : [];
		count += operations.filter((operation: any) => typeof operation?.id === "string").length;
	}
	return count || undefined;
}

function makeChangeItemFromTool(tool: ToolMessageUi, args: any): RunChangeSummaryItemUi | null {
	const action = changeToolActions[tool.toolName];
	if (!action) return null;
	const parsed = tool.result ? parseToolResultJson(tool.result) : undefined;
	const activity = tool.activity?.category === "change" ? tool.activity : undefined;
	const status = tool.status === "error" ? "error" : resultStatusFromParsed(parsed);
	const base: RunChangeSummaryItemUi = {
		action,
		toolName: tool.toolName,
		label: activity?.label || activity?.path || activity?.id || tool.toolName,
		id: activity?.id,
		path: activity?.path,
		status,
		meta: activity?.meta,
	};

	if (tool.toolName === "edit_blocks") {
		const results = Array.isArray(parsed?.results) ? parsed.results : [];
		const ok = results.filter((item: any) => item?.status !== "error");
		const first = ok[0] || results[0];
		return {
			...base,
			label: base.label === tool.toolName ? (first?.rootDocId || args?.blocks?.[0]?.id || tool.toolName) : base.label,
			id: base.id || first?.rootDocId,
			meta: base.meta || (ok.length ? String(ok.length) : undefined),
		};
	}

	if (tool.toolName === "append_block") {
		const count = countAppendBlocks(parsed);
		return {
			...base,
			label: base.label === tool.toolName ? (args?.parentID || tool.toolName) : base.label,
			id: base.id || args?.parentID,
			added: count,
		};
	}

	if (tool.toolName === "create_document") {
		return {
			...base,
			label: base.label === tool.toolName ? (parsed?.path || args?.path || parsed?.id || tool.toolName) : base.label,
			id: base.id || parsed?.id,
			path: base.path || parsed?.path || args?.path,
			added: 1,
		};
	}

	if (tool.toolName === "move_document") {
		const moved = Array.isArray(parsed?.fromIDs) ? parsed.fromIDs.length : Array.isArray(args?.fromIDs) ? args.fromIDs.length : undefined;
		return {
			...base,
			label: base.label === tool.toolName ? ((args?.fromIDs || parsed?.fromIDs || [])[0] || tool.toolName) : base.label,
			id: base.id || (args?.fromIDs || parsed?.fromIDs || [])[0],
			meta: base.meta || (args?.toID || parsed?.toID ? String(args?.toID || parsed?.toID) : undefined),
			added: moved,
		};
	}

	if (tool.toolName === "rename_document") {
		return {
			...base,
			label: base.label === tool.toolName ? (args?.title || parsed?.title || args?.id || tool.toolName) : base.label,
			id: base.id || args?.id || parsed?.id,
		};
	}

	if (tool.toolName === "delete_document") {
		return {
			...base,
			label: base.label === tool.toolName ? (args?.id || parsed?.id || tool.toolName) : base.label,
			id: base.id || args?.id || parsed?.id,
			removed: 1,
		};
	}

	return base;
}

function buildChangeSummary(turnMessages: UiMessage[]): RunChangeSummaryUi | null {
	const argsByToolCallId = new Map<string, any>();
	for (const m of turnMessages) {
		if (isInternalUiMessage(m)) continue;
		if (msgType(m) !== "ai") continue;
		for (const tc of getMessageToolCalls(m)) {
			const id = getToolCallId(tc);
			if (id) argsByToolCallId.set(id, tc.args ?? tc.input ?? {});
		}
	}
	const items: RunChangeSummaryItemUi[] = [];
	for (const m of turnMessages) {
		if (!isToolMessageUi(m)) continue;
		const item = makeChangeItemFromTool(m, argsByToolCallId.get(m.toolCallId));
		if (item) items.push(item);
	}
	if (!items.length) return null;
	return { type: "run_change_summary_ui", items, total: items.length };
}

function collapseTurn(
	turnMessages: UiMessage[],
	userMessageIndex: number,
	runMeta: AgentRunMeta[],
): UiMessage[] {
	if (!turnMessages.length) return [];
	const first = turnMessages[0];
	if (isInternalUiMessage(first) || (msgType(first) !== "human" && msgType(first) !== "user")) {
		return turnMessages;
	}

	let finalAiIndex = -1;
	for (let i = turnMessages.length - 1; i >= 1; i--) {
		const m = turnMessages[i];
		if (!isInternalUiMessage(m) && msgType(m) === "ai" && getMessageContent(m).trim()) {
			finalAiIndex = i;
			break;
		}
	}
	if (finalAiIndex < 0) return turnMessages;

	const finalAi = turnMessages[finalAiIndex] as Record<string, any>;
	const finalTextMessage = cloneAiWithParts(finalAi, (part) => part?.type === "text");
	if (!finalTextMessage) return turnMessages;

	const detailMessages: UiMessage[] = [];
	for (let i = 1; i < turnMessages.length; i++) {
		if (i === finalAiIndex) {
			const nonTextFinal = cloneAiWithParts(finalAi, (part) => part?.type !== "text");
			if (nonTextFinal) detailMessages.push(nonTextFinal);
			continue;
		}
		detailMessages.push(turnMessages[i]);
	}

	const meta = getRunMetaForUser(runMeta, userMessageIndex);
	const collapsed: UiMessage[] = [first];
	if (detailMessages.length > 0 || getMessageReasoning(finalAi)) {
		collapsed.push({
			type: "processing_summary_ui",
			status: statusFromRunMeta(meta),
			durationMs: meta?.durationMs,
			details: detailMessages,
		});
	}
	collapsed.push(finalTextMessage);
	const changeSummary = buildChangeSummary(turnMessages);
	if (changeSummary) collapsed.push(changeSummary);
	return collapsed;
}

function collapseMessagesByTurn(messages: UiMessage[], runMeta: AgentRunMeta[]): UiMessage[] {
	const result: UiMessage[] = [];
	let currentTurn: UiMessage[] = [];
	let userMessageIndex = -1;
	let currentUserIndex = -1;

	const flush = () => {
		if (!currentTurn.length) return;
		result.push(...collapseTurn(currentTurn, currentUserIndex, runMeta));
		currentTurn = [];
	};

	for (const m of messages) {
		const startsTurn = !isInternalUiMessage(m) && (msgType(m) === "human" || msgType(m) === "user");
		if (startsTurn) {
			flush();
			userMessageIndex += 1;
			currentUserIndex = userMessageIndex;
			currentTurn = [m];
			continue;
		}
		if (currentTurn.length) currentTurn.push(m);
		else result.push(m);
	}
	flush();
	return result;
}

/**
 * Read-only projection builder for rendering message history.  It creates the
 * tool card view model from persisted `state.messages`;
 * callers must not write its output back into session state.
 */
export class UiMessageBuilder {
	private messages: UiMessage[] = [];
	private pendingToolMessages = new Map<string, ToolMessageUi>();
	private currentAiIndex: number | null = null;

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
			startedAt: Date.now(),
		};
		this.pendingToolMessages.set(toolCallId, tmu);
		this.messages.push(tmu);
	}

	onToolResult(toolCallId: string, error?: boolean, result?: string, part?: any): void {
		const tmu = this.pendingToolMessages.get(toolCallId);
		if (tmu) {
			tmu.status = error ? "error" : "done";
			if (result !== undefined) tmu.result = result;
			if (!error && part && result !== undefined) tmu.activity = deriveToolActivity(part, result);
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
 * Build a render-only UiMessage array from `state.messages`.
 * This is a projection, not persisted state.
 */
export function buildMessagesViewFromParts(
	messages: any[],
): UiMessage[] {
	const builder = new UiMessageBuilder();
	const toolCallsById = new Map<string, any>();

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
				toolCallsById.set(tcId, tc);
				builder.onToolCallStart(getToolCallName(tc), tcId);
			}
			continue;
		}

		if (type === "tool") {
			for (const part of getToolResultParts(msg)) {
				const tcId = part.toolCallId;
				if (!tcId) continue;
				const tc = toolCallsById.get(tcId);
				const enrichedPart = {
					...part,
					toolName: part.toolName || getToolCallName(tc),
					input: part.input ?? tc?.input ?? tc?.args ?? {},
				};
				const result = getToolResultText(part);
				builder.onToolResult(tcId, part?.type === "tool-error" || part?.error !== undefined, result, enrichedPart);
			}
			continue;
		}
	}

	return builder.finalise();
}

/**
 * Build render-only message history from an AgentState.
 *
 */
export function buildMessagesView(state: AgentState | undefined | null): UiMessage[] {
	const messages = Array.isArray(state?.messages) ? state!.messages : [];
	const runMeta = Array.isArray(state?.runMeta) ? state!.runMeta : [];
	return collapseMessagesByTurn(buildMessagesViewFromParts(messages), runMeta);
}
