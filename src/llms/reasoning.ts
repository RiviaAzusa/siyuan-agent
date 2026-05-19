import type { BaseMessage } from "@langchain/core/messages";

export interface ModelProfile {
	maxInputTokens?: number;
	maxOutputTokens?: number;
	reasoningOutput?: boolean;
	toolCalling?: boolean;
	structuredOutput?: boolean;
}

export const DEEPSEEK_PROFILES: Record<string, ModelProfile> = {
	"deepseek-reasoner": {
		maxInputTokens: 128000,
		maxOutputTokens: 128000,
		reasoningOutput: true,
		toolCalling: true,
		structuredOutput: false,
	},
	"deepseek-chat": {
		maxInputTokens: 128000,
		maxOutputTokens: 8192,
		reasoningOutput: false,
		toolCalling: true,
		structuredOutput: false,
	},
};

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

export function injectReasoningContent<T extends { messages?: any[] }>(
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
		const reasoning = getReasoningContent(sourceMessage);
		if (reasoning) {
			requestMessage.reasoning_content = reasoning;
		}
	}
	return {
		...request,
		messages: nextMessages,
	};
}
