import { generateText } from "ai";
import { createTool } from "./tool-types";
import type { Tool } from "@ai-sdk/provider-utils";
import type { ZodTypeAny } from "zod";
import { createModel, buildProviderOptions } from "../llms/ai-sdk-provider";
import { resolveSubAgentModelConfig, type AgentConfig, type ModelConfig } from "../types";
import { defaultTranslator, localizeErrorMessage, type Translator } from "../i18n";

type ToolsetResolver = Tool<any, string>[] | (() => Tool<any, string>[]);

export interface SubAgentToolOptions<TSchema extends ZodTypeAny = ZodTypeAny> {
	name: string;
	description: string;
	schema: TSchema;
	toolset: ToolsetResolver;
	systemPrompt: string;
	getAgentConfig: () => AgentConfig | Promise<AgentConfig>;
	extractResult?: (result: any) => string;
	recursionLimit?: number;
	i18n?: Translator;
}

function resolveToolset(toolset: ToolsetResolver): Tool<any, string>[] {
	return typeof toolset === "function" ? toolset() : toolset;
}

function inputToPrompt(input: unknown): string {
	if (input && typeof input === "object" && "query" in input) {
		const query = (input as { query?: unknown }).query;
		if (typeof query === "string") return query;
	}
	if (typeof input === "string") return input;
	return JSON.stringify(input, null, 2);
}

function extractTextFromResult(result: any): string {
	// AI SDK generateText returns { text, steps, ... }
	if (typeof result?.text === "string" && result.text.trim()) {
		return result.text;
	}
	// Fallback: check steps
	if (Array.isArray(result?.steps)) {
		for (let i = result.steps.length - 1; i >= 0; i--) {
			const step = result.steps[i];
			if (typeof step?.text === "string" && step.text.trim()) {
				return step.text;
			}
		}
	}
	return defaultTranslator.t("subAgent.noFinal");
}

export async function invokeSubAgent<TSchema extends ZodTypeAny>(
	options: SubAgentToolOptions<TSchema>,
	input: unknown,
	abortSignal?: AbortSignal,
): Promise<string> {
	const config = await options.getAgentConfig();
	const subAgentModel = resolveSubAgentModelConfig(config);
	const modelConfig = subAgentModel || config;
	const childTools = resolveToolset(options.toolset)
		.filter((t: any) => t.name !== options.name);
	const i18n = options.i18n || defaultTranslator;
	const prompt = inputToPrompt(input);
	const maxSteps = options.recursionLimit ?? 12;

	// Build tools map for AI SDK
	const toolsMap: Record<string, Tool<any, string>> = {};
	for (const t of childTools) {
		if ((t as any).name) toolsMap[(t as any).name] = t;
	}

	const model = createModel(modelConfig);
	const providerOptions = buildProviderOptions(modelConfig.providerType || "openai-compatible");

	const result = await generateText({
		model,
		system: options.systemPrompt,
		messages: [{ role: "user", content: prompt }],
		tools: toolsMap,
		maxSteps,
		abortSignal,
		...(providerOptions ? { providerOptions } : {}),
	});

	const text = options.extractResult
		? options.extractResult(result)
		: extractTextFromResult(result);

	if (!text || !text.trim()) return i18n.t("subAgent.noResult");
	if (text.length > 8000) return text.slice(0, 8000) + i18n.t("subAgent.truncated");
	return text;
}

export async function invokeSubAgentSafe<TSchema extends ZodTypeAny>(
	options: SubAgentToolOptions<TSchema>,
	input: unknown,
	abortSignal?: AbortSignal,
): Promise<string> {
	try {
		return await invokeSubAgent(options, input, abortSignal);
	} catch (err: any) {
		const i18n = options.i18n || defaultTranslator;
		const msg = localizeErrorMessage(err, i18n);
		if (err?.name === "AbortError" || msg.includes("abort")) throw err;
		return i18n.t("subAgent.failed", { error: msg });
	}
}

export function createSubAgentTool<TSchema extends ZodTypeAny>(
	options: SubAgentToolOptions<TSchema>,
): Tool<any, string> {
	return createTool({
		name: options.name,
		description: options.description,
		parameters: options.schema,
		execute: async (input, opts) => invokeSubAgentSafe(options, input, opts.abortSignal),
	});
}
