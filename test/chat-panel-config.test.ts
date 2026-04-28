import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../src/ui/chat-panel";

describe("ChatPanel config loading", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

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

	it("creates the init notebook and guide document when guideDoc is missing", async () => {
		const saved: any[] = [];
		const panel = Object.create(ChatPanel.prototype) as any;
		panel.plugin = {
			data: {},
			saveData: vi.fn(async (_key: string, value: any) => {
				saved.push(value);
			}),
		};
		panel.handleConfigSaved = vi.fn(async () => {});

		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body || "{}"));
			if (url === "/api/notebook/lsNotebooks") {
				return { json: async () => ({ code: 0, data: { notebooks: [] } }) };
			}
			if (url === "/api/notebook/createNotebook") {
				expect(body).toEqual({ name: "SiYuan-Agent" });
				return {
					json: async () => ({
						code: 0,
						data: { notebook: { id: "nb-init", name: "SiYuan-Agent", closed: false } },
					}),
				};
			}
			if (url === "/api/filetree/createDocWithMd") {
				expect(body).toEqual({
					notebook: "nb-init",
					path: "/SiYuan-Agent-Init",
					markdown: "",
				});
				return { json: async () => ({ code: 0, data: "doc-init" }) };
			}
			throw new Error(`Unexpected URL ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const config = await panel.ensureInitGuideDoc({ apiKey: "key" });

		expect(config.guideDoc).toEqual({ id: "doc-init", title: "SiYuan-Agent-Init" });
		expect(config.defaultNotebook).toEqual({ id: "nb-init", name: "SiYuan-Agent" });
		expect(panel.plugin.saveData).toHaveBeenCalledWith("agent-config", expect.objectContaining({
			guideDoc: { id: "doc-init", title: "SiYuan-Agent-Init" },
			defaultNotebook: { id: "nb-init", name: "SiYuan-Agent" },
		}));
		expect(panel.handleConfigSaved).toHaveBeenCalledWith(saved[0]);
	});
});
