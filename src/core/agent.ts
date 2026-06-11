import type { Tool } from "@ai-sdk/provider-utils";
import { buildSystemPrompt, resolveModelConfig, type AgentConfig, type ModelConfig, type ReasoningEffort } from "../types";
import { GUIDE_DOC_HEADER, DEFAULT_NOTEBOOK_TPL, CUSTOM_INSTRUCTIONS_TPL } from "../types";
import { createModel, buildProviderOptions } from "../llms/ai-sdk-provider";

async function fetchGuideDoc(docId: string): Promise<string> {
	try {
		const resp = await fetch("/api/export/exportMdContent", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: docId }),
		});
		const data = await resp.json();
		const content: string = data?.data?.content || "";
		return content.trim();
	} catch {
		return "";
	}
}

export interface AgentSetup {
	model: ReturnType<typeof createModel>;
	tools: Record<string, Tool<any, string>>;
	systemPrompt: string;
	providerOptions?: Record<string, Record<string, unknown>>;
}

export async function prepareAgent(
	config: AgentConfig,
	tools: Tool<any, string>[],
	extraSystemPrompt?: string | null,
	modelOverride?: ModelConfig | null,
	reasoningEffort: ReasoningEffort = "default",
): Promise<AgentSetup> {
	const mc = modelOverride || resolveModelConfig(config);
	const model = createModel(mc, { reasoningEffort });

	let systemPrompt = buildSystemPrompt();
	if (config.guideDoc?.id) {
		const guideContent = await fetchGuideDoc(config.guideDoc.id);
		if (guideContent) {
			systemPrompt += `\n\n---\n${GUIDE_DOC_HEADER}\n${guideContent}\n---`;
		}
	}
	if (config.defaultNotebook?.id) {
		systemPrompt += `\n\n${DEFAULT_NOTEBOOK_TPL
			.replace("{name}", config.defaultNotebook.name)
			.replace("{id}", config.defaultNotebook.id)}`;
	}
	if (config.customInstructions?.trim()) {
		systemPrompt += `\n\n${CUSTOM_INSTRUCTIONS_TPL
			.replace("{instructions}", config.customInstructions.trim())}`;
	}
	if (extraSystemPrompt) {
		systemPrompt += `\n\n${extraSystemPrompt}`;
	}

	// Build tools map
	const toolsMap: Record<string, Tool<any, string>> = {};
	for (const t of tools) {
		if ((t as any).name) toolsMap[(t as any).name] = t;
	}

	const providerOptions = buildProviderOptions(mc.providerType || "openai-compatible", reasoningEffort);

	return { model, tools: toolsMap, systemPrompt, providerOptions };
}
