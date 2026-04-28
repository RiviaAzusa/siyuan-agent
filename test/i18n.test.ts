import { describe, expect, it } from "vitest";
import { buildSystemPrompt, getSlashCommands } from "../src/types";
import { createTranslator, localizeErrorMessage } from "../src/i18n";
import zhCN from "../src/i18n/zh_CN.json";

describe("i18n", () => {
	it("falls back to English and interpolates values", () => {
		const i18n = createTranslator({
			"custom.count": "Count: {count}",
		});

		expect(i18n.t("custom.count", { count: 3 })).toBe("Count: 3");
		expect(i18n.t("slash.help")).toBe("Show available commands");
	});

	it("builds localized slash command descriptions", () => {
		const commands = getSlashCommands(createTranslator(zhCN));
		expect(commands.find((item) => item.name === "/init")?.description).toBe("探索笔记库，生成用户指南");
	});

	it("builds English and Chinese system prompts", () => {
		const englishPrompt = buildSystemPrompt(createTranslator({}));
		const chinesePrompt = buildSystemPrompt(createTranslator(zhCN));

		expect(englishPrompt).toContain("You are the AI agent for SiYuan Notes");
		expect(chinesePrompt).toContain("你是思源笔记的 AI 助手");
		expect(englishPrompt).not.toContain("{{CURRENT_DATETIME}}");
		expect(chinesePrompt).not.toContain("{{CURRENT_DATETIME}}");
	});

	it("localizes common runtime errors", () => {
		const i18n = createTranslator(zhCN);

		expect(localizeErrorMessage(new Error("Please configure API Key in plugin settings first."), i18n))
			.toBe("请先在插件设置中配置 API Key。");
		expect(localizeErrorMessage("Block 20260426000000-abcdefg not found", i18n))
			.toBe("未找到块 20260426000000-abcdefg。");
		expect(localizeErrorMessage("MCP error [-32603]: boom", i18n))
			.toBe("MCP 调用失败 [-32603]：boom");
	});
});
