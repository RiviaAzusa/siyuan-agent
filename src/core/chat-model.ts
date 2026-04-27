import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { ModelConfig, ReasoningEffort } from "../types";

export interface CreateChatModelOptions {
	streaming?: boolean;
	temperature?: number;
	reasoningEffort?: ReasoningEffort;
}

export function getDeepSeekModelKwargs(reasoningEffort: ReasoningEffort = "default"): Record<string, any> {
	if (reasoningEffort === "off") {
		return {
			thinking: { type: "disabled" },
		};
	}
	if (reasoningEffort === "high") {
		return {
			reasoning_effort: "high",
			thinking: { type: "enabled" },
		};
	}
	if (reasoningEffort === "xhigh") {
		return {
			reasoning_effort: "max",
			thinking: { type: "enabled" },
		};
	}
	return {};
}

function getMessageType(message: BaseMessage): string {
	return typeof (message as any)?._getType === "function"
		? (message as any)._getType()
		: String((message as any)?.type || "");
}

function getReasoningContent(message: BaseMessage): string {
	const reasoning = (message as any)?.additional_kwargs?.reasoning_content
		?? (message as any)?.kwargs?.additional_kwargs?.reasoning_content;
	return typeof reasoning === "string" ? reasoning : "";
}

export function injectDeepSeekReasoningContent<T extends { messages?: any[] }>(
	request: T,
	sourceMessages: BaseMessage[] | null | undefined,
): T {
	if (!Array.isArray(request.messages) || !Array.isArray(sourceMessages)) return request;
	const nextMessages = request.messages.map((message) => ({ ...message }));
	let requestIndex = 0;
	for (const sourceMessage of sourceMessages) {
		const requestMessage = nextMessages[requestIndex];
		requestIndex += 1;
		if (!requestMessage || requestMessage.role !== "assistant") continue;
		const sourceType = getMessageType(sourceMessage);
		if (sourceType !== "ai" && sourceType !== "AIMessageChunk") continue;
		const reasoningContent = getReasoningContent(sourceMessage);
		if (reasoningContent) {
			requestMessage.reasoning_content = reasoningContent;
		}
	}
	return {
		...request,
		messages: nextMessages,
	};
}

class SiYuanChatDeepSeek extends ChatDeepSeek {
	private sourceMessagesForRequest: BaseMessage[] | null = null;

	async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"], runManager?: any): Promise<any> {
		this.sourceMessagesForRequest = messages;
		try {
			return await super._generate(messages, options, runManager);
		} finally {
			this.sourceMessagesForRequest = null;
		}
	}

	async *_streamResponseChunks(messages: BaseMessage[], options: this["ParsedCallOptions"], runManager?: any): AsyncGenerator<any> {
		this.sourceMessagesForRequest = messages;
		try {
			yield* super._streamResponseChunks(messages, options, runManager);
		} finally {
			this.sourceMessagesForRequest = null;
		}
	}

	completionWithRetry(request: any, requestOptions?: any): Promise<any> {
		return super.completionWithRetry(
			injectDeepSeekReasoningContent(request, this.sourceMessagesForRequest),
			requestOptions,
		);
	}
}

export function createChatModel(
	config: ModelConfig,
	options: CreateChatModelOptions = {},
): BaseChatModel {
	const temperature = options.temperature ?? config.temperature ?? 0;
	const streaming = options.streaming ?? false;
	if (config.providerType === "deepseek") {
		return new SiYuanChatDeepSeek({
			model: config.model,
			temperature,
			streaming,
			apiKey: config.apiKey,
			modelKwargs: getDeepSeekModelKwargs(options.reasoningEffort),
			configuration: {
				dangerouslyAllowBrowser: true,
				baseURL: config.apiBaseURL || "https://api.deepseek.com",
			},
		}) as BaseChatModel;
	}
	return new ChatOpenAI({
		model: config.model,
		temperature,
		streaming,
		apiKey: config.apiKey,
		configuration: {
			dangerouslyAllowBrowser: true,
			baseURL: config.apiBaseURL,
		},
	}) as BaseChatModel;
}
