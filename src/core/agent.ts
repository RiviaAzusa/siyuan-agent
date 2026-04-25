import { createAgent, summarizationMiddleware } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { Client } from "langsmith";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { buildSystemPrompt, resolveModelConfig, type AgentConfig, type ModelConfig } from "../types";
import { defaultTranslator, type Translator } from "../i18n";

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

export async function makeAgent(
	config: AgentConfig,
	tools: StructuredToolInterface[],
	extraSystemPrompt?: string | null,
	modelOverride?: ModelConfig | null,
	i18n: Translator = defaultTranslator,
) {
	const mc = modelOverride || resolveModelConfig(config);
	const model = new ChatOpenAI({
		model: mc.model,
		temperature: mc.temperature ?? 0,
		streaming: true,
		apiKey: mc.apiKey,
		configuration: {
			dangerouslyAllowBrowser: true,
			baseURL: mc.apiBaseURL,
		},
	});

	let systemPrompt = buildSystemPrompt(i18n);
	if (config.guideDoc?.id) {
		const guideContent = await fetchGuideDoc(config.guideDoc.id);
		if (guideContent) {
			systemPrompt += `\n\n---\n${i18n.t("agent.guideDocHeader")}\n${guideContent}\n---`;
		}
	}
	if (config.defaultNotebook?.id) {
		systemPrompt += `\n\n${i18n.t("agent.defaultNotebook", {
			name: config.defaultNotebook.name,
			id: config.defaultNotebook.id,
		})}`;
	}
	if (config.customInstructions?.trim()) {
		systemPrompt += `\n\n${i18n.t("agent.customInstructions", {
			instructions: config.customInstructions.trim(),
		})}`;
	}
	if (extraSystemPrompt) {
		systemPrompt += `\n\n${extraSystemPrompt}`;
	}

	const middleware = [
		summarizationMiddleware({
			model,
			trigger: { messages: 30 },
			keep: { messages: 12 },
		}),
	] as const;

	return createAgent({
		model,
		tools,
		systemPrompt,
		middleware,
	});
}

export function makeTracer(config: AgentConfig): LangChainTracer | null {
	if (!config.langSmithEnabled || !config.langSmithApiKey) return null;

	const client = new Client({
		apiKey: config.langSmithApiKey,
		apiUrl: config.langSmithEndpoint || "https://api.smith.langchain.com",
	});

	return new LangChainTracer({
		projectName: config.langSmithProject || "SiYuan-Agent",
		client,
	});
}
