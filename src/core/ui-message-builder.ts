import type {
	AgentRunMeta,
	AgentState,
	ChangePreview,
	ProcessingSummaryUi,
	RunChangeSummaryItemUi,
	RunChangeSummaryUi,
	ToolApprovalUi,
	ToolMessageUi,
	UiMessage,
} from "../types";
import { isProcessingSummaryUi, isRunChangeSummaryUi, isToolApprovalUi, isToolMessageUi } from "../types";
import { defaultTranslator, type Translator } from "../i18n";
import { stripSiyuanBlockAttrs } from "./siyuan-markdown";

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

function getToolApprovalRequestParts(msg: any): any[] {
	const content = msg?.kwargs?.content ?? msg?.content;
	if (!Array.isArray(content)) return [];
	return content.filter((part: any) => part?.type === "tool-approval-request");
}

function getToolApprovalResponseParts(msg: any): any[] {
	const content = msg?.kwargs?.content ?? msg?.content;
	if (!Array.isArray(content)) return [];
	return content.filter((part: any) => part?.type === "tool-approval-response");
}

function getToolResultText(part: any): string {
	const value = part?.output ?? part?.result ?? part?.error ?? "";
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && value.type === "text" && typeof value.value === "string") return value.value;
	if (value && typeof value === "object" && value.type === "error-text" && typeof value.value === "string") return value.value;
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

function makeCreateDocumentPreview(input: any): ChangePreview | undefined {
	const markdown = typeof input?.markdown === "string" ? input.markdown : "";
	const path = typeof input?.path === "string" ? input.path : undefined;
	if (!markdown && !path) return undefined;
	return {
		kind: "create_document",
		path,
		status: "ready",
		items: [{
			label: path || input?.id || "create_document",
			before: "",
			after: markdown,
			status: "ok",
		}],
	};
}

function makeEditBlocksPreviewFromInput(input: any): ChangePreview | undefined {
	if (!Array.isArray(input?.blocks)) return undefined;
	const items = input.blocks.map((block: any) => ({
		id: typeof block?.id === "string" ? block.id : undefined,
		label: typeof block?.id === "string" ? block.id : undefined,
		after: typeof block?.content === "string" ? block.content : "",
		status: "ok" as const,
	}));
	return { kind: "edit_blocks", status: "partial", items };
}

function makeEditBlocksPreviewFromResult(input: any, parsed: any): ChangePreview | undefined {
	if (!Array.isArray(parsed?.results)) return makeEditBlocksPreviewFromInput(input);
	const inputBlocks = Array.isArray(input?.blocks) ? input.blocks : [];
	const inputById = new Map(inputBlocks.map((block: any) => [block?.id, block]));
	const items = parsed.results.map((item: any) => {
		const inputBlock = inputById.get(item?.oldId);
		const after = typeof item?.updated === "string"
			? item.updated
			: typeof inputBlock?.content === "string"
				? inputBlock.content
				: "";
		return {
			id: typeof item?.oldId === "string" ? item.oldId : undefined,
			label: typeof item?.oldId === "string" ? item.oldId : undefined,
			before: typeof item?.original === "string" ? item.original : undefined,
			after,
			status: item?.status === "error" ? "error" as const : "ok" as const,
			error: typeof item?.error === "string" ? item.error : undefined,
		};
	});
	const hasError = items.some((item: ChangePreview["items"][number]) => item.status === "error");
	const hasBefore = items.some((item: ChangePreview["items"][number]) => item.before !== undefined);
	return {
		kind: "edit_blocks",
		status: hasError ? "partial" : hasBefore ? "ready" : "partial",
		items,
	};
}

function deriveChangePreview(toolName: string, input: any, resultText?: string, approvalPreview?: ChangePreview): ChangePreview | undefined {
	if (approvalPreview) return approvalPreview;
	if (toolName === "create_document") return makeCreateDocumentPreview(input);
	if (toolName !== "edit_blocks") return undefined;
	const parsed = resultText ? parseToolResultJson(resultText) : undefined;
	return parsed ? makeEditBlocksPreviewFromResult(input, parsed) : makeEditBlocksPreviewFromInput(input);
}

type ToolActivityProjection = NonNullable<ToolMessageUi["activity"]>;

function countInputBlocks(value: any): number | undefined {
	return Array.isArray(value) ? value.length : undefined;
}

function makeContentExcerpt(value: unknown, fallback = ""): string {
	const text = stripSiyuanBlockAttrs(typeof value === "string" ? value : fallback);
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	return normalized.length > 18 ? `${normalized.slice(0, 18)}...` : normalized;
}

function getEditBlocksExcerpt(input: any, parsed: any): string {
	const firstResult = Array.isArray(parsed?.results) ? parsed.results[0] : undefined;
	const firstInputBlock = Array.isArray(input?.blocks) ? input.blocks[0] : undefined;
	return makeContentExcerpt(
		firstResult?.updated ?? firstResult?.original ?? firstInputBlock?.content,
	);
}

export function extractEditOkResults(parsed: any): { firstOk: any | undefined; blockIds: string[] } {
	if (!Array.isArray(parsed?.results)) return { firstOk: undefined, blockIds: [] };
	let firstOk: any | undefined;
	const blockIds: string[] = [];
	for (const item of parsed.results) {
		if (item?.status !== "ok") continue;
		if (!firstOk) firstOk = item;
		if (Array.isArray(item.newIds)) {
			for (const id of item.newIds) {
				if (typeof id === "string" && id) blockIds.push(id);
			}
		}
	}
	return { firstOk, blockIds };
}

function isToolResultError(resultText: string, explicitError = false): boolean {
	if (explicitError) return true;
	const parsed = parseJsonValue(resultText);
	if (!parsed || typeof parsed !== "object") return false;
	if (parsed.type === "error-text") return true;
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
		const { firstOk, blockIds } = extractEditOkResults(parsed);
		const blockId = blockIds[0];
		const rootDocId = typeof firstOk?.rootDocId === "string" && firstOk.rootDocId ? firstOk.rootDocId : undefined;
		return { category: "change", action: "edit", id: rootDocId || blockId, blockId, blockIds, label: getEditBlocksExcerpt(input, parsed) || inputId || toolName, meta: count === undefined ? i18n.t("tool.editBlocks.metaUnknown") : i18n.t("tool.editBlocks.meta", { count }), open: Boolean(rootDocId || blockId) };
	}
	if (toolName === "append_block") {
		return { category: "change", action: "append", id: input.parentID, label: input.parentID || toolName, meta: i18n.t("tool.appendBlock.metaSimple"), open: true };
	}
	if (toolName === "create_document") {
		const resultId = typeof parsed?.id === "string" && parsed.id ? parsed.id : undefined;
		return { category: "change", action: "create", id: resultId || input.id, path: input.path, label: input.path || resultId || input.id || toolName, meta: i18n.t("tool.createDocument.meta"), open: Boolean(resultId || input.id) };
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
	return isToolMessageUi(m) || isToolApprovalUi(m) || isProcessingSummaryUi(m) || isRunChangeSummaryUi(m);
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
		preview: tool.preview,
	};

	if (tool.toolName === "edit_blocks") {
		const count = countInputBlocks(args?.blocks);
		const { firstOk, blockIds } = extractEditOkResults(parsed);
		const blockId = blockIds[0];
		const rootDocId = typeof firstOk?.rootDocId === "string" && firstOk.rootDocId ? firstOk.rootDocId : undefined;
		return {
			...base,
			label: getEditBlocksExcerpt(args, parsed) || (base.label === tool.toolName ? (args?.blocks?.[0]?.id || tool.toolName) : base.label),
			id: rootDocId || blockId,
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
		const resultId = typeof parsed?.id === "string" && parsed.id ? parsed.id : undefined;
		return {
			...base,
			label: base.label === tool.toolName ? (args?.path || resultId || args?.id || tool.toolName) : base.label,
			id: base.id || resultId || args?.id,
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

function makeChangeItemFromApproval(approval: ToolApprovalUi, args: any, i18n: Translator): RunChangeSummaryItemUi | null {
	const action = changeToolActions[approval.toolName];
	if (!action) return null;
	const input = args ?? approval.input ?? {};
	const base: RunChangeSummaryItemUi = {
		action,
		toolName: approval.toolName,
		label: approval.toolName,
		status: approval.status,
		approvalId: approval.approvalId,
		preview: approval.preview || deriveChangePreview(approval.toolName, input),
	};

	if (approval.toolName === "edit_blocks") {
		const count = countInputBlocks(input?.blocks);
		const firstBlockId = input?.blocks?.[0]?.id;
		return {
			...base,
			label: firstBlockId || approval.toolName,
			id: firstBlockId,
			blockId: firstBlockId,
			meta: count ? i18n.t("tool.editBlocks.meta", { count }) : undefined,
		};
	}

	if (approval.toolName === "append_block") {
		return {
			...base,
			label: input?.parentID || approval.toolName,
			id: input?.parentID,
		};
	}

	if (approval.toolName === "create_document") {
		return {
			...base,
			label: input?.path || input?.id || approval.toolName,
			id: input?.id,
			path: input?.path,
			added: 1,
		};
	}

	if (approval.toolName === "move_document") {
		const moved = Array.isArray(input?.fromIDs) ? input.fromIDs.length : undefined;
		return {
			...base,
			label: (input?.fromIDs || [])[0] || approval.toolName,
			id: (input?.fromIDs || [])[0],
			meta: input?.toID ? String(input.toID) : undefined,
			added: moved,
		};
	}

	if (approval.toolName === "rename_document") {
		return {
			...base,
			label: input?.title || input?.id || approval.toolName,
			id: input?.id,
		};
	}

	if (approval.toolName === "delete_document") {
		return {
			...base,
			label: input?.id || approval.toolName,
			id: input?.id,
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
	const approvalToolCallIds = new Set(
		turnMessages
			.filter(isToolApprovalUi)
			.filter((approval) => approval.status === "pending" || approval.status === "denied")
			.map((approval) => approval.toolCallId),
	);
	for (const m of turnMessages) {
		if (isToolMessageUi(m) && approvalToolCallIds.has(m.toolCallId)) continue;
		const item = isToolMessageUi(m)
			? makeChangeItemFromTool(m, argsByToolCallId.get(m.toolCallId), i18n)
			: isToolApprovalUi(m)
				? m.status === "approved" ? null : makeChangeItemFromApproval(m, argsByToolCallId.get(m.toolCallId), i18n)
				: null;
		if (item) items.push(item);
	}
	const visibleCount = items.filter((item) => item.status !== "error" && item.status !== "denied" && item.status !== "approved").length;
	if (!visibleCount) return null;
	return { type: "run_change_summary_ui", items, total: visibleCount };
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
	const meta = getRunMetaForUser(runMeta, userMessageIndex);
	const hasPendingApproval = turnMessages.some((m) => isToolApprovalUi(m) && m.status === "pending");
	if (meta?.status === "running" || hasPendingApproval) {
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
	if (finalAiIndex < 0) {
		const collapsed: UiMessage[] = [first];
		if (turnMessages.length > 1) {
			collapsed.push({
				type: "processing_summary_ui",
				status: statusFromRunMeta(meta),
				durationMs: meta?.durationMs,
				details: turnMessages.slice(1),
			});
		}
		const changeSummary = buildChangeSummary(turnMessages, i18n);
		if (changeSummary) collapsed.push(changeSummary);
		return collapsed;
	}

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
	private pendingApprovals = new Map<string, ToolApprovalUi>();
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
			if (part) tmu.preview = deriveChangePreview(part.toolName || "", part.input || {}, result);
			tmu.finishedAt = Date.now();
			this.pendingToolMessages.delete(toolCallId);
		}
		this.currentAiIndex = null;
	}

	onToolApprovalRequest(approval: ToolApprovalUi): void {
		this.pendingApprovals.set(approval.approvalId, approval);
		this.messages.push(approval);
	}

	onToolApprovalResponse(approvalId: string, approved: boolean, reason?: string): void {
		const approval = this.pendingApprovals.get(approvalId);
		if (approval) {
			approval.status = approved ? "approved" : "denied";
			if (reason) approval.reason = reason;
			this.pendingApprovals.delete(approvalId);
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
		this.pendingApprovals.clear();
		this.currentAiIndex = null;

		/* Ensure every AIMessage tool_call has a ToolMessageUi */
		const existing = new Set<string>();
		const approvalToolCallIds = new Set<string>();
		for (const m of this.messages) {
			if (isToolMessageUi(m)) {
				existing.add(m.toolCallId);
			}
			if (isToolApprovalUi(m)) {
				approvalToolCallIds.add(m.toolCallId);
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
				if (approvalToolCallIds.has(tcId)) continue;
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
	pendingApprovals: ToolApprovalUi[] = [],
): UiMessage[] {
	const builder = new UiMessageBuilder(i18n);
	const toolCallsById = new Map<string, any>();
	const approvalsById = new Map(pendingApprovals.map((approval) => [approval.approvalId, approval]));

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
			for (const part of getToolApprovalRequestParts(msg)) {
				const tcId = part.toolCallId;
				if (!tcId) continue;
				const tc = toolCallsById.get(tcId);
				const storedApproval = approvalsById.get(part.approvalId);
				builder.onToolApprovalRequest({
					type: "tool_approval_ui",
					approvalId: part.approvalId,
					toolCallId: tcId,
					toolName: storedApproval?.toolName || getToolCallName(tc),
					input: storedApproval?.input ?? tc?.input ?? tc?.args ?? {},
					preview: storedApproval?.preview,
					status: storedApproval?.status || "pending",
					reason: storedApproval?.reason,
				});
			}
			continue;
		}

		if (type === "tool") {
			for (const part of getToolApprovalResponseParts(msg)) {
				if (!part.approvalId) continue;
				builder.onToolApprovalResponse(part.approvalId, Boolean(part.approved), part.reason);
			}
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
				const outputType = part?.output && typeof part.output === "object" ? part.output.type : undefined;
				builder.onToolResult(tcId, part?.type === "tool-error" || part?.error !== undefined || outputType === "error-text", result, enrichedPart);
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
	const pendingApprovals = Array.isArray(state?.pendingApprovals)
		? state!.pendingApprovals.map((approval: any) => ({ type: "tool_approval_ui", ...approval }))
		: [];
	return collapseMessagesByTurn(buildMessagesViewFromParts(messages, i18n, pendingApprovals), runMeta, i18n);
}
