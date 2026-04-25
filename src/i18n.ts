import enUS from "./i18n/en_US.json";

export type I18nParams = Record<string, string | number | boolean | null | undefined>;

export interface Translator {
	t: (key: string, params?: I18nParams, fallback?: string) => string;
	raw: Record<string, string>;
}

const EN_US = enUS as Record<string, string>;

function interpolate(template: string, params?: I18nParams): string {
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, key) => {
		const value = params[key];
		return value === undefined || value === null ? match : String(value);
	});
}

export function createTranslator(raw?: Record<string, unknown> | null): Translator {
	const source: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw || {})) {
		if (typeof value === "string") source[key] = value;
	}
	return {
		raw: source,
		t(key, params, fallback) {
			const template = source[key] ?? EN_US[key] ?? fallback ?? key;
			return interpolate(template, params);
		},
	};
}

export const defaultTranslator = createTranslator(EN_US);

export function localizeErrorMessage(error: unknown, i18n: Translator = defaultTranslator): string {
	const raw = error instanceof Error ? error.message : String(error);
	const text = raw.replace(/^Error:\s*/i, "");
	const lower = text.toLowerCase();

	if (text.includes("function.arguments") && text.includes("JSON")) {
		return i18n.t("chat.error.invalidToolArgs", { error: text });
	}
	if (text.includes("401") || text.includes("Unauthorized")) {
		return i18n.t("chat.error.unauthorized");
	}
	if (text.includes("429") || lower.includes("rate limit")) {
		return i18n.t("chat.error.rateLimit");
	}
	if (text.includes("insufficient_quota") || lower.includes("quota")) {
		return i18n.t("chat.error.quota");
	}
	if (text.includes("Stream idle timeout")) {
		return i18n.t("chat.error.timeout");
	}

	const blockNotFound = text.match(/^Block (.+) not found\.?$/);
	if (blockNotFound) {
		return i18n.t("tool.error.blockNotFound", { id: blockNotFound[1] });
	}

	const apiErrorCode = text.match(/^API error code (.+)$/);
	if (apiErrorCode) {
		return i18n.t("tool.error.siyuanApiCode", { code: apiErrorCode[1] });
	}

	const mcpServerError = text.match(/^MCP server (.+) returned ([\s\S]+)$/);
	if (mcpServerError) {
		return i18n.t("mcp.error.serverReturned", { server: mcpServerError[1], detail: mcpServerError[2] });
	}
	const mcpRpcError = text.match(/^MCP error \[(-?\d+)\]: ([\s\S]+)$/);
	if (mcpRpcError) {
		return i18n.t("mcp.error.rpc", { code: mcpRpcError[1], message: mcpRpcError[2] });
	}
	const mcpToolError = text.match(/^\[MCP tool error: ([^\]]+)\] ([\s\S]+)$/);
	if (mcpToolError) {
		return i18n.t("mcp.error.tool", { name: mcpToolError[1], error: localizeErrorMessage(mcpToolError[2], i18n) });
	}
	const mcpResultError = text.match(/^\[MCP Error\] ([\s\S]+)$/);
	if (mcpResultError) {
		return i18n.t("mcp.error.result", { error: mcpResultError[1] });
	}
	const mcpSseError = text.match(/^No valid JSON-RPC response in SSE stream from (.+)$/);
	if (mcpSseError) {
		return i18n.t("mcp.error.invalidSse", { server: mcpSseError[1] });
	}

	switch (text) {
		case "Please configure API Key in plugin settings first.":
			return i18n.t("chat.error.apiKeyMissing");
		case "Task title is required.":
			return i18n.t("scheduled.error.titleRequired");
		case "Task prompt is required.":
			return i18n.t("scheduled.error.promptRequired");
		case "One-time task requires triggerAt.":
			return i18n.t("scheduled.error.onceRequiresTriggerAt");
		case "Recurring task requires cron expression.":
		case "Recurring task requires cron expression":
			return i18n.t("scheduled.error.recurringRequiresCron");
		case "Scheduled task manager is not ready.":
			return i18n.t("scheduled.error.managerNotReady");
		default:
			return text;
	}
}
