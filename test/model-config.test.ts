import { describe, expect, it } from "vitest";
import {
	resolveModelConfig,
	resolveSubAgentModelConfig,
	normalizeAgentConfig,
	genModelId,
	buildSystemPrompt,
	type AgentConfig,
	type ModelConfig,
	type ModelServiceConfig,
} from "../src/types";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return normalizeAgentConfig(overrides);
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

function makeService(overrides: Partial<ModelServiceConfig> = {}): ModelServiceConfig {
	return {
		id: "svc_1",
		name: "OpenAI",
		apiBaseURL: "https://api.openai.com/v1",
		apiKey: "sk-test",
		models: [
			{ id: "test-1", name: "Test Model", model: "gpt-4o" },
		],
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
		const config = makeConfig({
			modelServices: [makeService({
				id: "svc_ds",
				name: "DeepSeek",
				apiBaseURL: "https://api.deepseek.com/v1",
				apiKey: "ds-key",
				models: [{ id: "m1", name: "My Model", model: "deepseek-chat" }],
			})],
			defaultModelId: "m1",
		});
		const result = resolveModelConfig(config);
		expect(result.id).toBe("m1");
		expect(result.model).toBe("deepseek-chat");
		expect(result.apiKey).toBe("ds-key");
	});

	it("uses the first configured service model when no default model is selected", () => {
		const config = makeConfig({
			modelServices: [makeService({
				apiBaseURL: "https://api.example.com/v1",
				apiKey: "service-key",
				models: [{ id: "m1", name: "Configured Model", model: "custom-chat" }],
			})],
			defaultModelId: "",
			apiKey: "",
		});
		const result = resolveModelConfig(config);
		expect(result.id).toBe("m1");
		expect(result.model).toBe("custom-chat");
		expect(result.apiKey).toBe("service-key");
	});

	it("uses explicit modelId over defaultModelId", () => {
		const config = makeConfig({
			modelServices: [makeService({
				models: [
					{ id: "m1", name: "A", model: "gpt-4o" },
					{ id: "m2", name: "B", model: "gpt-4o-mini" },
				],
			})],
			defaultModelId: "m1",
		});
		const result = resolveModelConfig(config, "m2");
		expect(result.id).toBe("m2");
		expect(result.model).toBe("gpt-4o-mini");
	});

	it("falls back to legacy if model ID not found", () => {
		const config = makeConfig({ modelServices: [makeService()], defaultModelId: "nonexistent" });
		const result = resolveModelConfig(config);
		expect(result.id).toBe("__legacy__");
	});

	it("migrates legacy flat models into model services", () => {
		const legacyModel = makeModel({ id: "m_legacy", provider: "Legacy Vendor", apiKey: "legacy-key" });
		const config = normalizeAgentConfig({ models: [legacyModel], defaultModelId: "m_legacy" });
		expect(config.modelServices).toHaveLength(1);
		expect(config.modelServices?.[0].name).toBe("Legacy Vendor");
		expect(config.modelServices?.[0].models[0].id).toBe("m_legacy");
	});
});

describe("resolveSubAgentModelConfig", () => {
	it("returns sub-agent model when configured", () => {
		const config = makeConfig({
			modelServices: [makeService({
				models: [
					{ id: "main", name: "Main", model: "gpt-4o" },
					{ id: "cheap", name: "Cheap", model: "gpt-4o-mini" },
				],
				apiKey: "cheap-key",
			})],
			defaultModelId: "main",
			subAgentModelId: "cheap",
		});
		const result = resolveSubAgentModelConfig(config);
		expect(result.id).toBe("cheap");
		expect(result.model).toBe("gpt-4o-mini");
	});

	it("falls back to main model when subAgentModelId not set", () => {
		const config = makeConfig({
			modelServices: [makeService({
				models: [{ id: "main", name: "Main", model: "gpt-4o" }],
			})],
			defaultModelId: "main",
		});
		const result = resolveSubAgentModelConfig(config);
		expect(result.id).toBe("main");
	});

	it("falls back to main model when subAgentModelId not found", () => {
		const config = makeConfig({
			modelServices: [makeService({
				models: [{ id: "main", name: "Main", model: "gpt-4o" }],
			})],
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
