import { describe, expect, it } from "vitest";
import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
	createChatModel,
	getOpenAICompatibleModelKwargs,
	injectReasoningContent,
} from "../src/core/chat-model";
import { ChatDeepSeek } from "../src/llms/deepseek";
import type { ModelConfig } from "../src/types";

function makeModel(overrides: Partial<ModelConfig> = {}): ModelConfig {
	return {
		id: "m1",
		name: "Test",
		provider: "OpenAI",
		providerType: "openai-compatible",
		model: "gpt-4o",
		apiBaseURL: "https://api.openai.com/v1",
		apiKey: "sk-test",
		...overrides,
	};
}

describe("createChatModel", () => {
	it("creates ChatDeepSeek for DeepSeek providers", () => {
		const model = createChatModel(makeModel({
			provider: "DeepSeek",
			providerType: "deepseek",
			model: "deepseek-v4-pro",
			apiBaseURL: "https://api.deepseek.com",
			apiKey: "ds-test",
		}), { streaming: true, reasoningEffort: "high" });
		expect(model).toBeInstanceOf(ChatDeepSeek);
		expect((model as any).modelKwargs).toMatchObject({
			reasoning_effort: "max",
			thinking: { type: "enabled" },
		});
	});

	it("creates ChatOpenAI for OpenAI-compatible providers", () => {
		const model = createChatModel(makeModel());
		expect(model).toBeInstanceOf(ChatOpenAI);
		expect((model as any).modelKwargs).not.toHaveProperty("thinking");
	});

	it("passes OpenAI-compatible thinking settings through modelKwargs", () => {
		const offModel = createChatModel(makeModel(), { reasoningEffort: "off" });
		const lowModel = createChatModel(makeModel(), { reasoningEffort: "low" });
		const highModel = createChatModel(makeModel(), { reasoningEffort: "high" });

		expect((offModel as any).modelKwargs).toEqual({ thinking: { type: "disabled" } });
		expect((lowModel as any).modelKwargs).toEqual({ thinking: { type: "enabled" } });
		expect((highModel as any).modelKwargs).toEqual({ thinking: { type: "enabled" } });
	});
});

describe("ChatDeepSeek.getModelKwargs", () => {
	it("maps reasoning effort to DeepSeek request fields", () => {
		expect(ChatDeepSeek.getModelKwargs("default")).toEqual({});
		expect(ChatDeepSeek.getModelKwargs("off")).toEqual({ thinking: { type: "disabled" } });
		expect(ChatDeepSeek.getModelKwargs("high")).toEqual({
			reasoning_effort: "max",
			thinking: { type: "enabled" },
		});
		expect(ChatDeepSeek.getModelKwargs("low")).toEqual({
			reasoning_effort: "high",
			thinking: { type: "enabled" },
		});
	});
});

describe("getOpenAICompatibleModelKwargs", () => {
	it("maps reasoning effort to OpenAI-compatible thinking fields", () => {
		expect(getOpenAICompatibleModelKwargs("default")).toEqual({});
		expect(getOpenAICompatibleModelKwargs("off")).toEqual({ thinking: { type: "disabled" } });
		expect(getOpenAICompatibleModelKwargs("high")).toEqual({ thinking: { type: "enabled" } });
		expect(getOpenAICompatibleModelKwargs("low")).toEqual({ thinking: { type: "enabled" } });
	});
});

describe("injectReasoningContent", () => {
	it("copies stored assistant reasoning_content into OpenAI request messages", () => {
		const sourceMessages = [
			new HumanMessage({ content: "search foo" }),
			new AIMessage({
				content: "",
				additional_kwargs: { reasoning_content: "Need to search first." },
				tool_calls: [{ name: "search_fulltext", args: { query: "foo" }, id: "call-1" }],
			}),
			new ToolMessage({ content: "42", tool_call_id: "call-1" }),
			new HumanMessage({ content: "continue" }),
		];
		const request = {
			model: "deepseek-v4-pro",
			messages: [
				{ role: "user", content: "search foo" },
				{ role: "assistant", content: "", tool_calls: [{ id: "call-1" }] },
				{ role: "tool", content: "42", tool_call_id: "call-1" },
				{ role: "user", content: "continue" },
			],
		};

		const injected = injectReasoningContent(request, sourceMessages);

		expect(injected.messages[1]).toMatchObject({
			role: "assistant",
			reasoning_content: "Need to search first.",
		});
		expect(request.messages[1]).not.toHaveProperty("reasoning_content");
	});

	it("ChatDeepSeek patches completions for reasoning injection", () => {
		const model = createChatModel(makeModel({
			provider: "DeepSeek",
			providerType: "deepseek",
			model: "deepseek-v4-pro",
			apiBaseURL: "https://api.deepseek.com",
			apiKey: "ds-test",
		})) as any;
		expect(model.completions.completionWithRetry).not.toBe(
			Object.getPrototypeOf(model.completions).completionWithRetry,
		);
		expect(model.completions._convertCompletionsDeltaToBaseMessageChunk).not.toBe(
			Object.getPrototypeOf(model.completions)._convertCompletionsDeltaToBaseMessageChunk,
		);
		expect(model.completions._convertCompletionsMessageToBaseMessage).not.toBe(
			Object.getPrototypeOf(model.completions)._convertCompletionsMessageToBaseMessage,
		);
		expect(model.sourceMessagesForRequest).toBeNull();
	});
});
