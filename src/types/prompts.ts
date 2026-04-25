import { defaultTranslator, type Translator } from "../i18n";

/* ── System prompts and constants ────────────────────────────────────── */

export const BUILTIN_SYSTEM_PROMPT = defaultTranslator.t("agent.systemPrompt");

/** Build the final system prompt with local date filled in. */
export function buildSystemPrompt(i18n: Translator = defaultTranslator): string {
	const now = new Date();
	const currentDate = [
		now.getFullYear(),
		String(now.getMonth() + 1).padStart(2, "0"),
		String(now.getDate()).padStart(2, "0"),
	].join("-");
	return i18n.t("agent.systemPrompt").replace("{{CURRENT_DATETIME}}", currentDate);
}

export const INIT_PROMPT = defaultTranslator.t("agent.initPrompt");

export function buildInitPrompt(i18n: Translator = defaultTranslator): string {
	return i18n.t("agent.initPrompt");
}

export function getSlashCommands(i18n: Translator = defaultTranslator): { name: string; description: string }[] {
	return [
		{ name: "/init", description: i18n.t("slash.init") },
		{ name: "/compact", description: i18n.t("slash.compact") },
		{ name: "/help", description: i18n.t("slash.help") },
		{ name: "/clear", description: i18n.t("slash.clear") },
	];
}

export const SLASH_COMMANDS: { name: string; description: string }[] = getSlashCommands();

// DEFAULT_CONFIG is in model-config.ts to avoid circular dependency
