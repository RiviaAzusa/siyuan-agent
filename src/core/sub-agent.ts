import { HumanMessage } from "@langchain/core/messages";
import { tool, type StructuredToolInterface, type ToolRuntime } from "@langchain/core/tools";
import type { ZodTypeAny } from "zod";
import { makeAgent } from "./agent";
import { resolveSubAgentModelConfig, type AgentConfig, type ModelConfig } from "../types";
import { defaultTranslator, type Translator } from "../i18n";

type AgentLike = {
	invoke: (input: { messages: HumanMessage[] }, options?: Record<string, unknown>) => Promise<any>;
};

type ToolsetResolver = StructuredToolInterface[] | (() => StructuredToolInterface[]);

type CreateAgentFn = (
	config: AgentConfig,
	tools: StructuredToolInterface[],
	extraSystemPrompt?: string | null,
	modelOverride?: ModelConfig | null,
	i18n?: Translator,
) => Promise<AgentLike>;

export interface SubAgentToolOptions<TSchema extends ZodTypeAny = ZodTypeAny> {
	name: string;
	description: string;
	schema: TSchema;
	toolset: ToolsetResolver;
	systemPrompt: string;
	getAgentConfig: () => AgentConfig | Promise<AgentConfig>;
	extractResult?: (result: any) => string;
	recursionLimit?: number;
	createAgent?: CreateAgentFn;
	i18n?: Translator;
}

function resolveToolset(toolset: ToolsetResolver): StructuredToolInterface[] {
	return typeof toolset === "function" ? toolset() : toolset;
}

function getMessageType(message: any): string {
	if (typeof message?._getType === "function") return message._getType();
	if (message?.lc === 1 && Array.isArray(message.id)) {
		const className = message.id[message.id.length - 1] as string;
		if (className === "AIMessage" || className === "AIMessageChunk") return "ai";
		if (className === "HumanMessage") return "human";
		if (className === "ToolMessage") return "tool";
	}
	return String(message?.type ?? message?.role ?? "");
}

function getMessageContent(message: any): string | null {
	const content = message?.kwargs?.content ?? message?.content;
	return typeof content === "string" ? content : null;
}

function inputToPrompt(input: unknown): string {
	if (input && typeof input === "object" && "query" in input) {
		const query = (input as { query?: unknown }).query;
		if (typeof query === "string") return query;
	}
	if (typeof input === "string") return input;
	return JSON.stringify(input, null, 2);
}

export function extractLastAiMessageContent(result: any): string {
	const messages = Array.isArray(result?.messages) ? result.messages : [];
	for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
		if (getMessageType(messages[idx]) !== "ai") continue;
		const content = getMessageContent(messages[idx]);
		if (content !== null) return content;
	}
	return defaultTranslator.t("subAgent.noFinal");
}

export async function invokeSubAgent<TSchema extends ZodTypeAny>(
	options: SubAgentToolOptions<TSchema>,
	input: unknown,
	runtime: ToolRuntime,
): Promise<string> {
	const extractResult = options.extractResult ?? extractLastAiMessageContent;
	const createChildAgent = options.createAgent ?? makeAgent;
	const recursionLimit = options.recursionLimit ?? 12;
	const config = await options.getAgentConfig();
	const subAgentModel = resolveSubAgentModelConfig(config);
	const childTools = resolveToolset(options.toolset)
		.filter((toolDef) => toolDef.name !== options.name);
	const i18n = options.i18n || defaultTranslator;
	const childAgent = options.i18n
		? await createChildAgent(config, childTools, options.systemPrompt, subAgentModel, i18n)
		: await createChildAgent(config, childTools, options.systemPrompt, subAgentModel);
	const prompt = inputToPrompt(input);
	const invokeOptions: Record<string, unknown> = {
		recursionLimit,
		signal: runtime.signal,
	};
	if (runtime.context !== undefined) {
		invokeOptions.context = runtime.context;
	}
	if (runtime.config?.callbacks) {
		invokeOptions.callbacks = runtime.config.callbacks;
	}
	const result = await childAgent.invoke({
		messages: [new HumanMessage({ content: prompt })],
	}, invokeOptions);
	const text = extractResult(result);
	// Guard against empty or excessively long sub-agent output
	if (!text || !text.trim()) return i18n.t("subAgent.noResult");
	if (text.length > 8000) return text.slice(0, 8000) + i18n.t("subAgent.truncated");
	return text;
}

export async function invokeSubAgentSafe<TSchema extends ZodTypeAny>(
	options: SubAgentToolOptions<TSchema>,
	input: unknown,
	runtime: ToolRuntime,
): Promise<string> {
	try {
		return await invokeSubAgent(options, input, runtime);
	} catch (err: any) {
		const msg = err instanceof Error ? err.message : String(err);
		// Don't propagate abort errors as tool results
		if (err?.name === "AbortError" || msg.includes("abort")) throw err;
		return (options.i18n || defaultTranslator).t("subAgent.failed", { error: msg });
	}
}

export function createSubAgentTool<TSchema extends ZodTypeAny>(
	options: SubAgentToolOptions<TSchema>,
): StructuredToolInterface {
	return tool(
		async (input: unknown, runtime: ToolRuntime) => invokeSubAgentSafe(options, input, runtime),
		{
			name: options.name,
			description: options.description,
			schema: options.schema,
		},
	);
}
