import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { Client } from "langsmith";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentConfig } from "../types";

export function makeAgent(config: AgentConfig, tools: StructuredToolInterface[]) {
	const model = new ChatOpenAI({
		model: config.model,
		temperature: 0,
		streaming: true,
		apiKey: config.apiKey,
		configuration: {
			dangerouslyAllowBrowser: true,
			baseURL: config.apiBaseURL,
		},
	});

	return createAgent({
		model,
		tools,
		systemPrompt: config.systemPrompt,
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
