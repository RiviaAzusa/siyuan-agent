import { streamText } from "ai";
import type { ModelMessage } from "ai";
import type {
	AgentState,
	AgentStreamUiEvent,
	ChunkParserState,
	RunAgentStreamResult,
	TodoList,
	ToolUIEvent,
	ToolUIEventPayload,
} from "../types";
import type { ToolContext } from "./tool-types";
import type { AgentSetup } from "./agent";

function genId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function normalizeReasoningDelta(current: string, incoming: string): string {
	if (!incoming) return "";
	if (incoming.startsWith(current)) {
		return incoming.slice(current.length);
	}
	return incoming;
}

function normalizeToolUIEvent(raw: string, toolCallIndex: number, toolName?: string): ToolUIEvent {
	let parsed: any = null;
	try {
		parsed = JSON.parse(raw);
	} catch {
		/* plain string */
	}

	let payload: ToolUIEventPayload;
	if (parsed?.__tool_type === "activity") {
		payload = {
			type: "activity",
			category: parsed.category === "change" || parsed.category === "other" ? parsed.category : "lookup",
			action: typeof parsed.action === "string" ? parsed.action : "other",
			id: parsed.id ? String(parsed.id) : undefined,
			path: parsed.path ? String(parsed.path) : undefined,
			label: parsed.label ? String(parsed.label) : undefined,
			meta: parsed.meta ? String(parsed.meta) : undefined,
			open: parsed.open === undefined ? undefined : Boolean(parsed.open),
		};
	} else if (parsed?.__tool_type === "created_document" && parsed.id) {
		payload = {
			type: "created_document",
			id: String(parsed.id),
			path: parsed.path ? String(parsed.path) : undefined,
		};
	} else if (parsed?.__tool_type === "document_link" && parsed.id) {
		payload = {
			type: "document_link",
			id: String(parsed.id),
			path: parsed.path ? String(parsed.path) : undefined,
			label: parsed.label ? String(parsed.label) : undefined,
			open: Boolean(parsed.open),
		};
	} else if (parsed?.__tool_type === "document_blocks" && parsed.id) {
		payload = {
			type: "document_blocks",
			id: String(parsed.id),
			path: parsed.path ? String(parsed.path) : undefined,
			blockCount: Number(parsed.blockCount) || 0,
			open: Boolean(parsed.open),
		};
	} else if (parsed?.__tool_type === "append_block" && parsed.parentID) {
		payload = {
			type: "append_block",
			parentID: String(parsed.parentID),
			path: parsed.path ? String(parsed.path) : undefined,
			blockIDs: Array.isArray(parsed.blockIDs) ? parsed.blockIDs.map(String) : [],
			open: Boolean(parsed.open),
		};
	} else if (parsed?.__tool_type === "edit_blocks") {
		payload = {
			type: "edit_blocks",
			documentIDs: Array.isArray(parsed.documentIDs) ? parsed.documentIDs.map(String) : [],
			primaryDocumentID: parsed.primaryDocumentID ? String(parsed.primaryDocumentID) : undefined,
			path: parsed.path ? String(parsed.path) : undefined,
			editedCount: Number(parsed.editedCount) || 0,
			open: Boolean(parsed.open),
		};
	} else if (parsed && typeof parsed === "object") {
		payload = {
			type: "unknown_structured",
			raw,
			payload: parsed,
		};
	} else {
		payload = { type: "text", text: raw };
	}

	return {
		id: genId(),
		source: "writer",
		toolCallIndex,
		toolCallId: parsed?.toolCallId ? String(parsed.toolCallId) : undefined,
		toolName: typeof parsed?.toolName === "string" ? parsed.toolName : toolName,
		payload,
	};
}

function createParserState(inputState: AgentState, existingToolUIEvents: ToolUIEvent[] = []): ChunkParserState {
	return {
		inputState: {
			...inputState,
			messages: Array.isArray(inputState.messages) ? [...inputState.messages] : inputState.messages,
			compaction: inputState.compaction ? { ...inputState.compaction } : inputState.compaction,
			todos: inputState.todos ? { ...inputState.todos, items: [...inputState.todos.items] } : inputState.todos,
			toolUIEvents: Array.isArray(inputState.toolUIEvents) ? [...inputState.toolUIEvents] : inputState.toolUIEvents,
		},
		currentState: null,
		contentBuffer: "",
		reasoningBuffer: "",
		pendingMessages: [],
		pendingToolCalls: [],
		toolUIEvents: [...existingToolUIEvents],
		lastToolCallIndex: -1,
		toolCallMap: {},
		seenToolCallKeys: [],
	};
}

/* ── Message normalisation (handles both lc:1 and new format) ──────── */

function convertLcMessage(raw: Record<string, any>): Record<string, any> {
	const className: string = raw.id?.[raw.id.length - 1] ?? "";
	const kwargs = raw.kwargs ?? {};
	switch (className) {
		case "HumanMessage":
			return { role: "user", content: kwargs.content ?? "" };
		case "AIMessage":
		case "AIMessageChunk":
			return {
				role: "assistant",
				content: [
					...(kwargs.additional_kwargs?.reasoning_content ? [{ type: "reasoning", text: kwargs.additional_kwargs.reasoning_content }] : []),
					...(kwargs.content ? [{ type: "text", text: kwargs.content }] : []),
					...(Array.isArray(kwargs.tool_calls) ? kwargs.tool_calls.map((tc: any) => ({
						type: "tool-call",
						toolCallId: tc.id ?? tc.tool_call_id ?? tc.toolCallId ?? "",
						toolName: tc.name ?? tc.toolName ?? "",
						input: tc.args ?? tc.input ?? {},
					})) : []),
				],
				...(kwargs.usage_metadata ? { usage: kwargs.usage_metadata } : {}),
			};
		case "SystemMessage":
			return { role: "system", content: kwargs.content ?? "" };
		case "ToolMessage": {
			return {
				role: "tool",
				content: [{
					type: "tool-result",
					toolCallId: kwargs.tool_call_id ?? kwargs.toolCallId ?? "",
					toolName: kwargs.name ?? kwargs.toolName ?? "",
					output: kwargs.content ?? "",
				}],
			};
		}
		default:
			return { role: "user", content: JSON.stringify(raw) };
	}
}

function normalizeToCanonical(m: any): Record<string, any> {
	if (m?.lc === 1 && m.type === "constructor" && Array.isArray(m.id)) return convertLcMessage(m);
	if (typeof m?.role === "string") return normalizeModelMessage(m);
	if (typeof m?.type === "string" && m.content !== undefined) {
		const role = m.type === "human" ? "user" : m.type === "ai" ? "assistant" : m.type;
		return normalizeModelMessage({ ...m, role, content: m.content });
	}
	return { role: "user", content: JSON.stringify(m) };
}

function stringifyContentPart(part: any): string {
	if (typeof part?.text === "string") return part.text;
	if (typeof part?.value === "string") return part.value;
	if (typeof part === "string") return part;
	return "";
}

function getToolCallInput(part: any): unknown {
	return part?.input ?? part?.args ?? {};
}

function normalizeToolOutput(output: any): unknown {
	if (output && typeof output === "object" && typeof output.type === "string") {
		return output;
	}
	if (typeof output === "string") {
		return { type: "text", value: output };
	}
	return { type: "json", value: output ?? null };
}

function normalizeModelMessage(m: any): Record<string, any> {
	if (m.role === "assistant") {
		const content = Array.isArray(m.content) ? m.content : [
			...(m.reasoning ? [{ type: "reasoning", text: m.reasoning }] : []),
			...(m.content ? [{ type: "text", text: String(m.content) }] : []),
			...(Array.isArray(m.toolCalls) ? m.toolCalls.map((tc: any) => ({
				type: "tool-call",
				toolCallId: tc.id ?? tc.toolCallId ?? tc.tool_call_id ?? "",
				toolName: tc.name ?? tc.toolName ?? "",
				input: tc.args ?? tc.input ?? {},
			})) : []),
		];
		return {
			role: "assistant",
			content: content.map((part: any) => {
				if (part?.type === "text") return { ...part, text: stringifyContentPart(part) };
				if (part?.type === "reasoning") return { ...part, text: stringifyContentPart(part) };
				if (part?.type === "tool-call") {
					return {
						...part,
						toolCallId: part.toolCallId ?? part.id ?? "",
						toolName: part.toolName ?? part.name ?? "",
						input: getToolCallInput(part),
					};
				}
				if (part?.type === "tool-result" || part?.type === "tool-error") {
					return {
						...part,
						toolCallId: part.toolCallId ?? "",
						toolName: part.toolName ?? "",
						...(part.input !== undefined || part.args !== undefined ? { input: getToolCallInput(part) } : {}),
						...(part.output !== undefined ? { output: normalizeToolOutput(part.output) } : {}),
					};
				}
				return part;
			}),
		};
	}
	if (m.role === "tool") {
		const content = Array.isArray(m.content)
			? m.content
			: [{
				type: "tool-result",
				toolCallId: m.toolCallId ?? m.tool_call_id ?? "",
				toolName: m.toolName ?? m.name ?? "",
				output: normalizeToolOutput(m.result ?? m.content ?? ""),
			}];
		return {
			role: "tool",
			content: content.map((part: any) => ({
				...part,
				type: part?.type ?? "tool-result",
				toolCallId: part?.toolCallId ?? m.toolCallId ?? m.tool_call_id ?? "",
				toolName: part?.toolName ?? m.toolName ?? m.name ?? "",
				...(part?.input !== undefined || part?.args !== undefined ? { input: getToolCallInput(part) } : {}),
				output: normalizeToolOutput(part?.output ?? part?.result ?? ""),
			})),
		};
	}
	return m;
}

function toStoredMessages(messages: ModelMessage[]): Record<string, any>[] {
	return messages.map((m) => normalizeModelMessage(m));
}

function toModelMessages(msgs: Record<string, any>[]): ModelMessage[] {
	return msgs.map((m) => {
		if (m.role === "assistant") {
			return normalizeModelMessage(m) as ModelMessage;
		}
		if (m.role === "tool") {
			return normalizeModelMessage(m) as ModelMessage;
		}
		return m as ModelMessage;
	});
}

function stableStringify(value: unknown): string {
	if (value === undefined) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function messagesEqual(a: Record<string, any>, b: Record<string, any>): boolean {
	return stableStringify(a) === stableStringify(b);
}

function responseIncludesHistory(
	history: Record<string, any>[],
	response: Record<string, any>[],
): boolean {
	if (response.length < history.length) return false;
	for (let i = 0; i < history.length; i++) {
		if (!messagesEqual(history[i], response[i])) return false;
	}
	return true;
}

function mergeResponseMessages(
	historyMessages: ModelMessage[],
	responseMessages: ModelMessage[],
): Record<string, any>[] {
	const history = toStoredMessages(historyMessages);
	const response = toStoredMessages(responseMessages);
	if (responseIncludesHistory(history, response)) return response;
	return [...history, ...response];
}

async function nextWithTimeout<T>(
	iterator: AsyncIterator<T>,
	timeoutMs: number,
): Promise<IteratorResult<T>> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			iterator.next(),
			new Promise<IteratorResult<T>>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Stream idle timeout: no data received for ${Math.round(timeoutMs / 1000)}s`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function mergeState(
	savedState: Record<string, any> | null,
	inputMsgStr?: string,
): { messages: Record<string, any>[]; compaction?: any; todos?: TodoList } {
	let messages: Record<string, any>[] = [];

	const compaction = savedState?.compaction ? { ...savedState.compaction } : undefined;
	if (compaction?.summary) {
		messages.push({ role: "system", content: `[Conversation summary from earlier turns]\n${compaction.summary}` });
	}

	const todos: TodoList | undefined = savedState?.todos;
	if (todos && todos.items.length > 0) {
		const statusIcon = (s: string) => s === "completed" ? "✅" : s === "in_progress" ? "🔄" : "⬜";
		const lines = todos.items.map((item) => `- ${statusIcon(item.status)} [${item.status}] ${item.content}`);
		messages.push({ role: "system", content: `[Current task plan]\nGoal: ${todos.goal}\n${lines.join("\n")}` });
	}

	if (savedState?.messages && Array.isArray(savedState.messages)) {
		for (const m of savedState.messages) {
			messages.push(normalizeToCanonical(m));
		}
	}
	if (inputMsgStr) {
		messages.push({ role: "user", content: inputMsgStr });
	}

	return { messages, compaction, todos };
}

/* ── Agent stream ──────────────────────────────────────────────────── */

interface RunAgentStreamParams {
	setup: AgentSetup;
	input: { messages: Record<string, any>[]; compaction?: any; todos?: TodoList };
	signal?: AbortSignal;
	recursionLimit?: number;
	existingToolUIEvents?: ToolUIEvent[];
	onUiEvent?: (event: AgentStreamUiEvent) => void;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	if (!error || typeof error !== "object") return false;
	const name = "name" in error ? (error as { name?: unknown }).name : undefined;
	return name === "AbortError";
}

export async function runAgentStream({
	setup,
	input,
	signal,
	recursionLimit = 25,
	existingToolUIEvents = [],
	onUiEvent,
}: RunAgentStreamParams): Promise<RunAgentStreamResult> {
	const parserState = createParserState(input as AgentState, existingToolUIEvents);

	let streamReasoningBuffer = "";
	let aborted = false;
	let error: unknown;
	let activeAssistantParts: any[] = [];
	let activeToolMessages: Record<string, any>[] = [];
	let responseCompleted = false;
	let persistedMessages: Record<string, any>[] = Array.isArray(input.messages)
		? input.messages.filter((m) => m.role !== "system").map((m) => ({ ...m }))
		: [];

	try {
		// Extract system messages for system prompt, keep non-system as CoreMessages
		const systemMessages = input.messages.filter((m) => m.role === "system");
		const nonSystemMessages = input.messages.filter((m) => m.role !== "system");
		const fullSystemPrompt = [
			setup.systemPrompt,
			...systemMessages.map((m) => m.content as string),
		].filter(Boolean).join("\n\n");

		let messages = toModelMessages(nonSystemMessages);

		const IDLE_TIMEOUT_MS = 120_000;

		// Manual agent loop — each iteration is one LLM step
		for (let step = 0; step < recursionLimit; step++) {
			if (signal?.aborted) break;

			const stepEventBuffer: string[] = [];
			activeAssistantParts = [];
			activeToolMessages = [];
			responseCompleted = false;
			const toolContext: ToolContext = {
				writer: (data: string) => { stepEventBuffer.push(data); },
			};

			const result = streamText({
				model: setup.model,
				system: fullSystemPrompt,
				messages,
				tools: setup.tools,
				maxSteps: 1,
				abortSignal: signal,
				experimental_context: toolContext,
				...(setup.providerOptions ? { providerOptions: setup.providerOptions } : {}),
			});

			const streamIterator = result.fullStream[Symbol.asyncIterator]();
			while (true) {
				const next = await nextWithTimeout(streamIterator, IDLE_TIMEOUT_MS);
				if (next.done) break;
				const chunk = next.value;

				if (chunk.type === "text-delta") {
					parserState.contentBuffer += chunk.text;
					const last = activeAssistantParts[activeAssistantParts.length - 1];
					if (last?.type === "text") {
						last.text += chunk.text;
					} else {
						activeAssistantParts.push({ type: "text", text: chunk.text });
					}
					onUiEvent?.({ type: "text_delta", text: chunk.text });
				} else if (chunk.type === "reasoning-delta") {
					const delta = normalizeReasoningDelta(streamReasoningBuffer, chunk.text);
					if (delta) {
						streamReasoningBuffer += delta;
						parserState.reasoningBuffer += delta;
						const last = activeAssistantParts[activeAssistantParts.length - 1];
						if (last?.type === "reasoning") {
							last.text += delta;
						} else {
							activeAssistantParts.push({ type: "reasoning", text: delta });
						}
						onUiEvent?.({ type: "reasoning_delta", text: streamReasoningBuffer });
					}
				} else if (chunk.type === "tool-call") {
					const dedupeKey = `id:${chunk.toolCallId}`;
					if (parserState.seenToolCallKeys.includes(dedupeKey)) continue;
					parserState.seenToolCallKeys.push(dedupeKey);

					parserState.lastToolCallIndex += 1;
					parserState.toolCallMap[chunk.toolCallId] = {
						index: parserState.lastToolCallIndex,
						name: chunk.toolName,
					};
					activeAssistantParts.push({
						type: "tool-call",
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						input: chunk.input ?? {},
					});

					onUiEvent?.({
						type: "tool_call_start",
						toolName: chunk.toolName,
						toolCallIndex: parserState.lastToolCallIndex,
						toolCallId: chunk.toolCallId,
						args: chunk.input,
					});

				} else if (chunk.type === "tool-result") {
					const resultStr = typeof chunk.output === "string" ? chunk.output : JSON.stringify(chunk.output);
					const mapped = parserState.toolCallMap[chunk.toolCallId];
					activeToolMessages.push({
						role: "tool",
						content: [{
							type: "tool-result",
							toolCallId: chunk.toolCallId,
							toolName: chunk.toolName ?? mapped?.name ?? "",
							output: normalizeToolOutput(chunk.output),
						}],
					});
					onUiEvent?.({ type: "tool_result", toolCallId: chunk.toolCallId, result: resultStr });
				}
			}

			// Process tool UI events collected via writer during tool execution
			for (const raw of stepEventBuffer) {
				const parsed = (() => { try { return JSON.parse(raw); } catch { return null; } })();
				if (parsed?.__tool_type === "write_todos" && parsed.todos) {
					parserState.inputState.todos = parsed.todos;
					if (parserState.currentState) parserState.currentState.todos = parsed.todos;
					onUiEvent?.({ type: "todos_update", todos: parsed.todos });
				}

				const event = normalizeToolUIEvent(raw, parserState.lastToolCallIndex);
				if (event.toolCallId && parserState.toolCallMap[event.toolCallId]) {
					const mapped = parserState.toolCallMap[event.toolCallId];
					event.toolCallIndex = mapped.index;
					event.toolName = event.toolName || mapped.name;
				}
				parserState.toolUIEvents.push(event);
				onUiEvent?.({ type: "tool_ui", event });
			}

			const response = await result.response;
			persistedMessages = mergeResponseMessages(messages, response.messages);
			messages = toModelMessages(persistedMessages);
			responseCompleted = true;

			// Check if any tool calls were made — if not, agent is done
			const toolCalls = await result.toolCalls;
			if (toolCalls.length === 0) break;

			// Reset per-step buffers
			parserState.contentBuffer = "";
			parserState.reasoningBuffer = "";
			streamReasoningBuffer = "";
			activeAssistantParts = [];
			activeToolMessages = [];
		}
	} catch (err) {
		aborted = isAbortError(err, signal);
		if (!aborted) {
			error = err;
		}
	}

	if (!responseCompleted && (activeAssistantParts.length || activeToolMessages.length)) {
		persistedMessages = [
			...persistedMessages,
			...(activeAssistantParts.length ? [{ role: "assistant", content: activeAssistantParts }] : []),
			...activeToolMessages,
		];
	}

	// Build final state
	const source: AgentState = {
		...(parserState.currentState ?? parserState.inputState),
		messages: persistedMessages,
	};
	delete source.messagesUi;
	delete source.toolUIEvents;
	source.compaction = (input as AgentState).compaction;
	source.todos = parserState.currentState?.todos ?? parserState.inputState.todos ?? (input as AgentState).todos;

	return {
		lastState: source,
		aborted,
		completed: !aborted && !error,
		error,
	};
}
