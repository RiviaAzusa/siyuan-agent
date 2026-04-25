import {
	AIMessage,
	HumanMessage,
	SystemMessage,
	ToolMessage,
	type BaseMessage,
} from "@langchain/core/messages";
import type {
	AgentState,
	AgentStreamUiEvent,
	ChunkParserState,
	RunAgentStreamResult,
	TodoList,
	ToolUIEvent,
	ToolUIEventPayload,
	UiMessage,
} from "../types";
import { UiMessageBuilder, ensureMessagesUi } from "./ui-message-builder";

function genId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function messageFromDict(raw: Record<string, any>): BaseMessage {
	if (raw.lc === 1 && raw.type === "constructor" && Array.isArray(raw.id)) {
		const className = raw.id[raw.id.length - 1] as string;
		const kwargs = raw.kwargs ?? {};
		if (className === "HumanMessage") return new HumanMessage(kwargs);
		if (className === "AIMessage") return new AIMessage(kwargs);
		if (className === "AIMessageChunk") return new AIMessage(kwargs);
		if (className === "SystemMessage") return new SystemMessage(kwargs);
		if (className === "ToolMessage") return new ToolMessage({ tool_call_id: "", ...kwargs });
		throw new Error(`Unknown LangChain message class: ${className}`);
	}

	const { type, ...rest } = raw;
	if (type === "human" || type === "user") return new HumanMessage(rest);
	if (type === "ai" || type === "assistant") return new AIMessage(rest);
	if (type === "system") return new SystemMessage(rest);
	if (type === "tool") return new ToolMessage({ tool_call_id: "", ...rest });
	throw new Error(`Unknown message type: ${type}`);
}

function messagesFromDict(messages: Record<string, any>[]): BaseMessage[] {
	return messages.map(messageFromDict);
}

function cloneState(source: AgentState | null | undefined): AgentState {
	if (!source) return {};
	return {
		...source,
		messages: Array.isArray(source.messages) ? [...source.messages] : source.messages,
		messagesUi: Array.isArray(source.messagesUi) ? [...source.messagesUi] : source.messagesUi,
		compaction: source.compaction ? { ...source.compaction } : source.compaction,
		todos: source.todos ? { ...source.todos, items: [...source.todos.items] } : source.todos,
		toolUIEvents: Array.isArray(source.toolUIEvents) ? [...source.toolUIEvents] : source.toolUIEvents,
	};
}

function getMessageType(message: any): string {
	if (typeof message?._getType === "function") return message._getType();
	if (message?.lc === 1 && Array.isArray(message.id)) {
		const className = message.id[message.id.length - 1] as string;
		if (className === "HumanMessage") return "human";
		if (className === "AIMessage" || className === "AIMessageChunk") return "ai";
		if (className === "SystemMessage") return "system";
		if (className === "ToolMessage") return "tool";
	}
	return message?.type ?? message?.role ?? message?.constructor?.name ?? "";
}

function getMessageContent(message: any): string {
	const content = message?.kwargs?.content ?? message?.content;
	return typeof content === "string" ? content : "";
}

function getMessageReasoning(message: any): string {
	const reasoning = message?.kwargs?.additional_kwargs?.reasoning_content
		?? message?.additional_kwargs?.reasoning_content;
	return typeof reasoning === "string" ? reasoning : "";
}

function getMessageToolCallId(message: any): string {
	const toolCallId = message?.kwargs?.tool_call_id ?? message?.tool_call_id;
	return typeof toolCallId === "string" ? toolCallId : "";
}

function getMessageToolCalls(message: any): any[] {
	const toolCalls = message?.kwargs?.tool_calls ?? message?.tool_calls;
	return Array.isArray(toolCalls) ? toolCalls : [];
}

function getToolCallId(raw: Record<string, any>): string {
	const toolCallId = raw?.id ?? raw?.tool_call_id;
	return typeof toolCallId === "string" ? toolCallId : "";
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
		inputState: cloneState(inputState),
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

function resolveToolCallStartKey(toolCallChunk: Record<string, any>): string | null {
	if (typeof toolCallChunk?.id === "string" && toolCallChunk.id)
		return `id:${toolCallChunk.id}`;
	if (typeof toolCallChunk?.index === "number" && typeof toolCallChunk?.name === "string" && toolCallChunk.name)
		return `index:${toolCallChunk.index}:${toolCallChunk.name}`;
	if (typeof toolCallChunk?.name === "string" && toolCallChunk.name)
		return `name:${toolCallChunk.name}:${JSON.stringify(toolCallChunk.args ?? null)}`;
	return null;
}

function createPendingAiMessage(
	content: string,
	reasoning: string,
	toolCalls: any[],
	options: { allowToolOnly: boolean },
): AIMessage | null {
	if (!content && !reasoning && (!options.allowToolOnly || toolCalls.length === 0))
		return null;

	const additionalKwargs = reasoning
		? { reasoning_content: reasoning }
		: undefined;
	return new AIMessage({
		content,
		additional_kwargs: additionalKwargs,
		tool_calls: toolCalls.length ? [...toolCalls] : undefined,
	});
}

/**
 * Build a serialised AI message dict suitable for `messagesUi`.
 * This mirrors the LangChain serialisation format so the UI can render
 * it identically to a persisted message.
 */
function buildCurrentAiDict(
	content: string,
	reasoning: string,
	toolCalls: any[],
): Record<string, any> | null {
	if (!content && !reasoning && toolCalls.length === 0) return null;
	const kwargs: Record<string, any> = { content };
	if (reasoning) {
		kwargs.additional_kwargs = { reasoning_content: reasoning };
	}
	if (toolCalls.length > 0) {
		kwargs.tool_calls = [...toolCalls];
	}
	return {
		lc: 1,
		type: "constructor",
		id: ["langchain_core", "messages", "AIMessage"],
		kwargs,
	};
}

function shouldAppendRecoveredMessage(messages: any[], message: any): boolean {
	const lastMessage = messages[messages.length - 1];
	if (!lastMessage) return true;

	const lastType = getMessageType(lastMessage);
	const nextType = getMessageType(message);
	if (lastType !== nextType) return true;

	if (nextType === "ai") {
		if (getMessageContent(lastMessage) !== getMessageContent(message)) return true;
		if (getMessageReasoning(lastMessage) !== getMessageReasoning(message)) return true;
		// Compare tool calls by IDs rather than full JSON serialization
		const lastCalls = getMessageToolCalls(lastMessage);
		const nextCalls = getMessageToolCalls(message);
		if (lastCalls.length !== nextCalls.length) return true;
		return lastCalls.some((lc: any, i: number) => lc?.id !== nextCalls[i]?.id || lc?.name !== nextCalls[i]?.name);
	}

	if (nextType === "tool") {
		return getMessageContent(lastMessage) !== getMessageContent(message)
			|| getMessageToolCallId(lastMessage) !== getMessageToolCallId(message);
	}

	return true;
}

function flushCurrentAiTurn(
	parserState: ChunkParserState,
	options: { allowToolOnly: boolean },
): void {
	const message = createPendingAiMessage(
		parserState.contentBuffer,
		parserState.reasoningBuffer,
		parserState.pendingToolCalls,
		options,
	);
	if (message) {
		parserState.pendingMessages.push(message);
	}
	parserState.contentBuffer = "";
	parserState.reasoningBuffer = "";
	parserState.pendingToolCalls = [];
}

function resetPendingRecovery(parserState: ChunkParserState): void {
	parserState.pendingMessages = [];
	parserState.contentBuffer = "";
	parserState.reasoningBuffer = "";
	parserState.pendingToolCalls = [];
}

export function mergeState(
	savedState: Record<string, any> | null,
	inputMsgStr?: string,
): { messages: BaseMessage[]; messagesUi?: UiMessage[]; compaction?: any; todos?: TodoList } {
	let messages: BaseMessage[] = [];

	/* Inject compaction summary as a leading system message so the LLM
	   retains context from compressed turns. */
	const compaction = savedState?.compaction ? { ...savedState.compaction } : undefined;
	if (compaction?.summary) {
		messages.push(new SystemMessage({
			content: `[Conversation summary from earlier turns]\n${compaction.summary}`,
		}));
	}

	/* Inject todos as pinned context so the LLM never loses track of its plan */
	const todos: TodoList | undefined = savedState?.todos;
	if (todos && todos.items.length > 0) {
		const statusIcon = (s: string) => s === "completed" ? "✅" : s === "in_progress" ? "🔄" : "⬜";
		const lines = todos.items.map((item) => `- ${statusIcon(item.status)} [${item.status}] ${item.content}`);
		messages.push(new SystemMessage({
			content: `[Current task plan]\nGoal: ${todos.goal}\n${lines.join("\n")}`,
		}));
	}

	if (savedState?.messages && Array.isArray(savedState.messages)) {
		messages = messages.concat(messagesFromDict(savedState.messages));
	}
	const humanMsg = inputMsgStr ? new HumanMessage({ content: inputMsgStr }) : null;
	if (humanMsg) {
		messages.push(humanMsg);
	}

	const messagesUi = Array.isArray(savedState?.messagesUi) ? [...savedState!.messagesUi] : undefined;
	return { messages, messagesUi, compaction, todos };
}

export function buildRecoverableState(parserState: ChunkParserState): AgentState {
	const source = cloneState(parserState.currentState ?? parserState.inputState);
	const fallbackMessages = Array.isArray(parserState.inputState.messages) ? [...parserState.inputState.messages] : [];
	const messages = Array.isArray(source.messages) ? [...source.messages] : fallbackMessages;

	for (const message of parserState.pendingMessages) {
		if (shouldAppendRecoveredMessage(messages, message)) {
			messages.push(message);
		}
	}

	const pendingAiMessage = createPendingAiMessage(
		parserState.contentBuffer,
		parserState.reasoningBuffer,
		parserState.pendingToolCalls,
		{ allowToolOnly: false },
	);
	if (pendingAiMessage && shouldAppendRecoveredMessage(messages, pendingAiMessage)) {
		messages.push(pendingAiMessage);
	}

	source.messages = messages;
	return source;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	if (!error || typeof error !== "object") return false;
	const name = "name" in error ? (error as { name?: unknown }).name : undefined;
	return name === "AbortError";
}

interface RunAgentStreamParams {
	agent: {
		stream: (input: unknown, options: Record<string, any>) => Promise<AsyncIterable<[string, any]>>;
	};
	input: { messages: BaseMessage[]; messagesUi?: UiMessage[]; compaction?: any; todos?: TodoList };
	signal?: AbortSignal;
	callbacks?: unknown[];
	recursionLimit?: number;
	existingToolUIEvents?: ToolUIEvent[];
	onUiEvent?: (event: AgentStreamUiEvent) => void;
}

export async function runAgentStream({
	agent,
	input,
	signal,
	callbacks,
	recursionLimit = 100,
	existingToolUIEvents = [],
	onUiEvent,
}: RunAgentStreamParams): Promise<RunAgentStreamResult> {
	const parserState = createParserState(input as AgentState, existingToolUIEvents);

	/* Initialise UI message builder from existing messagesUi or empty */
	const uiBuilder = Array.isArray(input.messagesUi) && input.messagesUi.length > 0
		? UiMessageBuilder.fromExisting(input.messagesUi)
		: new UiMessageBuilder();

	/* Track the latest serialised AI message dict for the builder */
	let currentAiDict: Record<string, any> | null = null;

	let aborted = false;
	let error: unknown;

	// Per-chunk idle timeout: if no data arrives for 120s, consider it hung
	const IDLE_TIMEOUT_MS = 120_000;

	try {
		const stream = await agent.stream(input, {
			streamMode: ["messages", "values", "custom"],
			recursionLimit,
			callbacks,
			signal,
		});

		let idleTimer: ReturnType<typeof setTimeout> | null = null;
		const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };

		const streamWithTimeout = async function* () {
			const iter = stream[Symbol.asyncIterator]();
			while (true) {
				const chunkPromise = iter.next();
				const timeoutPromise = new Promise<never>((_, reject) => {
					idleTimer = setTimeout(() => reject(new Error("Stream idle timeout: no data received for 120s")), IDLE_TIMEOUT_MS);
				});
				try {
					const result = await Promise.race([chunkPromise, timeoutPromise]);
					clearIdle();
					if (result.done) break;
					yield result.value;
				} catch (e) {
					clearIdle();
					throw e;
				}
			}
		};

		for await (const [streamType, data] of streamWithTimeout()) {
			if (streamType === "messages") {
				const [message] = data as [any, any];
				const messageType = getMessageType(message);

				if (messageType === "ai" || messageType === "AIMessageChunk") {
					const reasoning = getMessageReasoning(message);
					if (reasoning) {
						parserState.reasoningBuffer += reasoning;
						onUiEvent?.({
							type: "reasoning_delta",
							text: reasoning,
						});
					}

					const textContent = getMessageContent(message);
					if (textContent) {
						parserState.contentBuffer += textContent;
						onUiEvent?.({
							type: "text_delta",
							text: textContent,
						});
					}

					const toolCallChunks = Array.isArray(message?.tool_call_chunks) ? message.tool_call_chunks : [];
					const newToolCallIds: string[] = [];
					for (const toolCallChunk of toolCallChunks) {
						if (!toolCallChunk?.name) continue;
						const dedupeKey = resolveToolCallStartKey(toolCallChunk);
						if (dedupeKey && parserState.seenToolCallKeys.includes(dedupeKey)) continue;
						if (dedupeKey) parserState.seenToolCallKeys.push(dedupeKey);

						parserState.lastToolCallIndex += 1;
						parserState.pendingToolCalls.push({
							name: toolCallChunk.name,
							args: toolCallChunk.args,
							id: getToolCallId(toolCallChunk) || undefined,
						});
						const toolCallId = getToolCallId(toolCallChunk);
						if (toolCallId) {
							parserState.toolCallMap[toolCallId] = {
								index: parserState.lastToolCallIndex,
								name: toolCallChunk.name,
							};
							newToolCallIds.push(toolCallId);
						}
						onUiEvent?.({
							type: "tool_call_start",
							toolName: toolCallChunk.name,
							toolCallIndex: parserState.lastToolCallIndex,
							toolCallId: toolCallId || undefined,
							args: toolCallChunk.args,
						});
					}

					/* Update AI dict BEFORE creating ToolMessageUi entries
					   so tool_calls live on the AI message in messagesUi. */
					if (textContent || newToolCallIds.length > 0) {
						currentAiDict = buildCurrentAiDict(
							parserState.contentBuffer,
							parserState.reasoningBuffer,
							parserState.pendingToolCalls,
						);
						if (currentAiDict) {
							uiBuilder.pushOrUpdateAi(currentAiDict);
						}
					}
					for (const tcId of newToolCallIds) {
						const mapped = parserState.toolCallMap[tcId];
						if (!mapped) continue;
						uiBuilder.onToolCallStart(mapped.name || "unknown", tcId);
					}
				} else if (messageType === "tool" || messageType === "ToolMessage") {
					flushCurrentAiTurn(parserState, { allowToolOnly: true });
					const result = typeof message.content === "string"
						? message.content
						: JSON.stringify(message.content);
					parserState.pendingMessages.push(new ToolMessage({
						content: result,
						tool_call_id: getMessageToolCallId(message),
					}));
					const tcId = getMessageToolCallId(message);
					const isError = typeof message.content === "string"
						&& (/^Error:|^\[(\u5b50\u667a\u80fd\u4f53\u6267\u884c\u5931\u8d25|Sub-agent failed)\]|^ToolError:|"error":/i.test(message.content));
					uiBuilder.onToolResult(tcId, isError);
					onUiEvent?.({
						type: "tool_result",
						toolCallId: tcId || undefined,
						result,
					});
					currentAiDict = null;
				}
			} else if (streamType === "values") {
				parserState.currentState = data as AgentState;
				resetPendingRecovery(parserState);
				currentAiDict = null;
			} else if (streamType === "custom") {
				const raw = typeof data === "string" ? data : JSON.stringify(data);

				/* Intercept write_todos events to persist plan into state */
				let parsed: any = null;
				try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
				if (parsed?.__tool_type === "write_todos" && parsed.todos) {
					const todos = parsed.todos as TodoList;
					parserState.inputState.todos = todos;
					if (parserState.currentState) parserState.currentState.todos = todos;
					onUiEvent?.({ type: "todos_update", todos });
				}

				const event = normalizeToolUIEvent(raw, parserState.lastToolCallIndex);
				if (event.toolCallId && parserState.toolCallMap[event.toolCallId]) {
					const mapped = parserState.toolCallMap[event.toolCallId];
					event.toolCallIndex = mapped.index;
					event.toolName = event.toolName || mapped.name;
				}
				parserState.toolUIEvents.push(event);
				uiBuilder.onToolUiEvent(event);
				onUiEvent?.({
					type: "tool_ui",
					event,
				});
			}
		}
	} catch (err) {
		aborted = isAbortError(err, signal);
		if (!aborted) {
			error = err;
		}
	}

	const lastState = buildRecoverableState(parserState);
	lastState.toolUIEvents = [...parserState.toolUIEvents];
	lastState.messagesUi = uiBuilder.finalise();
	lastState.compaction = (input as AgentState).compaction;
	lastState.todos = parserState.currentState?.todos ?? parserState.inputState.todos ?? (input as AgentState).todos;

	return {
		lastState,
		aborted,
		completed: !aborted && !error,
		error,
	};
}
