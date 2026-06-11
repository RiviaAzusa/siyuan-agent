import { afterEach, describe, expect, it, vi } from "vitest";
import { openTab } from "siyuan";
import { ChatPanel } from "../src/ui/chat-panel";

vi.mock("siyuan", () => ({
	Plugin: class {},
	showMessage: vi.fn(),
	openTab: vi.fn(),
}));

describe("ChatPanel document links", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.mocked(openTab).mockReset();
	});

	it("opens edit result links through block context without focus mode", async () => {
		const app = {};
		vi.stubGlobal("siyuanApp", app);
		const panel = Object.create(ChatPanel.prototype) as any;
		panel.highlightBlocksAfterOpen = vi.fn();

		panel.openDocumentLink("doc1", ["block1", "block2"]);
		await Promise.resolve();

		expect(openTab).toHaveBeenCalledWith({
			app,
			doc: {
				id: "block1",
				action: ["cb-get-hl", "cb-get-context", "cb-get-rootscroll"],
			},
		});
		expect(openTab).not.toHaveBeenCalledWith(expect.objectContaining({
			doc: expect.objectContaining({
				action: expect.arrayContaining(["cb-get-focus"]),
			}),
		}));
		expect(panel.highlightBlocksAfterOpen).toHaveBeenCalledWith(["block1", "block2"]);
	});

	it("falls back to the document id when no block id is available", () => {
		const app = {};
		vi.stubGlobal("siyuanApp", app);
		const panel = Object.create(ChatPanel.prototype) as any;
		panel.highlightBlocksAfterOpen = vi.fn();

		panel.openDocumentLink("doc1");

		expect(openTab).toHaveBeenCalledWith({
			app,
			doc: {
				id: "doc1",
				action: ["cb-get-hl", "cb-get-context", "cb-get-rootscroll"],
			},
		});
	});
});
