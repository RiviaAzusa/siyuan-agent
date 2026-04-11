import { describe, expect, it } from "vitest";
import {
	resolveModelConfig,
	resolveSubAgentModelConfig,
	genModelId,
	buildSystemPrompt,
	type AgentConfig,
	type ModelConfig,
	DEFAULT_CONFIG,
} from "../src/types";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return { ...DEFAULT_CONFIG, ...overrides };
}

function makeModel(overrides: Partial<ModelConfig> = {}): ModelConfig {
	return {
		id: "test-1",
		name: "Test Model",
		provider: "openai",
		model: "gpt-4o",
		apiBaseURL: "https://api.openai.com/v1",
		apiKey: "sk-test",
		...overrides,
	};
}

describe("resolveModelConfig", () => {
	it("returns legacy fallback when no models configured", () => {
		const config = makeConfig({ apiBaseURL: "https://api.example.com/v1", apiKey: "key", model: "gpt-4o" });
		const result = resolveModelConfig(config);
		expect(result.id).toBe("__legacy__");
		expect(result.model).toBe("gpt-4o");
		expect(result.apiKey).toBe("key");
		expect(result.apiBaseURL).toBe("https://api.example.com/v1");
	});

	it("resolves model by ID from registry", () => {
		const model = makeModel({ id: "m1", name: "My Model", model: "deepseek-chat", apiKey: "ds-key" });
		const config = makeConfig({ models: [model], defaultModelId: "m1" });
		const result = resolveModelConfig(config);
		expect(result.id).toBe("m1");
		expect(result.model).toBe("deepseek-chat");
		expect(result.apiKey).toBe("ds-key");
	});

	it("uses explicit modelId over defaultModelId", () => {
		const m1 = makeModel({ id: "m1", name: "A" });
		const m2 = makeModel({ id: "m2", name: "B", model: "gpt-4o-mini" });
		const config = makeConfig({ models: [m1, m2], defaultModelId: "m1" });
		const result = resolveModelConfig(config, "m2");
		expect(result.id).toBe("m2");
		expect(result.model).toBe("gpt-4o-mini");
	});

	it("falls back to legacy if model ID not found", () => {
		const config = makeConfig({ models: [makeModel()], defaultModelId: "nonexistent" });
		const result = resolveModelConfig(config);
		expect(result.id).toBe("__legacy__");
	});
});

describe("resolveSubAgentModelConfig", () => {
	it("returns sub-agent model when configured", () => {
		const mainModel = makeModel({ id: "main", model: "gpt-4o" });
		const cheapModel = makeModel({ id: "cheap", model: "gpt-4o-mini", apiKey: "cheap-key" });
		const config = makeConfig({
			models: [mainModel, cheapModel],
			defaultModelId: "main",
			subAgentModelId: "cheap",
		});
		const result = resolveSubAgentModelConfig(config);
		expect(result.id).toBe("cheap");
		expect(result.model).toBe("gpt-4o-mini");
	});

	it("falls back to main model when subAgentModelId not set", () => {
		const mainModel = makeModel({ id: "main", model: "gpt-4o" });
		const config = makeConfig({ models: [mainModel], defaultModelId: "main" });
		const result = resolveSubAgentModelConfig(config);
		expect(result.id).toBe("main");
	});

	it("falls back to main model when subAgentModelId not found", () => {
		const mainModel = makeModel({ id: "main", model: "gpt-4o" });
		const config = makeConfig({
			models: [mainModel],
			defaultModelId: "main",
			subAgentModelId: "nonexistent",
		});
		const result = resolveSubAgentModelConfig(config);
		expect(result.id).toBe("main");
	});
});

describe("genModelId", () => {
	it("generates unique IDs", () => {
		const ids = new Set(Array.from({ length: 20 }, () => genModelId()));
		expect(ids.size).toBe(20);
	});

	it("starts with 'm_'", () => {
		expect(genModelId()).toMatch(/^m_/);
	});
});

describe("buildSystemPrompt", () => {
	it("replaces datetime placeholder", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).not.toContain("{{CURRENT_DATETIME}}");
	});

	it("contains current year", () => {
		const prompt = buildSystemPrompt();
		const year = new Date().getFullYear().toString();
		expect(prompt).toContain(year);
	});

	it("uses yyyy-mm-dd date precision", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toMatch(/\d{4}-\d{2}-\d{2}/);
		expect(prompt).not.toMatch(/\d{2}:\d{2}/);
	});

	it("includes tool descriptions", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toContain("list_notebooks");
		expect(prompt).toContain("search_fulltext");
		expect(prompt).toContain("edit_blocks");
	});
});
