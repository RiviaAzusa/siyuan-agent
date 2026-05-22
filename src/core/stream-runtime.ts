import { streamText } from "ai";
import type { CoreMessage } from "ai";
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
			messagesUi: Array.isArray(inputState.messagesUi) ? [...inputState.messagesUi] : inputState.messagesUi,
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
				content: kwargs.content ?? "",
				...(kwargs.additional_kwargs?.reasoning_content ? { reasoning: kwargs.additional_kwargs.reasoning_content } : {}),
				...(Array.isArray(kwargs.tool_calls) && kwargs.tool_calls.length ? { toolCalls: kwargs.tool_calls } : {}),
				...(kwargs.usage_metadata ? { usage: kwargs.usage_metadata } : {}),
			};
		case "SystemMessage":
			return { role: "system", content: kwargs.content ?? "" };
		case "ToolMessage":
			return { role: "tool", toolCallId: kwargs.tool_call_id ?? "", toolName: kwargs.name ?? "", result: kwargs.content ?? "" };
		default:
			return { role: "user", content: JSON.stringify(raw) };
	}
}

function normalizeToSimple(m: any): Record<string, any> {
	if (m?.lc === 1 && m.type === "constructor" && Array.isArray(m.id)) return convertLcMessage(m);
	if (typeof m?.role === "string") return m;
	if (typeof m?.type === "string" && m.content !== undefined) {
		const role = m.type === "human" ? "user" : m.type === "ai" ? "assistant" : m.type;
		return { role, content: m.content, ...m };
	}
	return { role: "user", content: JSON.stringify(m) };
}

export function mergeState(
	savedState: Record<string, any> | null,
	inputMsgStr?: string,
): { messages: Record<string, any>[]; messagesUi?: UiMessage[]; compaction?: any; todos?: TodoList } {
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
			messages.push(normalizeToSimple(m));
		}
	}
	if (inputMsgStr) {
		messages.push({ role: "user", content: inputMsgStr });
	}

	const messagesUi = Array.isArray(savedState?.messagesUi) ? [...savedState!.messagesUi] : undefined;
	return { messages, messagesUi, compaction, todos };
}

/* ── Agent stream ──────────────────────────────────────────────────── */

interface RunAgentStreamParams {
	setup: AgentSetup;
	input: { messages: Record<string, any>[]; messagesUi?: UiMessage[]; compaction?: any; todos?: TodoList };
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

	const uiBuilder = Array.isArray(input.messagesUi) && input.messagesUi.length > 0
		? UiMessageBuilder.fromExisting(input.messagesUi)
		: new UiMessageBuilder();

	let streamReasoningBuffer = "";
	let aborted = false;
	let error: unknown;

	try {
		// Extract system messages for system prompt, keep non-system as CoreMessages
		const systemMessages = input.messages.filter((m) => m.role === "system");
		const nonSystemMessages = input.messages.filter((m) => m.role !== "system");
		const fullSystemPrompt = [
			setup.systemPrompt,
			...systemMessages.map((m) => m.content as string),
		].filter(Boolean).join("\n\n");

		const toCoreMessages = (msgs: Record<string, any>[]): CoreMessage[] =>
			msgs.map((m) => {
				if (m.role === "assistant") {
					const parts: any[] = [];
					if (m.content) parts.push({ type: "text", text: m.content as string });
					if (Array.isArray(m.toolCalls)) {
						for (const tc of m.toolCalls) {
							parts.push({ type: "tool-call", toolCallId: tc.id ?? "", toolName: tc.name ?? "", args: tc.args ?? {} });
						}
					}
					return { role: "assistant" as const, content: parts.length ? parts : (m.content as string || "") };
				}
				// user, tool → pass through
				return m as CoreMessage;
			});

		// Push human message into UI
		const lastMsg = input.messages[input.messages.length - 1];
		if (lastMsg?.role === "user") {
			uiBuilder.pushHuman(lastMsg);
		}

		let messages = toCoreMessages(nonSystemMessages);

		const IDLE_TIMEOUT_MS = 120_000;

		// Manual agent loop — each iteration is one LLM step
		for (let step = 0; step < recursionLimit; step++) {
			if (signal?.aborted) break;

			const stepEventBuffer: string[] = [];
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

			// Consume fullStream with idle timeout
			let idleTimer: ReturnType<typeof setTimeout> | null = null;
			const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };

			let toolCallIndex = 0;

			for await (const chunk of result.fullStream) {
				clearIdle();
				idleTimer = setTimeout(
					() => { throw new Error("Stream idle timeout: no data received for 120s"); },
					IDLE_TIMEOUT_MS,
				);

				if (chunk.type === "text-delta") {
					parserState.contentBuffer += chunk.text;
					onUiEvent?.({ type: "text_delta", text: chunk.text });
				} else if (chunk.type === "reasoning-delta") {
					const delta = normalizeReasoningDelta(streamReasoningBuffer, chunk.text);
					if (delta) {
						streamReasoningBuffer += delta;
						parserState.reasoningBuffer += delta;
						onUiEvent?.({ type: "reasoning_delta", text: streamReasoningBuffer });
					}
				} else if (chunk.type === "tool-call") {
					const dedupeKey = `id:${chunk.toolCallId}`;
					if (parserState.seenToolCallKeys.includes(dedupeKey)) continue;
					parserState.seenToolCallKeys.push(dedupeKey);

					parserState.lastToolCallIndex += 1;
					toolCallIndex++;
					parserState.toolCallMap[chunk.toolCallId] = {
						index: parserState.lastToolCallIndex,
						name: chunk.toolName,
					};

					onUiEvent?.({
						type: "tool_call_start",
						toolName: chunk.toolName,
						toolCallIndex: parserState.lastToolCallIndex,
						toolCallId: chunk.toolCallId,
						args: chunk.input,
					});

					// Update AI message in UI
					const aiDict: Record<string, any> = {
						role: "assistant",
						content: parserState.contentBuffer || "",
					};
					if (parserState.reasoningBuffer) aiDict.reasoning = parserState.reasoningBuffer;
					const pendingCalls = Object.entries(parserState.toolCallMap).map(([id, m]) => ({
						id,
						name: (m as { name?: string }).name ?? "",
						args: {},
					}));
					if (pendingCalls.length) aiDict.toolCalls = pendingCalls;
					uiBuilder.pushOrUpdateAi(aiDict);
					uiBuilder.onToolCallStart(chunk.toolName, chunk.toolCallId);
				} else if (chunk.type === "tool-result") {
					const resultStr = typeof chunk.output === "string" ? chunk.output : JSON.stringify(chunk.output);
					const isError = /^Error:|^\[.*(?:failed|error)\]|^ToolError:|"error":/i.test(resultStr);
					uiBuilder.onToolResult(chunk.toolCallId, isError);
					onUiEvent?.({ type: "tool_result", toolCallId: chunk.toolCallId, result: resultStr });
				}
			}
			clearIdle();

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
				uiBuilder.onToolUiEvent(event);
				onUiEvent?.({ type: "tool_ui", event });
			}

			// Update AI message in UI with final content
			if (parserState.contentBuffer || parserState.reasoningBuffer) {
				const aiDict: Record<string, any> = {
					role: "assistant",
					content: parserState.contentBuffer || "",
				};
				if (parserState.reasoningBuffer) aiDict.reasoning = parserState.reasoningBuffer;
				const calls = Object.entries(parserState.toolCallMap).map(([id, m]) => ({
					id,
					name: (m as { name?: string }).name ?? "",
					args: {},
				}));
				if (calls.length) aiDict.toolCalls = calls;
				uiBuilder.pushOrUpdateAi(aiDict);
			}

			// Check if any tool calls were made — if not, agent is done
			const toolCalls = await result.toolCalls;
			if (toolCalls.length === 0) break;

			// Build tool result messages for next iteration
			const toolResults = await result.toolResults;
			const toolResultMessages: CoreMessage[] = toolResults.map((tr) => ({
				role: "tool" as const,
				content: [{ type: "tool-result" as const, toolCallId: tr.toolCallId, toolName: tr.toolName, result: typeof tr.output === "string" ? tr.output : JSON.stringify(tr.output) }],
			}));

			const response = await result.response;
			messages = [...response.messages, ...toolResultMessages];

			// Reset per-step buffers
			parserState.contentBuffer = "";
			parserState.reasoningBuffer = "";
			streamReasoningBuffer = "";
		}
	} catch (err) {
		aborted = isAbortError(err, signal);
		if (!aborted) {
			error = err;
		}
	}

	// Build final state
	const source: AgentState = {
		...(parserState.currentState ?? parserState.inputState),
		messages: Array.isArray(parserState.inputState.messages) ? [...parserState.inputState.messages] : [],
	};
	source.messagesUi = uiBuilder.finalise();
	source.toolUIEvents = [...parserState.toolUIEvents];
	source.compaction = (input as AgentState).compaction;
	source.todos = parserState.currentState?.todos ?? parserState.inputState.todos ?? (input as AgentState).todos;

	return {
		lastState: source,
		aborted,
		completed: !aborted && !error,
		error,
	};
}
