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
import { AgentConfig, DEFAULT_CONFIG, ModelConfig, MODEL_PROVIDER_PRESETS, genModelId, type McpServerConfig } from "./types";
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
					custom.element.innerHTML = `<div class="fn__flex-1" style="height:100%;overflow:hidden"></div>`;
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

		/* ── Model management ─────────────────────────────────────── */
		let modelConfigs: ModelConfig[] = [];
		let defaultModelId = "";
		let subAgentModelId = "";

		const modelListEl = document.createElement("div");
		modelListEl.className = "agent-model-list";

		const defaultModelSelect = document.createElement("select");
		defaultModelSelect.className = "b3-select fn__block";

		const subAgentModelSelect = document.createElement("select");
		subAgentModelSelect.className = "b3-select fn__block";

		const refreshModelSelects = () => {
			const buildOptions = (selectedId: string) => {
				let html = `<option value="">（使用基础配置）</option>`;
				for (const m of modelConfigs) {
					const sel = m.id === selectedId ? " selected" : "";
					html += `<option value="${m.id}"${sel}>${m.name} (${m.model})</option>`;
				}
				return html;
			};
			defaultModelSelect.innerHTML = buildOptions(defaultModelId);
			subAgentModelSelect.innerHTML = buildOptions(subAgentModelId);
		};

		const renderModelList = () => {
			modelListEl.innerHTML = "";
			if (modelConfigs.length === 0) {
				modelListEl.innerHTML = `<div class="agent-model-list__empty">尚未配置模型。点击下方按钮添加。</div>`;
			}
			for (const m of modelConfigs) {
				const row = document.createElement("div");
				row.className = "agent-model-list__item";
				row.innerHTML = `
					<div class="agent-model-list__info">
						<span class="agent-model-list__name">${m.name}</span>
						<span class="agent-model-list__detail">${m.provider} · ${m.model}</span>
					</div>
					<div class="agent-model-list__actions">
						<button class="b3-button b3-button--small b3-button--outline" data-action="edit">编辑</button>
						<button class="b3-button b3-button--small b3-button--outline b3-button--error" data-action="delete">删除</button>
					</div>`;
				row.querySelector("[data-action=edit]")!.addEventListener("click", () => openModelEditor(m));
				row.querySelector("[data-action=delete]")!.addEventListener("click", () => {
					modelConfigs = modelConfigs.filter(c => c.id !== m.id);
					if (defaultModelId === m.id) defaultModelId = "";
					if (subAgentModelId === m.id) subAgentModelId = "";
					renderModelList();
					refreshModelSelects();
				});
				modelListEl.appendChild(row);
			}
			const addBtn = document.createElement("button");
			addBtn.className = "b3-button b3-button--small fn__block";
			addBtn.style.marginTop = "8px";
			addBtn.textContent = "+ 添加模型";
			addBtn.addEventListener("click", () => openModelEditor(null));
			modelListEl.appendChild(addBtn);
			refreshModelSelects();
		};

		const openModelEditor = (existing: ModelConfig | null) => {
			const dialog = document.createElement("div");
			dialog.className = "agent-model-editor-overlay";
			const isEdit = Boolean(existing);
			const m: ModelConfig = existing ? { ...existing } : {
				id: genModelId(),
				name: "",
				provider: "openai",
				model: "",
				apiBaseURL: "https://api.openai.com/v1",
				apiKey: "",
			};
			const preset = MODEL_PROVIDER_PRESETS.find(p => p.provider === m.provider);
			dialog.innerHTML = `
				<div class="agent-model-editor">
					<h4 class="agent-model-editor__title">${isEdit ? "编辑模型" : "添加模型"}</h4>
					<label class="agent-model-editor__label">供应商
						<select class="b3-select fn__block" data-field="provider">
							${MODEL_PROVIDER_PRESETS.map(p => `<option value="${p.provider}" ${p.provider === m.provider ? "selected" : ""}>${p.label}</option>`).join("")}
						</select>
					</label>
					<label class="agent-model-editor__label">显示名称
						<input class="b3-text-field fn__block" data-field="name" value="${m.name}" placeholder="My GPT-4o" />
					</label>
					<label class="agent-model-editor__label">模型
						<div style="display:flex;gap:4px">
							<input class="b3-text-field" style="flex:1" data-field="model" value="${m.model}" placeholder="gpt-4o" list="agent-model-suggestions" />
							<datalist id="agent-model-suggestions">
								${(preset?.models || []).map(n => `<option value="${n}">`).join("")}
							</datalist>
						</div>
					</label>
					<label class="agent-model-editor__label">API Base URL
						<input class="b3-text-field fn__block" data-field="apiBaseURL" value="${m.apiBaseURL}" placeholder="https://api.openai.com/v1" />
					</label>
					<label class="agent-model-editor__label">API Key
						<input class="b3-text-field fn__block" type="password" data-field="apiKey" value="${m.apiKey}" placeholder="sk-..." />
					</label>
					<label class="agent-model-editor__label">Temperature（可选）
						<input class="b3-text-field fn__block" type="number" step="0.1" min="0" max="2" data-field="temperature" value="${m.temperature ?? ""}" placeholder="0" />
					</label>
					<div class="agent-model-editor__buttons">
						<button class="b3-button b3-button--outline" data-action="cancel">取消</button>
						<button class="b3-button b3-button--text" data-action="save">保存</button>
					</div>
				</div>`;

			const providerSelect = dialog.querySelector("[data-field=provider]") as HTMLSelectElement;
			const modelField = dialog.querySelector("[data-field=model]") as HTMLInputElement;
			const baseUrlField = dialog.querySelector("[data-field=apiBaseURL]") as HTMLInputElement;
			const nameField = dialog.querySelector("[data-field=name]") as HTMLInputElement;
			const datalist = dialog.querySelector("#agent-model-suggestions") as HTMLDataListElement;

			providerSelect.addEventListener("change", () => {
				const p = MODEL_PROVIDER_PRESETS.find(pp => pp.provider === providerSelect.value);
				if (p) {
					baseUrlField.value = p.apiBaseURL;
					datalist.innerHTML = p.models.map(n => `<option value="${n}">`).join("");
					if (!nameField.value && p.models[0]) {
						modelField.value = p.models[0];
						nameField.value = `${p.label} ${p.models[0]}`;
					}
				}
			});

			dialog.querySelector("[data-action=cancel]")!.addEventListener("click", () => dialog.remove());
			dialog.querySelector("[data-action=save]")!.addEventListener("click", () => {
				m.provider = providerSelect.value;
				m.name = nameField.value || modelField.value || "Unnamed Model";
				m.model = modelField.value;
				m.apiBaseURL = baseUrlField.value;
				m.apiKey = (dialog.querySelector("[data-field=apiKey]") as HTMLInputElement).value;
				const tempVal = (dialog.querySelector("[data-field=temperature]") as HTMLInputElement).value;
				m.temperature = tempVal ? parseFloat(tempVal) : undefined;

				if (!m.model) { showMessage("请填写模型名称"); return; }

				if (isEdit) {
					const idx = modelConfigs.findIndex(c => c.id === m.id);
					if (idx >= 0) modelConfigs[idx] = m;
				} else {
					modelConfigs.push(m);
				}
				renderModelList();
				dialog.remove();
			});
			dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.remove(); });
			document.body.appendChild(dialog);
		};

		defaultModelSelect.addEventListener("change", () => { defaultModelId = defaultModelSelect.value; });
		subAgentModelSelect.addEventListener("change", () => { subAgentModelId = subAgentModelSelect.value; });

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
				const safeKw = kw.replace(/'/g, "''");
				const stmt = kw
					? `SELECT * FROM blocks WHERE type='d' AND content LIKE '%${safeKw}%' ORDER BY updated DESC LIMIT 8`
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

		/* ── MCP Servers ──────────────────────────────────────────────── */
		let mcpServerConfigs: McpServerConfig[] = [];
		const mcpListEl = document.createElement("div");
		mcpListEl.className = "agent-model-list";

		const renderMcpList = () => {
			mcpListEl.innerHTML = "";
			if (mcpServerConfigs.length === 0) {
				mcpListEl.innerHTML = `<div class="agent-model-list__empty">尚未配置 MCP 服务。点击「添加」连接外部工具服务。</div>`;
				return;
			}
			for (const srv of mcpServerConfigs) {
				const row = document.createElement("div");
				row.className = "agent-model-list__item";
				const status = this.mcpManager.getStatuses().find(s => s.serverId === srv.id);
				const statusIcon = !srv.enabled ? "⏸" : status?.connected ? "✅" : status?.error ? "❌" : "⏳";
				const statusText = !srv.enabled ? "已禁用" : status?.connected ? `已连接 (${status.toolCount} 工具)` : status?.error ? "连接失败" : "未连接";
				row.innerHTML = `
					<div class="agent-model-list__info">
						<span class="agent-model-list__name">${statusIcon} ${srv.name}</span>
						<span class="agent-model-list__detail">${srv.url} · ${statusText}</span>
					</div>
					<div class="agent-model-list__actions">
						<button class="b3-button b3-button--outline" data-action="toggle">${srv.enabled ? "禁用" : "启用"}</button>
						<button class="b3-button b3-button--outline" data-action="edit">编辑</button>
						<button class="b3-button b3-button--outline" data-action="delete">删除</button>
					</div>`;
				row.querySelector('[data-action="toggle"]')!.addEventListener("click", () => {
					srv.enabled = !srv.enabled;
					renderMcpList();
				});
				row.querySelector('[data-action="edit"]')!.addEventListener("click", () => {
					openMcpEditor(srv);
				});
				row.querySelector('[data-action="delete"]')!.addEventListener("click", () => {
					mcpServerConfigs = mcpServerConfigs.filter(s => s.id !== srv.id);
					renderMcpList();
				});
				mcpListEl.appendChild(row);
			}
		};

		const openMcpEditor = (existing?: McpServerConfig) => {
			const overlay = document.createElement("div");
			overlay.className = "agent-model-editor-overlay";
			overlay.innerHTML = `
				<div class="agent-model-editor">
					<h3>${existing ? "编辑 MCP 服务" : "添加 MCP 服务"}</h3>
					<label class="agent-model-editor__field">
						<span>名称</span>
						<input class="b3-text-field" data-key="name" value="${existing?.name || ""}" placeholder="My MCP Server" />
					</label>
					<label class="agent-model-editor__field">
						<span>URL (SSE 端点)</span>
						<input class="b3-text-field" data-key="url" value="${existing?.url || ""}" placeholder="http://localhost:3000/sse" />
					</label>
					<label class="agent-model-editor__field">
						<span>API Key (可选)</span>
						<input class="b3-text-field" data-key="apiKey" type="password" value="${existing?.apiKey || ""}" placeholder="可选的认证密钥" />
					</label>
					<label class="agent-model-editor__field">
						<span>描述 (可选)</span>
						<input class="b3-text-field" data-key="description" value="${existing?.description || ""}" placeholder="这个服务提供什么工具？" />
					</label>
					<div class="agent-model-editor__buttons">
						<button class="b3-button b3-button--outline" data-action="cancel">取消</button>
						<button class="b3-button b3-button--text" data-action="save">保存</button>
					</div>
				</div>`;
			overlay.querySelector('[data-action="cancel"]')!.addEventListener("click", () => overlay.remove());
			overlay.querySelector('[data-action="save"]')!.addEventListener("click", () => {
				const nameVal = (overlay.querySelector('[data-key="name"]') as HTMLInputElement).value.trim();
				const urlVal = (overlay.querySelector('[data-key="url"]') as HTMLInputElement).value.trim();
				const apiKeyVal = (overlay.querySelector('[data-key="apiKey"]') as HTMLInputElement).value.trim();
				const descVal = (overlay.querySelector('[data-key="description"]') as HTMLInputElement).value.trim();
				if (!nameVal || !urlVal) { showMessage("名称和 URL 不能为空"); return; }
				if (existing) {
					existing.name = nameVal;
					existing.url = urlVal;
					existing.apiKey = apiKeyVal || undefined;
					existing.description = descVal || undefined;
				} else {
					mcpServerConfigs.push({
						id: genModelId(),
						name: nameVal,
						url: urlVal,
						enabled: true,
						apiKey: apiKeyVal || undefined,
						description: descVal || undefined,
					});
				}
				overlay.remove();
				renderMcpList();
			});
			document.body.appendChild(overlay);
		};

		const mcpAddBtn = document.createElement("button");
		mcpAddBtn.className = "b3-button b3-button--outline";
		mcpAddBtn.textContent = "添加 MCP 服务";
		mcpAddBtn.addEventListener("click", () => openMcpEditor());

		const mcpContainer = document.createElement("div");
		mcpContainer.appendChild(mcpListEl);
		mcpContainer.appendChild(mcpAddBtn);

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
					models: modelConfigs,
					defaultModelId,
					subAgentModelId,
					mcpServers: mcpServerConfigs,
					langSmithEnabled: lsEnabledInput.checked,
					langSmithApiKey: lsKeyInput.value || "",
					langSmithEndpoint: lsEndpointInput.value || DEFAULT_CONFIG.langSmithEndpoint,
					langSmithProject: lsProjectInput.value || DEFAULT_CONFIG.langSmithProject,
				};
				this.saveData(CONFIG_STORAGE, config);
				// Reconnect MCP servers with updated config
				void this.mcpManager.connectAll(mcpServerConfigs.filter(s => s.enabled));
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
			title: "模型管理",
			description: "添加和管理多个 AI 模型配置。配置后可在对话中切换不同模型。",
			actionElement: modelListEl,
		});
		this.setting.addItem({
			title: "默认模型",
			description: "从模型列表中选择默认使用的模型。未选择时使用上方基础配置。",
			actionElement: defaultModelSelect,
		});
		this.setting.addItem({
			title: "子智能体模型",
			description: "探索等子智能体使用的模型（建议选择低成本模型）。未选择时使用默认模型。",
			actionElement: subAgentModelSelect,
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
			title: "MCP 外部工具服务",
			description: "连接 MCP (Model Context Protocol) 服务器，扩展 AI 可用的工具。支持 Streamable HTTP 传输。",
			actionElement: mcpContainer,
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
			modelConfigs = Array.isArray(config.models) ? config.models.map(m => ({ ...m })) : [];
			defaultModelId = config.defaultModelId || "";
			subAgentModelId = config.subAgentModelId || "";
			renderModelList();
			mcpServerConfigs = Array.isArray(config.mcpServers) ? config.mcpServers.map(s => ({ ...s })) : [];
			renderMcpList();
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
