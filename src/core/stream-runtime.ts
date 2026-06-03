import { streamText } from "ai";
import type { ModelMessage } from "ai";
import type {
	AgentRunMeta,
	AgentState,
	AgentStreamUiEvent,
	ChunkParserState,
	RunAgentStreamResult,
	TodoList,
} from "../types";
import type { ToolContext } from "./tool-types";
import type { AgentSetup } from "./agent";

function normalizeReasoningDelta(current: string, incoming: string): string {
	if (!incoming) return "";
	if (incoming.startsWith(current)) {
		return incoming.slice(current.length);
	}
	return incoming;
}

function createParserState(inputState: AgentState): ChunkParserState {
	return {
		inputState: {
			...inputState,
			messages: Array.isArray(inputState.messages) ? [...inputState.messages] : inputState.messages,
			compaction: inputState.compaction ? { ...inputState.compaction } : inputState.compaction,
			todos: inputState.todos ? { ...inputState.todos, items: [...inputState.todos.items] } : inputState.todos,
		},
		contentBuffer: "",
		reasoningBuffer: "",
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

function stringifyToolOutput(output: unknown): string {
	if (typeof output === "string") return output;
	if (output && typeof output === "object" && (output as any).type === "text" && typeof (output as any).value === "string") {
		return (output as any).value;
	}
	return JSON.stringify(output);
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
): { messages: Record<string, any>[]; compaction?: any; todos?: TodoList; runMeta?: AgentRunMeta[] } {
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

	const runMeta = Array.isArray(savedState?.runMeta) ? [...savedState.runMeta] : undefined;
	return { messages, compaction, todos, runMeta };
}

/* ── Agent stream ──────────────────────────────────────────────────── */

interface RunAgentStreamParams {
	setup: AgentSetup;
	input: { messages: Record<string, any>[]; compaction?: any; todos?: TodoList; runMeta?: AgentRunMeta[] };
	signal?: AbortSignal;
	recursionLimit?: number;
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
	onUiEvent,
}: RunAgentStreamParams): Promise<RunAgentStreamResult> {
	const runStartedAt = Date.now();
	const parserState = createParserState(input as AgentState);

	let streamReasoningBuffer = "";
	let aborted = false;
	let error: unknown;
	let runtimeTodos: TodoList | undefined = input.todos;
	let activeAssistantParts: any[] = [];
	let activeToolMessages: Record<string, any>[] = [];
	let responseCompleted = false;
	let persistedMessages: Record<string, any>[] = Array.isArray(input.messages)
		? input.messages.filter((m) => m.role !== "system").map((m) => ({ ...m }))
		: [];
	const userMessageIndex = persistedMessages.filter((m) => m.role === "user").length - 1;

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

			activeAssistantParts = [];
			activeToolMessages = [];
			responseCompleted = false;
			const toolContext: ToolContext = {
				setTodos: (todos) => {
					runtimeTodos = todos;
					parserState.inputState.todos = todos;
					onUiEvent?.({ type: "todos_update", todos });
				},
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
					const resultStr = stringifyToolOutput(chunk.output);
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
					onUiEvent?.({ type: "tool_result", toolCallId: chunk.toolCallId, toolName: chunk.toolName ?? mapped?.name ?? "", result: resultStr });
				}
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
	const runFinishedAt = Date.now();
	const runMeta: AgentRunMeta = {
		userMessageIndex: Math.max(0, userMessageIndex),
		startedAt: runStartedAt,
		finishedAt: runFinishedAt,
		durationMs: Math.max(0, runFinishedAt - runStartedAt),
		status: aborted ? "aborted" : error ? "error" : "success",
	};
	const source: AgentState = {
		...parserState.inputState,
		messages: persistedMessages,
	};
	source.compaction = (input as AgentState).compaction;
	source.todos = runtimeTodos;
	const previousRunMeta = Array.isArray((input as AgentState).runMeta) ? (input as AgentState).runMeta : [];
	source.runMeta = [
		...previousRunMeta.filter((meta) => meta?.userMessageIndex !== runMeta.userMessageIndex),
		runMeta,
	];

	return {
		lastState: source,
		aborted,
		completed: !aborted && !error,
		error,
	};
}
