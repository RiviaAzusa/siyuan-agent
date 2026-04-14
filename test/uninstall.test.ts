import { describe, it, expect, vi } from "vitest";

vi.mock("siyuan", () => ({
	Plugin: class {
		data: Record<string, any> = {};
		name = "test-plugin";
		app = {};
		i18n = {};
		addIcons() {}
		addCommand() {}
		addDock() {}
		addTab() {}
		addTopBar() { return null; }
		eventBus: any = { on() {} };
		commands: any[] = [];
		loadData() { return Promise.resolve(); }
		saveData() { return Promise.resolve(); }
		removeData() { return Promise.resolve(); }
		getOpenedTab() { return {}; }
	},
	fetchPost: (_url: string, _data: any, cb: any) => cb?.({ code: 0, data: {} }),
	openTab: () => {},
	showMessage: () => {},
	getFrontend: () => "desktop",
	Menu: class { addItem() { return this; } addSeparator() { return this; } open() {} },
}));

describe("SiYuanAgent.uninstall()", () => {
	it("calls removeData with CONFIG_STORAGE", async () => {
		const { default: SiYuanAgent } = await import("../src/index");
		const instance = new SiYuanAgent();

		const removeData = vi.fn().mockResolvedValue(undefined);
		(instance as any).removeData = removeData;

		instance.uninstall();

		expect(removeData).toHaveBeenCalledOnce();
		expect(removeData).toHaveBeenCalledWith("agent-config");
	});

	it("does not throw when removeData rejects", async () => {
		const { default: SiYuanAgent } = await import("../src/index");
		const instance = new SiYuanAgent();

		const removeData = vi.fn().mockRejectedValue(new Error("disk error"));
		(instance as any).removeData = removeData;

		// Should not throw — error is caught internally
		expect(() => instance.uninstall()).not.toThrow();
	});
});
