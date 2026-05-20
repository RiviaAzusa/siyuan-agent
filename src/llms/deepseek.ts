import { ChatOpenAI } from "@langchain/openai";
import { AIMessageChunk } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import type { BaseMessage } from "@langchain/core/messages";
import type { ReasoningEffort } from "../types";
import type { ModelProfile } from "./reasoning";
import { injectReasoningContent, DEEPSEEK_PROFILES } from "./reasoning";

export interface ChatDeepSeekInput {
	model?: string;
	temperature?: number;
	streaming?: boolean;
	apiKey?: string;
	modelKwargs?: Record<string, any>;
	configuration?: {
		baseURL?: string;
		dangerouslyAllowBrowser?: boolean;
	};
}

export class ChatDeepSeek extends ChatOpenAI {
	static getModelKwargs(effort: ReasoningEffort = "default"): Record<string, any> {
		if (effort === "off") return { thinking: { type: "disabled" } };
		if (effort === "low") return { reasoning_effort: "high", thinking: { type: "enabled" } };
		if (effort === "high") return { reasoning_effort: "max", thinking: { type: "enabled" } };
		return {};
	}

	/** @internal */
	sourceMessagesForRequest: BaseMessage[] | null = null;

	constructor(fields: ChatDeepSeekInput = {}) {
		const apiKey = fields.apiKey || process.env.DEEPSEEK_API_KEY;
		if (!apiKey) {
			throw new Error(
				'DeepSeek API key not found. Set DEEPSEEK_API_KEY or pass "apiKey".',
			);
		}
		super({
			...fields,
			apiKey,
			configuration: {
				baseURL: "https://api.deepseek.com",
				dangerouslyAllowBrowser: true,
				...fields.configuration,
			},
		});

		// Patch completions instance for DeepSeek-specific reasoning extraction
		this.patchCompletions();
	}

	private patchCompletions() {
		const originalConvertDelta =
			this.completions._convertCompletionsDeltaToBaseMessageChunk.bind(
				this.completions,
			);
		const originalConvertMessage =
			this.completions._convertCompletionsMessageToBaseMessage.bind(
				this.completions,
			);
		const originalCompletionWithRetry =
			this.completions.completionWithRetry.bind(this.completions);

		this.completions._convertCompletionsDeltaToBaseMessageChunk = (
			delta,
			rawResponse,
			defaultRole,
		) => {
			const chunk = originalConvertDelta(delta, rawResponse, defaultRole);
			chunk.additional_kwargs.reasoning_content = delta.reasoning_content;
			chunk.response_metadata = {
				...chunk.response_metadata,
				model_provider: "deepseek",
			};
			return chunk;
		};

		this.completions._convertCompletionsMessageToBaseMessage = (
			message,
			rawResponse,
		) => {
			const langChainMessage = originalConvertMessage(message, rawResponse);
			langChainMessage.additional_kwargs.reasoning_content =
				message.reasoning_content;
			langChainMessage.response_metadata = {
				...langChainMessage.response_metadata,
				model_provider: "deepseek",
			};
			return langChainMessage;
		};

		this.completions.completionWithRetry = (request, requestOptions?) => {
			return originalCompletionWithRetry(
				injectReasoningContent(request, this.sourceMessagesForRequest),
				requestOptions,
			);
		};
	}

	override async _generate(
		messages: BaseMessage[],
		options: this["ParsedCallOptions"],
		runManager?: any,
	): Promise<any> {
		this.sourceMessagesForRequest = messages;
		try {
			return await super._generate(messages, options, runManager);
		} finally {
			this.sourceMessagesForRequest = null;
		}
	}

	override async *_streamResponseChunks(
		messages: BaseMessage[],
		options: this["ParsedCallOptions"],
		runManager?: any,
	): AsyncGenerator<any> {
		this.sourceMessagesForRequest = messages;
		try {
			yield* this.processStreamWithThinkTags(
				super._streamResponseChunks(messages, options, runManager),
				options,
			);
		} finally {
			this.sourceMessagesForRequest = null;
		}
	}

	private async *processStreamWithThinkTags(
		stream: AsyncGenerator<any>,
		options: this["ParsedCallOptions"],
	): AsyncGenerator<any> {
		let tokensBuffer = "";
		let isThinking = false;

		for await (const chunk of stream) {
			if (options.signal?.aborted) return;

			const genChunk = chunk as ChatGenerationChunk;
			const message = genChunk.message as AIMessageChunk;

			// Pass through chunks that already have reasoning_content (from patched converter)
			if (message.additional_kwargs.reasoning_content) {
				yield chunk;
				continue;
			}

			const text = genChunk.text;
			if (!text) {
				yield chunk;
				continue;
			}

			tokensBuffer += text;

			if (!isThinking && tokensBuffer.includes("<think>")) {
				isThinking = true;
				const thinkIndex = tokensBuffer.indexOf("<think>");
				const beforeThink = tokensBuffer.substring(0, thinkIndex);
				tokensBuffer = tokensBuffer.substring(thinkIndex + 7) || "";
				if (beforeThink) {
					yield this.makeChunk(beforeThink, chunk, message);
				}
			}

			if (isThinking && tokensBuffer.includes("</think>")) {
				isThinking = false;
				const thinkEndIndex = tokensBuffer.indexOf("</think>");
				const thoughtContent = tokensBuffer.substring(0, thinkEndIndex);
				const afterThink = tokensBuffer.substring(thinkEndIndex + 8);
				yield this.makeReasoningChunk(thoughtContent, chunk, message);
				tokensBuffer = afterThink || "";
				if (tokensBuffer) {
					yield this.makeChunk(tokensBuffer, chunk, message);
					tokensBuffer = "";
				}
			} else if (isThinking) {
				const possibleEndTag = "</think>";
				let splitIndex = -1;
				for (let i = 7; i >= 1; i--) {
					if (tokensBuffer.endsWith(possibleEndTag.substring(0, i))) {
						splitIndex = tokensBuffer.length - i;
						break;
					}
				}
				if (splitIndex !== -1) {
					const safeToYield = tokensBuffer.substring(0, splitIndex);
					if (safeToYield) {
						yield this.makeReasoningChunk(safeToYield, chunk, message);
					}
					tokensBuffer = tokensBuffer.substring(splitIndex);
				} else if (tokensBuffer) {
					yield this.makeReasoningChunk(tokensBuffer, chunk, message);
					tokensBuffer = "";
				}
			} else {
				const possibleStartTag = "<think>";
				let splitIndex = -1;
				for (let i = 6; i >= 1; i--) {
					if (tokensBuffer.endsWith(possibleStartTag.substring(0, i))) {
						splitIndex = tokensBuffer.length - i;
						break;
					}
				}
				if (splitIndex !== -1) {
					const safeToYield = tokensBuffer.substring(0, splitIndex);
					if (safeToYield) {
						yield this.makeChunk(safeToYield, chunk, message);
					}
					tokensBuffer = tokensBuffer.substring(splitIndex);
				} else if (tokensBuffer) {
					yield this.makeChunk(tokensBuffer, chunk, message);
					tokensBuffer = "";
				}
			}
		}

		// Flush remaining buffer
		if (tokensBuffer) {
			if (isThinking) {
				yield new ChatGenerationChunk({
					message: new AIMessageChunk({
						content: "",
						additional_kwargs: { reasoning_content: tokensBuffer },
					}),
					text: "",
				});
			} else {
				yield new ChatGenerationChunk({
					message: new AIMessageChunk({ content: tokensBuffer }),
					text: tokensBuffer,
				});
			}
		}
	}

	private makeChunk(
		text: string,
		originalChunk: ChatGenerationChunk,
		originalMessage: AIMessageChunk,
	): ChatGenerationChunk {
		return new ChatGenerationChunk({
			message: new AIMessageChunk({
				content: text,
				additional_kwargs: originalMessage.additional_kwargs,
				response_metadata: originalMessage.response_metadata,
				tool_calls: (originalMessage as any).tool_calls,
				tool_call_chunks: (originalMessage as any).tool_call_chunks,
				id: originalMessage.id,
			}),
			text,
			generationInfo: originalChunk.generationInfo,
		});
	}

	private makeReasoningChunk(
		reasoningText: string,
		originalChunk: ChatGenerationChunk,
		originalMessage: AIMessageChunk,
	): ChatGenerationChunk {
		return new ChatGenerationChunk({
			message: new AIMessageChunk({
				content: "",
				additional_kwargs: {
					...originalMessage.additional_kwargs,
					reasoning_content: reasoningText,
				},
				response_metadata: originalMessage.response_metadata,
				tool_calls: (originalMessage as any).tool_calls,
				tool_call_chunks: (originalMessage as any).tool_call_chunks,
				id: originalMessage.id,
			}),
			text: "",
			generationInfo: originalChunk.generationInfo,
		});
	}

	override get profile(): ModelProfile {
		return DEEPSEEK_PROFILES[this.model] ?? {};
	}

	override withStructuredOutput(outputSchema: any, config?: any) {
		const ensuredConfig = { ...config };
		if (ensuredConfig?.method === undefined) {
			ensuredConfig.method = "functionCalling";
		}
		return super.withStructuredOutput(outputSchema, ensuredConfig);
	}
}
