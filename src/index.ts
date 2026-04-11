import {
	Plugin,
	showMessage,
	getFrontend,
	Menu,
	openTab,
} from "siyuan";
import "./index.scss";
import {
	AgentConfig,
	DEFAULT_CONFIG,
	normalizeAgentConfig,
} from "./types";
import { ChatPanel } from "./ui/chat-panel";
import { getDefaultTools } from "./core/tools";
import { SessionStore, createPluginStorage } from "./core/session-store";
import { ScheduledTaskManager } from "./core/scheduled-task-manager";
import { McpManager } from "./core/mcp-client";

const CONFIG_STORAGE = "agent-config";
const DOCK_TYPE = "agent-chat";
const TAB_TYPE = "agent-chat-tab";
const DOCK_TITLE = "AI Agent";
type PanelPosition = "right" | "bottom";

export default class SiYuanAgent extends Plugin {

	private chatPanel: ChatPanel | null = null;
	private isMobile: boolean;
	private pendingContexts: string[] = [];
	private pendingView: "settings" | null = null;
	private sessionStore: SessionStore;
	private scheduledTaskManager: ScheduledTaskManager;
	private mcpManager: McpManager = new McpManager();

	onload() {
		const frontend = getFrontend();
		this.isMobile = frontend === "mobile" || frontend === "browser-mobile";

		// Expose app instance for tools that need it (e.g., openTab)
		(globalThis as any).siyuanApp = this.app;

		const getTools = () => {
			const builtinTools = getDefaultTools(() => this.getConfig(), () => this.scheduledTaskManager);
			const mcpTools = this.mcpManager.getAllTools();
			return [...builtinTools, ...mcpTools];
		};
		this.sessionStore = new SessionStore(createPluginStorage(this));
		this.scheduledTaskManager = new ScheduledTaskManager({
			store: this.sessionStore,
			getConfig: () => this.getConfig(),
			getTools: getTools,
		});

		this.addIcons(`<symbol id="iconAgent" viewBox="0 0 24 24">
<rect width="24" height="24" rx="4" fill="#F2E6D8"/>
<path d="M3 8Q8 5 12 8v12Q8 17 3 20Z" fill="#D96C4A"/>
<path d="M21 8Q16 5 12 8v12q4-3 9 0Z" fill="#E89A6A"/>
<rect x="11.4" y="8" width="1.2" height="12" rx=".6" fill="#C85A3A"/>
<circle cx="12" cy="4.8" r="2.2" fill="#F4B942"/>
</symbol>`);

		this.eventBus.on("open-menu-content", (e) => {
			console.log("SiYuan Agent: open-menu-content event triggered", e.detail);
			const text = e.detail.range ? e.detail.range.toString().trim() : "";
			console.log("SiYuan Agent: selected text:", text);
			
			if (text) {
				e.detail.menu.addItem({
					icon: "iconAgent",
					label: this.i18n.sendToChat || "Send to Chat",
					accelerator: this.commands.find(c => c.langKey === "sendToChat")?.hotkey,
					click: () => {
						console.log("SiYuan Agent: Send to Chat clicked");
						this.sendContextToChat(text);
					}
				});
			}
		});

		if (this.isMobile) {
			this.addDock({
				config: {
					position: "RightTop",
					size: { width: 360, height: 0 },
					icon: "iconAgent",
					title: DOCK_TITLE,
					hotkey: "⌥⌘A",
					show: false,
				},
				data: {},
				type: DOCK_TYPE,
				init: (dock) => {
					dock.element.innerHTML = `<div class="toolbar toolbar--border toolbar--dark">
						<svg class="toolbar__icon"><use xlink:href="#iconAgent"></use></svg>
						<div class="toolbar__text">${DOCK_TITLE}</div>
					</div>
					<div class="fn__flex-1" style="overflow:hidden"></div>`;
					this.chatPanel = new ChatPanel(
						dock.element.querySelector(".fn__flex-1"),
						this,
						getTools(),
						this.sessionStore,
						this.scheduledTaskManager,
					);
					this.flushPendingContexts();
				},
				destroy: () => {
					this.chatPanel?.destroy();
					this.chatPanel = null;
				}
			});
		} else {
			this.addTab({
				type: TAB_TYPE,
				init: (custom) => {
					custom.element.innerHTML = "<div class=\"fn__flex-1\" style=\"height:100%;overflow:hidden\"></div>";
					this.chatPanel = new ChatPanel(
						custom.element.querySelector(".fn__flex-1"),
						this,
						getTools(),
						this.sessionStore,
						this.scheduledTaskManager,
					);
					this.flushPendingContexts();
				},
				destroy: () => {
					this.chatPanel?.destroy();
					this.chatPanel = null;
				},
			});
		}

		/* --- Commands --- */
		this.addCommand({
			langKey: "sendToChat",
			hotkey: "⌥⌘L",
			editorCallback: (protyle) => {
				let text = "";
				const sel = window.getSelection();
				if (sel && sel.rangeCount > 0) {
					const range = sel.getRangeAt(0);
					const wysiwyg = protyle.wysiwyg?.element;
					if (wysiwyg && wysiwyg.contains(range.startContainer))
						text = range.toString().trim();
				}
				if (!text) {
					/* block-level selection: .protyle-wysiwyg--select */
					const selected = protyle.wysiwyg?.element
						?.querySelectorAll(".protyle-wysiwyg--select");
					if (selected && selected.length)
						text = Array.from(selected)
							.map(el => (el as HTMLElement).innerText)
							.join("\n").trim();
				}
				if (text)
					this.sendContextToChat(text);
				else
					showMessage(this.i18n.noSelection || "No text selected");
			},
		});
	}

	onLayoutReady() {
		void this.loadData(CONFIG_STORAGE);
		void this.scheduledTaskManager.start();
		const topBarButton = this.addTopBar({
			icon: "iconAgent",
			title: DOCK_TITLE,
			position: "right",
			callback: () => {
				void this.toggleChatPanel();
			},
		});
		topBarButton?.addEventListener("contextmenu", (event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			this.openTopBarMenu(event);
		});

		// Initialize MCP servers in background (non-blocking)
		this.initMcpServers();
	}

	/** Connect to configured MCP servers */
	private async initMcpServers(): Promise<void> {
		try {
			const config = await this.getConfig();
			const servers = config.mcpServers || [];
			if (servers.length > 0) {
				const statuses = await this.mcpManager.connectAll(servers);
				const connected = statuses.filter((s) => s.connected);
				if (connected.length > 0) {
					console.log(`SiYuan Agent: Connected to ${connected.length} MCP server(s), ${connected.reduce((n, s) => n + s.toolCount, 0)} tools available`);
				}
				const failed = statuses.filter((s) => !s.connected);
				if (failed.length > 0) {
					console.warn(`SiYuan Agent: Failed to connect to ${failed.length} MCP server(s):`, failed.map((s) => `${s.serverName}: ${s.error}`));
				}
			}
		} catch (err) {
			console.warn("SiYuan Agent: MCP initialization error:", err);
		}
	}

	onunload() {
		this.scheduledTaskManager?.stop();
		this.chatPanel?.destroy();
		void this.mcpManager.disconnectAll();
	}

	openSetting(): void {
		void this.openCustomSettings();
	}

	private openTopBarMenu(event: MouseEvent): void {
		const menu = new Menu();
		menu.addItem({
			icon: "iconRightTop",
			label: this.i18n.openToRight || "打开到右侧",
			click: () => {
				void this.setPanelPosition("right", true);
			},
		});
		menu.addItem({
			icon: "iconBottomLeft",
			label: this.i18n.openToBottom || "打开到下侧",
			click: () => {
				void this.setPanelPosition("bottom", true);
			},
		});
		menu.addSeparator();
		menu.addItem({
			icon: "iconSettings",
			label: this.i18n.settings || "设置",
			click: () => {
				void this.openCustomSettings();
			},
		});
		menu.open({
			x: event.clientX,
			y: event.clientY,
		});
	}

	private getPluginTabType(): string {
		return `${this.name}${TAB_TYPE}`;
	}

	private getConfig(): AgentConfig {
		return normalizeAgentConfig(this.data[CONFIG_STORAGE] || {});
	}

	private async setPanelPosition(position: PanelPosition, reopen = false): Promise<void> {
		const nextConfig: AgentConfig = {
			...this.getConfig(),
			panelPosition: position,
		};
		this.data[CONFIG_STORAGE] = nextConfig;
		await this.saveData(CONFIG_STORAGE, nextConfig);
		if (!this.isMobile && reopen) {
			this.closeChatTabs();
			await this.openChatTab();
		}
	}

	private sendContextToChat(text: string): void {
		if (!text) {
			return;
		}
		if (this.chatPanel) {
			this.chatPanel.addContext(text);
			return;
		}
		this.pendingContexts.push(text);
		void this.ensureChatVisible();
	}

	private flushPendingContexts(): void {
		if (!this.chatPanel) {
			return;
		}
		if (this.pendingView === "settings") {
			this.chatPanel.openSettingsView();
			this.pendingView = null;
		}
		if (this.pendingContexts.length === 0) {
			return;
		}
		const pending = [...this.pendingContexts];
		this.pendingContexts = [];
		pending.forEach((text) => this.chatPanel?.addContext(text));
	}

	private async openCustomSettings(): Promise<void> {
		if (this.chatPanel) {
			this.chatPanel.openSettingsView();
			return;
		}
		this.pendingView = "settings";
		await this.ensureChatVisible();
		if (this.chatPanel) {
			this.chatPanel.openSettingsView();
			this.pendingView = null;
		}
	}

	private async toggleChatPanel(): Promise<void> {
		if (this.isMobile) {
			this.toggleChatDock();
			return;
		}
		const openedTabs = this.getOpenedChatTabs();
		if (openedTabs.length > 0) {
			this.closeChatTabs();
			return;
		}
		await this.openChatTab();
	}

	private async ensureChatVisible(): Promise<void> {
		if (this.isMobile) {
			this.openChatDock();
			return;
		}
		const openedTabs = this.getOpenedChatTabs();
		if (openedTabs.length > 0) {
			return;
		}
		await this.openChatTab();
	}

	private async openChatTab(): Promise<void> {
		await openTab({
			app: this.app,
			custom: {
				id: this.getPluginTabType(),
				icon: "iconAgent",
				title: DOCK_TITLE,
			},
			position: this.getConfig().panelPosition || DEFAULT_CONFIG.panelPosition,
		});
	}

	private getOpenedChatTabs(): any[] {
		return this.getOpenedTab()[TAB_TYPE] || [];
	}

	private closeChatTabs(): void {
		this.getOpenedChatTabs().forEach((model) => {
			model.tab?.parent?.removeTab(model.tab.id);
		});
	}

	private openChatDock(): void {
		const dockType = `${this.name}${DOCK_TYPE}`;
		const dockButton = document.querySelector(`.dock__item[data-type="${dockType}"]`) as HTMLElement | null;
		const layout = (window as any).siyuan?.layout;
		const dockController = dockButton?.closest("#dockLeft, #dockRight, #dockBottom")?.id === "dockLeft"
			? layout?.leftDock
			: dockButton?.closest("#dockLeft, #dockRight, #dockBottom")?.id === "dockBottom"
				? layout?.bottomDock
				: layout?.rightDock;

		dockController?.toggleModel?.(dockType, true, false, false, false);
	}

	private toggleChatDock(): void {
		const dockType = `${this.name}${DOCK_TYPE}`;
		const dockButton = document.querySelector(`.dock__item[data-type="${dockType}"]`) as HTMLElement | null;
		dockButton?.click();
	}

}
