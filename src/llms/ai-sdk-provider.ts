import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import type { LanguageModelV1 } from "@ai-sdk/provider";
import type { ModelConfig, ReasoningEffort } from "../types";

export interface CreateModelOptions {
    reasoningEffort?: ReasoningEffort;
}

function createAnthropicFetch(options: CreateModelOptions): typeof fetch | undefined {
    if (options.reasoningEffort !== "off") return undefined;
    return async (input, init) => {
        let nextInit = init;
        if (typeof init?.body === "string") {
            try {
                const body = JSON.parse(init.body);
                if (body && typeof body === "object" && !Array.isArray(body) && body.thinking === undefined) {
                    nextInit = {
                        ...init,
                        body: JSON.stringify({
                            ...body,
                            thinking: { type: "disabled" },
                        }),
                    };
                }
            } catch {
                /* Leave non-JSON request bodies untouched. */
            }
        }
        return fetch(input, nextInit);
    };
}

export function createModel(
    config: ModelConfig,
    options: CreateModelOptions = {},
): LanguageModelV1 {
    const effort = options.reasoningEffort ?? "default";

    if (config.providerType === "deepseek") {
        const deepseek = createDeepSeek({
            apiKey: config.apiKey,
            baseURL: config.apiBaseURL || "https://api.deepseek.com",
        });
        return deepseek(config.model);
    }

    if (config.providerType === "anthropic") {
        const anthropic = createAnthropic({
            apiKey: config.apiKey,
            baseURL: config.apiBaseURL || undefined,
            fetch: createAnthropicFetch({ reasoningEffort: effort }),
        });
        return anthropic(config.model);
    }

    // OpenAI-compatible gateways commonly implement /chat/completions but not /responses.
    const openai = createOpenAI({
        apiKey: config.apiKey,
        baseURL: config.apiBaseURL,
        compatibility: "compatible",
    });
    return openai.chat(config.model);
}

// Build providerOptions for reasoning/thinking support
export function buildProviderOptions(
    providerType: string,
    reasoningEffort: ReasoningEffort = "default",
): Record<string, Record<string, unknown>> | undefined {
    if (reasoningEffort === "default") return undefined;

    if (providerType === "deepseek") {
        // @ai-sdk/deepseek uses providerOptions.deepseek.reasoning
        return {
            deepseek: {
                reasoning: reasoningEffort !== "off",
            },
        };
    }

    if (providerType === "anthropic") {
        if (reasoningEffort === "off") {
            return { anthropic: { thinking: { type: "disabled" } } };
        }
        const budget = reasoningEffort === "high" ? 100000 : 10000;
        return {
            anthropic: {
                thinking: { type: "enabled", budgetTokens: budget },
            },
        };
    }

    // OpenAI-compatible: pass thinking config
    if (reasoningEffort === "off") {
        return { openai: { thinking: { type: "disabled" } } };
    }
    return { openai: { thinking: { type: "enabled" } } };
}
