import {
	Plugin,
	showMessage,
	getFrontend,
	Setting,
	Menu,
	adaptHotkey,
	openTab,
} from "siyuan";
import "./index.scss";
import { AgentConfig, DEFAULT_CONFIG } from "./types";
import { ChatPanel } from "./ui/chat-panel";
import { getDefaultTools } from "./core/tools";
import { SessionStore, createPluginStorage } from "./core/session-store";
import { ScheduledTaskManager } from "./core/scheduled-task-manager";

const CONFIG_STORAGE = "agent-config";
const DOCK_TYPE = "agent-chat";
const TAB_TYPE = "agent-chat-tab";
const DOCK_TITLE = "AI Agent";
type PanelPosition = "right" | "bottom";

export default class SiYuanAgent extends Plugin {

	private chatPanel: ChatPanel | null = null;
	private isMobile: boolean;
	private pendingContexts: string[] = [];
	private sessionStore: SessionStore;
	private scheduledTaskManager: ScheduledTaskManager;

	onload() {
		const frontend = getFrontend();
		this.isMobile = frontend === "mobile" || frontend === "browser-mobile";

		// Expose app instance for tools that need it (e.g., openTab)
		(globalThis as any).siyuanApp = this.app;

		let tools = getDefaultTools(() => this.getConfig(), () => this.scheduledTaskManager);
		this.sessionStore = new SessionStore(createPluginStorage(this));
		this.scheduledTaskManager = new ScheduledTaskManager({
			store: this.sessionStore,
			getConfig: () => this.getConfig(),
			getTools: () => tools,
		});
		tools = getDefaultTools(() => this.getConfig(), () => this.scheduledTaskManager);

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
						tools,
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
					custom.element.innerHTML = `<div class="fn__flex-1" style="height:100%;overflow:hidden"></div>`;
					this.chatPanel = new ChatPanel(
						custom.element.querySelector(".fn__flex-1"),
						this,
						tools,
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

		/* --- Settings --- */
		this.initSettings();
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
	}

	onunload() {
		this.scheduledTaskManager?.stop();
		this.chatPanel?.destroy();
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
				this.openSetting();
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
		return {
			...DEFAULT_CONFIG,
			...(this.data[CONFIG_STORAGE] || {}),
		};
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
		if (!this.chatPanel || this.pendingContexts.length === 0) {
			return;
		}
		const pending = [...this.pendingContexts];
		this.pendingContexts = [];
		pending.forEach((text) => this.chatPanel?.addContext(text));
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

	private initSettings(): void {
		const apiBaseInput = document.createElement("input");
		apiBaseInput.className = "b3-text-field fn__block";
		apiBaseInput.placeholder = "https://api.openai.com/v1";

		const apiKeyInput = document.createElement("input");
		apiKeyInput.className = "b3-text-field fn__block";
		apiKeyInput.type = "password";
		apiKeyInput.placeholder = "sk-...";

		const modelInput = document.createElement("input");
		modelInput.className = "b3-text-field fn__block";
		modelInput.placeholder = "gpt-4o";

		const customInstructionsInput = document.createElement("textarea");
		customInstructionsInput.className = "b3-text-field fn__block";
		customInstructionsInput.rows = 4;
		customInstructionsInput.placeholder = "可选。附加给 AI 的自定义指令，例如：回答时使用英文。";

		/* Guide doc picker */
		let selectedGuideDoc: { id: string; title: string } | null = null;

		const guideDocPicker = document.createElement("div");
		guideDocPicker.style.cssText = "position:relative";

		const guideDocSearch = document.createElement("input");
		guideDocSearch.className = "b3-text-field fn__block";
		guideDocSearch.placeholder = "搜索文档名称...";

		const guideDocDropdown = document.createElement("div");
		guideDocDropdown.className = "b3-menu fn__none";
		guideDocDropdown.style.cssText = "position:absolute;z-index:200;width:100%;max-height:200px;overflow-y:auto;top:100%;left:0";

		guideDocPicker.appendChild(guideDocSearch);
		guideDocPicker.appendChild(guideDocDropdown);

		const setGuideDoc = (doc: { id: string; title: string } | null) => {
			selectedGuideDoc = doc;
			guideDocSearch.value = doc ? doc.title : "";
			guideDocDropdown.classList.add("fn__none");
		};

		let guideDocTimer: ReturnType<typeof setTimeout> | null = null;
		guideDocSearch.addEventListener("input", () => {
			selectedGuideDoc = null;
			if (guideDocTimer) clearTimeout(guideDocTimer);
			const kw = guideDocSearch.value.trim();
			guideDocTimer = setTimeout(async () => {
				const stmt = kw
					? `SELECT * FROM blocks WHERE type='d' AND content LIKE '%${kw}%' ORDER BY updated DESC LIMIT 8`
					: `SELECT * FROM blocks WHERE type='d' ORDER BY updated DESC LIMIT 8`;
				try {
					const resp = await fetch("/api/query/sql", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ stmt }),
					});
					const data = await resp.json();
					const docs: { id: string; title: string }[] = (data.data || []).map((d: any) => ({ id: d.id, title: d.content }));
					if (docs.length === 0) { guideDocDropdown.classList.add("fn__none"); return; }
					guideDocDropdown.innerHTML = docs.map(d =>
						`<div class="b3-menu__item" data-id="${d.id}" data-title="${d.title.replace(/"/g, "&quot;")}"><span class="b3-menu__label">${d.title}</span></div>`
					).join("");
					guideDocDropdown.querySelectorAll(".b3-menu__item").forEach(el => {
						el.addEventListener("mousedown", (ev) => {
							ev.preventDefault();
							const h = el as HTMLElement;
							setGuideDoc({ id: h.dataset.id!, title: h.dataset.title! });
						});
					});
					guideDocDropdown.classList.remove("fn__none");
				} catch { guideDocDropdown.classList.add("fn__none"); }
			}, 200);
		});
		guideDocSearch.addEventListener("blur", () => {
			setTimeout(() => guideDocDropdown.classList.add("fn__none"), 150);
		});

		/* Default notebook selector */
		let selectedNotebook: { id: string; name: string } | null = null;
		const notebookSelect = document.createElement("select");
		notebookSelect.className = "b3-select fn__block";
		notebookSelect.innerHTML = `<option value="">（加载中...）</option>`;
		notebookSelect.addEventListener("change", () => {
			const opt = notebookSelect.selectedOptions[0];
			selectedNotebook = opt.value
				? { id: opt.value, name: opt.text }
				: null;
		});

		const lsEnabledInput = document.createElement("input");
		lsEnabledInput.type = "checkbox";
		lsEnabledInput.className = "b3-switch";

		const lsKeyInput = document.createElement("input");
		lsKeyInput.className = "b3-text-field fn__block";
		lsKeyInput.type = "password";
		lsKeyInput.placeholder = "lsv2_...";

		const lsEndpointInput = document.createElement("input");
		lsEndpointInput.className = "b3-text-field fn__block";
		lsEndpointInput.placeholder = "https://api.smith.langchain.com";

		const lsProjectInput = document.createElement("input");
		lsProjectInput.className = "b3-text-field fn__block";
		lsProjectInput.placeholder = "SiYuan-Agent";

		this.setting = new Setting({
			confirmCallback: () => {
				const currentConfig = this.getConfig();
				const config: AgentConfig = {
					...currentConfig,
					apiBaseURL: apiBaseInput.value || DEFAULT_CONFIG.apiBaseURL,
					apiKey: apiKeyInput.value || "",
					model: modelInput.value || DEFAULT_CONFIG.model,
					customInstructions: customInstructionsInput.value,
					guideDoc: selectedGuideDoc,
					defaultNotebook: selectedNotebook,
					langSmithEnabled: lsEnabledInput.checked,
					langSmithApiKey: lsKeyInput.value || "",
					langSmithEndpoint: lsEndpointInput.value || DEFAULT_CONFIG.langSmithEndpoint,
					langSmithProject: lsProjectInput.value || DEFAULT_CONFIG.langSmithProject,
				};
				this.saveData(CONFIG_STORAGE, config);
			}
		});

		this.setting.addItem({
			title: "API Base URL",
			description: "OpenAI compatible API endpoint",
			actionElement: apiBaseInput,
		});
		this.setting.addItem({
			title: "API Key",
			description: "Your API key",
			actionElement: apiKeyInput,
		});
		this.setting.addItem({
			title: "Model",
			description: "Model name (e.g., gpt-4o, deepseek-chat)",
			actionElement: modelInput,
		});
		this.setting.addItem({
			title: "自定义指令",
			description: "附加给 AI 的个性化指令，追加在内置系统提示词之后",
			actionElement: customInstructionsInput,
		});
		this.setting.addItem({
			title: "用户指南文档",
			description: "将指定文档内容拼接到系统提示词，作为 AI 的行为指南",
			actionElement: guideDocPicker,
		});
		this.setting.addItem({
			title: "默认工作笔记本",
			description: "Agent 操作时优先使用的笔记本",
			actionElement: notebookSelect,
		});
		this.setting.addItem({
			title: "LangSmith Tracing",
			description: "Enable LangSmith tracing for debugging and evaluation",
			actionElement: lsEnabledInput,
		});
		this.setting.addItem({
			title: "LangSmith API Key",
			description: "LangSmith API Key (lsv2_...)",
			actionElement: lsKeyInput,
		});
		this.setting.addItem({
			title: "LangSmith Endpoint",
			description: "LangSmith API endpoint. EU region: https://eu.api.smith.langchain.com",
			actionElement: lsEndpointInput,
		});
		this.setting.addItem({
			title: "LangSmith Project",
			description: "Project name for grouping traces (default: SiYuan-Agent)",
			actionElement: lsProjectInput,
		});

		/* Load saved values when settings panel opens */
		const origOpen = this.setting.open.bind(this.setting);
		this.setting.open = async (name: string) => {
			const config = this.getConfig();
			apiBaseInput.value = config.apiBaseURL;
			apiKeyInput.value = config.apiKey;
			modelInput.value = config.model;
			customInstructionsInput.value = config.customInstructions || "";
			setGuideDoc(config.guideDoc || null);
			selectedNotebook = config.defaultNotebook || null;
			lsEnabledInput.checked = config.langSmithEnabled || false;
			lsKeyInput.value = config.langSmithApiKey || "";
			lsEndpointInput.value = config.langSmithEndpoint || DEFAULT_CONFIG.langSmithEndpoint;
			lsProjectInput.value = config.langSmithProject || "";

			/* Populate notebook list */
			try {
				const resp = await fetch("/api/notebook/lsNotebooks", { method: "POST" });
				const data = await resp.json();
				const notebooks: { id: string; name: string; closed: boolean }[] =
					(data.data?.notebooks || []).filter((nb: any) => !nb.closed);
				notebookSelect.innerHTML =
					`<option value="">（不指定）</option>` +
					notebooks.map(nb =>
						`<option value="${nb.id}">${nb.name}</option>`
					).join("");
				if (selectedNotebook?.id) {
					notebookSelect.value = selectedNotebook.id;
					/* Sync text in case name changed */
					const matched = notebooks.find(nb => nb.id === selectedNotebook.id);
					if (matched) selectedNotebook.name = matched.name;
				}
			} catch (e) {
				notebookSelect.innerHTML = `<option value="">（加载失败）</option>`;
			}

			origOpen(name);
		};
	}
}
