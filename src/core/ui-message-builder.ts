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
import { defaultTranslator, type Translator } from "../i18n";

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

function countInputBlocks(value: any): number | undefined {
	return Array.isArray(value) ? value.length : undefined;
}

function getFirstOkEditResult(parsed: any): any | undefined {
	if (!Array.isArray(parsed?.results)) return undefined;
	return parsed.results.find((item: any) => item?.status === "ok");
}

function getOkEditBlockIds(parsed: any): string[] {
	if (!Array.isArray(parsed?.results)) return [];
	const ids: string[] = [];
	for (const item of parsed.results) {
		if (item?.status !== "ok" || !Array.isArray(item.newIds)) continue;
		for (const id of item.newIds) {
			if (typeof id === "string" && id) ids.push(id);
		}
	}
	return ids;
}

function isToolResultError(resultText: string, explicitError = false): boolean {
	if (explicitError) return true;
	const parsed = parseJsonValue(resultText);
	if (!parsed || typeof parsed !== "object") return false;
	if (parsed.ok === false || parsed.error) return true;
	if (Array.isArray(parsed.results) && parsed.results.some((item: any) => item?.status === "error")) return true;
	const keys = Object.keys(parsed);
	if (typeof parsed.message === "string" && keys.every((key) => key === "message" || key === "name" || key === "stack")) return true;
	return false;
}

function deriveToolActivity(part: any, i18n: Translator): ToolActivityProjection | undefined {
	const toolName = part.toolName || "";
	const input = part.input || {};
	const resultText = typeof part.resultText === "string" ? part.resultText : "";
	const parsed = parseJsonValue(resultText);
	if (toolName === "list_notebooks" && Array.isArray(parsed)) {
		return { category: "lookup", action: "list", label: i18n.t("tool.listNotebooks.label"), meta: i18n.t("tool.listNotebooks.meta", { count: parsed.length }) };
	}
	if (toolName === "list_documents") {
		const count = Array.isArray(parsed?.items) ? parsed.items.length : undefined;
		return { category: "lookup", action: "list", path: parsed?.path, label: parsed?.path || input.path || i18n.t("chat.tool.defaultDocument"), meta: count === undefined ? undefined : i18n.t("tool.listDocuments.meta", { count }) };
	}
	if (toolName === "recent_documents") {
		const count = Array.isArray(parsed?.items) ? parsed.items.length : Array.isArray(parsed) ? parsed.length : undefined;
		return { category: "lookup", action: "list", label: i18n.t("tool.recentDocuments.label"), meta: count === undefined ? undefined : i18n.t("tool.recentDocuments.meta", { count }) };
	}
	if (toolName === "search_documents" || toolName === "search_fulltext") {
		const count = Array.isArray(parsed?.items) ? parsed.items.length : Array.isArray(parsed?.blocks) ? parsed.blocks.length : undefined;
		const label = typeof input.query === "string" ? input.query : typeof input.keyword === "string" ? input.keyword : i18n.t("chat.action.search");
		const key = toolName === "search_documents" ? "tool.searchDocuments.meta" : "tool.searchFulltext.meta";
		return { category: "lookup", action: "search", label, meta: count === undefined ? undefined : i18n.t(key, { count }) };
	}
	if (toolName === "get_document" || toolName === "get_document_blocks" || toolName === "get_document_outline" || toolName === "read_block") {
		const count = Array.isArray(parsed) ? parsed.length : Array.isArray(parsed?.blocks) ? parsed.blocks.length : undefined;
		return { category: "lookup", action: "read", id: input.id, label: input.id || toolName, meta: count === undefined ? undefined : i18n.t("tool.readItems.meta", { count }), open: true };
	}
	if (toolName === "edit_blocks") {
		const count = countInputBlocks(input.blocks);
		const inputId = input.blocks?.[0]?.id;
		const firstOk = getFirstOkEditResult(parsed);
		const blockIds = getOkEditBlockIds(parsed);
		const blockId = blockIds[0];
		const rootDocId = typeof firstOk?.rootDocId === "string" && firstOk.rootDocId ? firstOk.rootDocId : undefined;
		return { category: "change", action: "edit", id: blockId || rootDocId, blockId, blockIds, label: blockId || inputId || toolName, meta: count === undefined ? i18n.t("tool.editBlocks.metaUnknown") : i18n.t("tool.editBlocks.meta", { count }), open: Boolean(blockId || rootDocId) };
	}
	if (toolName === "append_block") {
		return { category: "change", action: "append", id: input.parentID, label: input.parentID || toolName, meta: i18n.t("tool.appendBlock.metaSimple"), open: true };
	}
	if (toolName === "create_document") {
		return { category: "change", action: "create", id: input.id, path: input.path, label: input.path || input.id || toolName, meta: i18n.t("tool.createDocument.meta"), open: Boolean(input.id) };
	}
	if (toolName === "move_document") {
		const count = Array.isArray(input.fromIDs) ? input.fromIDs.length : undefined;
		return { category: "change", action: "move", id: (input.fromIDs || [])[0], label: (input.fromIDs || [])[0] || toolName, meta: input.toID ? i18n.t("tool.moveDocument.meta", { target: input.toID }) : count ? i18n.t("tool.moveDocument.metaCount", { count }) : undefined, open: false };
	}
	if (toolName === "rename_document") {
		return { category: "change", action: "rename", id: input.id, label: input.title || input.id || toolName, meta: i18n.t("tool.renameDocument.meta"), open: true };
	}
	if (toolName === "delete_document") {
		return { category: "change", action: "delete", id: input.id, label: input.id || toolName, meta: i18n.t("tool.deleteDocument.meta"), open: false };
	}
	if (toolName === "create_scheduled_task") {
		return { category: "change", action: "create", id: parsed?.id, label: parsed?.title || input.title || toolName, meta: i18n.t("tool.scheduled.create.meta") };
	}
	if (toolName === "update_scheduled_task") {
		return { category: "change", action: "edit", id: parsed?.id || input.taskId, label: parsed?.title || input.title || input.taskId || toolName, meta: i18n.t("tool.scheduled.update.meta") };
	}
	if (toolName === "delete_scheduled_task") {
		return { category: "change", action: "delete", id: parsed?.taskId || input.taskId, label: parsed?.taskId || input.taskId || toolName, meta: i18n.t("tool.scheduled.delete.meta") };
	}
	if (toolName === "list_scheduled_tasks") {
		const count = Array.isArray(parsed) ? parsed.length : undefined;
		return { category: "lookup", action: "list", label: i18n.t("tool.scheduled.label"), meta: count === undefined ? undefined : i18n.t("tool.scheduled.list.meta", { count }) };
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

function makeChangeItemFromTool(tool: ToolMessageUi, args: any, i18n: Translator): RunChangeSummaryItemUi | null {
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
		const count = countInputBlocks(args?.blocks);
		const firstOk = getFirstOkEditResult(parsed);
		const blockIds = getOkEditBlockIds(parsed);
		const blockId = blockIds[0];
		const rootDocId = typeof firstOk?.rootDocId === "string" && firstOk.rootDocId ? firstOk.rootDocId : undefined;
		return {
			...base,
			label: blockId || (base.label === tool.toolName ? (args?.blocks?.[0]?.id || tool.toolName) : base.label),
			id: blockId || rootDocId,
			blockId: blockId || base.blockId,
			blockIds: blockIds.length ? blockIds : base.blockIds,
			meta: base.meta || (count ? i18n.t("tool.editBlocks.meta", { count }) : undefined),
		};
	}

	if (tool.toolName === "append_block") {
		return {
			...base,
			label: base.label === tool.toolName ? (args?.parentID || tool.toolName) : base.label,
			id: base.id || args?.parentID,
		};
	}

	if (tool.toolName === "create_document") {
		return {
			...base,
			label: base.label === tool.toolName ? (args?.path || args?.id || tool.toolName) : base.label,
			id: base.id || args?.id,
			path: base.path || args?.path,
			added: 1,
		};
	}

	if (tool.toolName === "move_document") {
		const moved = Array.isArray(args?.fromIDs) ? args.fromIDs.length : undefined;
		return {
			...base,
			label: base.label === tool.toolName ? ((args?.fromIDs || [])[0] || tool.toolName) : base.label,
			id: base.id || (args?.fromIDs || [])[0],
			meta: base.meta || (args?.toID ? String(args.toID) : undefined),
			added: moved,
		};
	}

	if (tool.toolName === "rename_document") {
		return {
			...base,
			label: base.label === tool.toolName ? (args?.title || args?.id || tool.toolName) : base.label,
			id: base.id || args?.id,
		};
	}

	if (tool.toolName === "delete_document") {
		return {
			...base,
			label: base.label === tool.toolName ? (args?.id || tool.toolName) : base.label,
			id: base.id || args?.id,
			removed: 1,
		};
	}

	return base;
}

function buildChangeSummary(turnMessages: UiMessage[], i18n: Translator): RunChangeSummaryUi | null {
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
		const item = makeChangeItemFromTool(m, argsByToolCallId.get(m.toolCallId), i18n);
		if (item) items.push(item);
	}
	if (!items.length) return null;
	return { type: "run_change_summary_ui", items, total: items.length };
}

function collapseTurn(
	turnMessages: UiMessage[],
	userMessageIndex: number,
	runMeta: AgentRunMeta[],
	i18n: Translator,
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
	const changeSummary = buildChangeSummary(turnMessages, i18n);
	if (changeSummary) collapsed.push(changeSummary);
	return collapsed;
}

function collapseMessagesByTurn(messages: UiMessage[], runMeta: AgentRunMeta[], i18n: Translator): UiMessage[] {
	const result: UiMessage[] = [];
	let currentTurn: UiMessage[] = [];
	let userMessageIndex = -1;
	let currentUserIndex = -1;

	const flush = () => {
		if (!currentTurn.length) return;
		result.push(...collapseTurn(currentTurn, currentUserIndex, runMeta, i18n));
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

	constructor(private readonly i18n: Translator = defaultTranslator) {}

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
			const hasError = part?.toolName === "call_error" || isToolResultError(result || "", Boolean(error));
			tmu.status = hasError ? "error" : "done";
			if (result !== undefined) tmu.result = result;
			if (part) tmu.activity = deriveToolActivity({ ...part, resultText: result }, this.i18n);
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
	i18n: Translator = defaultTranslator,
): UiMessage[] {
	const builder = new UiMessageBuilder(i18n);
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
export function buildMessagesView(state: AgentState | undefined | null, i18n: Translator = defaultTranslator): UiMessage[] {
	const messages = Array.isArray(state?.messages) ? state!.messages : [];
	const runMeta = Array.isArray(state?.runMeta) ? state!.runMeta : [];
	return collapseMessagesByTurn(buildMessagesViewFromParts(messages, i18n), runMeta, i18n);
}
