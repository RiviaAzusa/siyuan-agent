/* ── Model configuration ────────────────────────────────────────────── */

export interface ModelConfig {
	id: string;
	name: string;
	provider: string;
	serviceId?: string;
	model: string;
	apiBaseURL: string;
	apiKey: string;
	/** Max tokens for context window (informational, used for prompt budget) */
	maxTokens?: number;
	/** Default temperature */
	temperature?: number;
}

export interface ModelServiceModelConfig {
	id: string;
	name: string;
	model: string;
	/** Max tokens for context window (informational, used for prompt budget) */
	maxTokens?: number;
	/** Default temperature */
	temperature?: number;
}

export interface ModelServiceConfig {
	id: string;
	name: string;
	apiBaseURL: string;
	apiKey: string;
	models: ModelServiceModelConfig[];
}

/* ── MCP (Model Context Protocol) ────────────────────────────────────── */

export interface McpServerConfig {
	/** Unique ID for this MCP server */
	id: string;
	/** Display name */
	name: string;
	/** Server URL (SSE endpoint, e.g. http://localhost:3000/sse) */
	url: string;
	/** Whether this server is enabled */
	enabled: boolean;
	/** Optional API key/token for auth */
	apiKey?: string;
	/** Optional description of what this server provides */
	description?: string;
}

export interface AgentConfig {
	apiBaseURL: string;
	apiKey: string;
	model: string;
	customInstructions: string;
	panelPosition?: "right" | "bottom";
	guideDoc?: { id: string; title: string } | null;
	defaultNotebook?: { id: string; name: string } | null;
	langSmithEnabled?: boolean;
	langSmithApiKey?: string;
	langSmithEndpoint?: string;
	langSmithProject?: string;
	/** Model services grouped by provider / endpoint */
	modelServices?: ModelServiceConfig[];
	/** Multi-model registry */
	models?: ModelConfig[];
	/** Default model ID from the registry (falls back to legacy apiBaseURL/apiKey/model) */
	defaultModelId?: string;
	/** Model ID used for sub-agents (cheaper/faster model) */
	subAgentModelId?: string;
	/** MCP server configurations */
	mcpServers?: McpServerConfig[];
}

/* ── Default config ──────────────────────────────────────────────────── */

export const DEFAULT_CONFIG: AgentConfig = {
	apiBaseURL: "https://api.openai.com/v1",
	apiKey: "",
	model: "gpt-4o",
	customInstructions: "",
	panelPosition: "right",
	guideDoc: null,
	langSmithEnabled: false,
	langSmithApiKey: "",
	langSmithEndpoint: "https://api.smith.langchain.com",
	langSmithProject: "SiYuan-Agent",
	modelServices: [],
	models: [],
	defaultModelId: "",
	subAgentModelId: "",
};

/* ── Config helpers ──────────────────────────────────────────────────── */

function cloneLegacyModels(models?: ModelConfig[]): ModelConfig[] {
	return Array.isArray(models) ? models.map((item) => ({ ...item })) : [];
}

export function cloneModelServices(services?: ModelServiceConfig[]): ModelServiceConfig[] {
	return Array.isArray(services)
		? services.map((service) => ({
			...service,
			models: Array.isArray(service.models) ? service.models.map((model) => ({ ...model })) : [],
		}))
		: [];
}

function migrateLegacyModels(models?: ModelConfig[]): ModelServiceConfig[] {
	const legacyModels = cloneLegacyModels(models);
	if (legacyModels.length === 0) return [];
	const services = new Map<string, ModelServiceConfig>();
	for (const legacyModel of legacyModels) {
		const serviceKey = `${legacyModel.provider}\u0000${legacyModel.apiBaseURL}\u0000${legacyModel.apiKey}`;
		let service = services.get(serviceKey);
		if (!service) {
			service = {
				id: `svc_${legacyModel.id}`,
				name: legacyModel.provider || "OpenAI Compatible",
				apiBaseURL: legacyModel.apiBaseURL,
				apiKey: legacyModel.apiKey,
				models: [],
			};
			services.set(serviceKey, service);
		}
		service.models.push({
			id: legacyModel.id,
			name: legacyModel.name,
			model: legacyModel.model,
			maxTokens: legacyModel.maxTokens,
			temperature: legacyModel.temperature,
		});
	}
	return Array.from(services.values());
}

export function normalizeAgentConfig(raw?: Partial<AgentConfig> | null): AgentConfig {
	const hasModelServices = Array.isArray(raw?.modelServices);
	const modelServices = Array.isArray(raw?.modelServices)
		? cloneModelServices(raw?.modelServices)
		: migrateLegacyModels(raw?.models);
	return {
		...DEFAULT_CONFIG,
		...(raw || {}),
		modelServices,
		models: hasModelServices ? [] : cloneLegacyModels(raw?.models),
	};
}

export function flattenModelServices(services?: ModelServiceConfig[]): ModelConfig[] {
	if (!Array.isArray(services)) return [];
	const flattened: ModelConfig[] = [];
	for (const service of services) {
		for (const model of service.models || []) {
			flattened.push({
				id: model.id,
				name: model.name,
				provider: service.name,
				serviceId: service.id,
				model: model.model,
				apiBaseURL: service.apiBaseURL,
				apiKey: service.apiKey,
				maxTokens: model.maxTokens,
				temperature: model.temperature,
			});
		}
	}
	return flattened;
}

export function listConfiguredModels(config: AgentConfig): ModelConfig[] {
	return flattenModelServices(config.modelServices);
}

/** Resolve a ModelConfig from the registry by ID, falling back to legacy fields. */
export function resolveModelConfig(config: AgentConfig, modelId?: string): ModelConfig {
	const id = modelId || config.defaultModelId || "";
	const models = listConfiguredModels(config);
	if (id) {
		const found = models.find((m) => m.id === id);
		if (found) return found;
	}
	if (!id && models.length > 0) {
		return models[0];
	}
	// Legacy fallback: construct from top-level fields
	return {
		id: "__legacy__",
		name: config.model || "gpt-4o",
		provider: "custom",
		model: config.model || "gpt-4o",
		apiBaseURL: config.apiBaseURL || "https://api.openai.com/v1",
		apiKey: config.apiKey || "",
	};
}

/** Resolve the sub-agent model, falling back to main model. */
export function resolveSubAgentModelConfig(config: AgentConfig): ModelConfig {
	if (config.subAgentModelId) {
		const resolved = resolveModelConfig(config, config.subAgentModelId);
		if (resolved.id !== "__legacy__") return resolved;
	}
	return resolveModelConfig(config);
}

/** Generate a unique model config ID. */
export function genModelId(): string {
	return "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Generate a unique model service ID. */
export function genModelServiceId(): string {
	return "svc_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
