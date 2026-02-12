import {
	Plugin,
	showMessage,
	getFrontend,
	Setting,
	adaptHotkey,
	IMenuBaseDetail,
} from "siyuan";
import "./index.scss";
import { AgentConfig, DEFAULT_CONFIG } from "./types";
import { ChatPanel } from "./ui/chat-panel";
import { getDefaultTools } from "./core/tools";

const CONFIG_STORAGE = "agent-config";
const DOCK_TYPE = "agent-chat";

export default class SiYuanAgent extends Plugin {

	private chatPanel: ChatPanel;
	private isMobile: boolean;

	onload() {
		const frontend = getFrontend();
		this.isMobile = frontend === "mobile" || frontend === "browser-mobile";

		const tools = getDefaultTools();

		this.addIcons(`<symbol id="iconAgent" viewBox="0 0 24 24">
<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-4h2v2h-2zm1-10c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z"/>
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
						this.chatPanel?.addContext(text);
						// If dock is hidden/minimized, we might want to open/show it.
						// ensuring chat panel is visible is tricky without knowing dock ID,
						// but usually user will open it if they want to chat.
					}
				});
			}
		});

		/* --- Dock panel --- */
		this.addDock({
			config: {
				position: "RightTop",
				size: { width: 360, height: 0 },
				icon: "iconAgent",
				title: "AI Agent",
				hotkey: "⌥⌘A",
			},
			data: {},
			type: DOCK_TYPE,
			init: (dock) => {
				if (this.isMobile) {
					dock.element.innerHTML = `<div class="toolbar toolbar--border toolbar--dark">
						<svg class="toolbar__icon"><use xlink:href="#iconAgent"></use></svg>
						<div class="toolbar__text">AI Agent</div>
					</div>
					<div class="fn__flex-1" style="overflow:hidden"></div>`;
					this.chatPanel = new ChatPanel(
						dock.element.querySelector(".fn__flex-1"),
						this,
						tools
					);
				} else {
					dock.element.innerHTML = `<div class="fn__flex-1 fn__flex-column" style="height:100%">
						<div class="block__icons">
							<div class="block__logo">
								<svg class="block__logoicon"><use xlink:href="#iconAgent"></use></svg>
								AI Agent
							</div>
							<span class="fn__flex-1 fn__space"></span>
							<span data-type="min" class="block__icon b3-tooltips b3-tooltips__sw" aria-label="Min ${adaptHotkey("⌘W")}">
								<svg><use xlink:href="#iconMin"></use></svg>
							</span>
						</div>
						<div class="fn__flex-1" style="overflow:hidden"></div>
					</div>`;
					this.chatPanel = new ChatPanel(
						dock.element.querySelector(".fn__flex-1:last-child"),
						this,
						tools
					);
				}
			},
			destroy: () => {
				this.chatPanel?.destroy();
				this.chatPanel = null;
			}
		});

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
					this.chatPanel?.addContext(text);
				else
					showMessage(this.i18n.noSelection || "No text selected");
			},
		});

		/* --- Settings --- */
		this.initSettings();
	}

	onLayoutReady() {
		this.loadData(CONFIG_STORAGE);
	}

	onunload() {
		this.chatPanel?.destroy();
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

		const systemPromptInput = document.createElement("textarea");
		systemPromptInput.className = "b3-text-field fn__block";
		systemPromptInput.rows = 4;

		const maxRoundsInput = document.createElement("input");
		maxRoundsInput.className = "b3-text-field fn__block";
		maxRoundsInput.type = "number";
		maxRoundsInput.min = "1";
		maxRoundsInput.max = "50";

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
				const config: AgentConfig = {
					apiBaseURL: apiBaseInput.value || DEFAULT_CONFIG.apiBaseURL,
					apiKey: apiKeyInput.value || "",
					model: modelInput.value || DEFAULT_CONFIG.model,
					systemPrompt: systemPromptInput.value || DEFAULT_CONFIG.systemPrompt,
					maxToolRounds: parseInt(maxRoundsInput.value, 10) || DEFAULT_CONFIG.maxToolRounds,
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
			title: "System Prompt",
			description: "System instructions for the AI agent",
			actionElement: systemPromptInput,
		});
		this.setting.addItem({
			title: "Max Tool Rounds",
			description: "Maximum number of tool call rounds per conversation turn",
			actionElement: maxRoundsInput,
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
		this.setting.open = (name: string) => {
			const config: AgentConfig = {
				...DEFAULT_CONFIG,
				...(this.data[CONFIG_STORAGE] || {}),
			};
			apiBaseInput.value = config.apiBaseURL;
			apiKeyInput.value = config.apiKey;
			modelInput.value = config.model;
			systemPromptInput.value = config.systemPrompt;
			maxRoundsInput.value = String(config.maxToolRounds);
			lsEnabledInput.checked = config.langSmithEnabled || false;
			lsKeyInput.value = config.langSmithApiKey || "";
			lsEndpointInput.value = config.langSmithEndpoint || DEFAULT_CONFIG.langSmithEndpoint;
			lsProjectInput.value = config.langSmithProject || "";
			origOpen(name);
		};
	}
}
