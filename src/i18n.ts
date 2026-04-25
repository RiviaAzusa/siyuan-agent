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
