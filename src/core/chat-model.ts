import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ModelConfig, ReasoningEffort } from "../types";
import { ChatDeepSeek } from "../llms/deepseek";
import { injectReasoningContent } from "../llms/reasoning";

export { injectReasoningContent };

export interface CreateChatModelOptions {
	streaming?: boolean;
	temperature?: number;
	reasoningEffort?: ReasoningEffort;
}

export function getOpenAICompatibleModelKwargs(reasoningEffort: ReasoningEffort = "default"): Record<string, any> {
	if (reasoningEffort === "off") {
		return {
			thinking: { type: "disabled" },
		};
	}
	if (reasoningEffort === "low" || reasoningEffort === "high") {
		return {
			thinking: { type: "enabled" },
		};
	}
	return {};
}

export function createChatModel(
	config: ModelConfig,
	options: CreateChatModelOptions = {},
): BaseChatModel {
	const temperature = options.temperature ?? config.temperature ?? 0;
	const streaming = options.streaming ?? false;
	if (config.providerType === "deepseek") {
		return new ChatDeepSeek({
			model: config.model,
			temperature,
			streaming,
			apiKey: config.apiKey,
			modelKwargs: ChatDeepSeek.getModelKwargs(options.reasoningEffort),
			configuration: {
				dangerouslyAllowBrowser: true,
				baseURL: config.apiBaseURL || "https://api.deepseek.com",
			},
		}) as unknown as BaseChatModel;
	}
	return new ChatOpenAI({
		model: config.model,
		temperature,
		streaming,
		apiKey: config.apiKey,
		modelKwargs: getOpenAICompatibleModelKwargs(options.reasoningEffort),
		configuration: {
			dangerouslyAllowBrowser: true,
			baseURL: config.apiBaseURL,
		},
	});
}
