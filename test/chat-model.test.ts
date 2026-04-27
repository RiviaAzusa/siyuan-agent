import { describe, expect, it } from "vitest";
import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { createChatModel, getDeepSeekModelKwargs, injectDeepSeekReasoningContent } from "../src/core/chat-model";
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
			reasoning_effort: "high",
			thinking: { type: "enabled" },
		});
	});

	it("creates ChatOpenAI for OpenAI-compatible providers", () => {
		const model = createChatModel(makeModel());
		expect(model).toBeInstanceOf(ChatOpenAI);
	});
});

describe("getDeepSeekModelKwargs", () => {
	it("maps reasoning effort to DeepSeek request fields", () => {
		expect(getDeepSeekModelKwargs("default")).toEqual({});
		expect(getDeepSeekModelKwargs("off")).toEqual({ thinking: { type: "disabled" } });
		expect(getDeepSeekModelKwargs("high")).toEqual({
			reasoning_effort: "high",
			thinking: { type: "enabled" },
		});
		expect(getDeepSeekModelKwargs("xhigh")).toEqual({
			reasoning_effort: "max",
			thinking: { type: "enabled" },
		});
	});
});

describe("injectDeepSeekReasoningContent", () => {
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

		const injected = injectDeepSeekReasoningContent(request, sourceMessages);

		expect(injected.messages[1]).toMatchObject({
			role: "assistant",
			reasoning_content: "Need to search first.",
		});
		expect(request.messages[1]).not.toHaveProperty("reasoning_content");
	});
});
