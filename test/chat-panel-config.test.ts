import { describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../src/ui/chat-panel";

describe("ChatPanel config loading", () => {
	it("uses plugin.data config without calling loadData again", async () => {
		const panel = Object.create(ChatPanel.prototype) as any;
		panel.plugin = {
			data: {
				"agent-config": {
					apiKey: "cached-key",
					apiBase: "https://example.test/v1",
					model: "cached-model",
				},
			},
			loadData: vi.fn(),
		};

		const config = await panel.getConfig();

		expect(panel.plugin.loadData).not.toHaveBeenCalled();
		expect(config.apiKey).toBe("cached-key");
		expect(config.apiBase).toBe("https://example.test/v1");
		expect(config.model).toBe("cached-model");
	});

	it("treats an already loaded empty config as cached", async () => {
		const panel = Object.create(ChatPanel.prototype) as any;
		panel.plugin = {
			data: {
				"agent-config": "",
			},
			loadData: vi.fn(),
		};

		const config = await panel.getConfig();

		expect(panel.plugin.loadData).not.toHaveBeenCalled();
		expect(config.apiKey).toBe("");
	});
});
