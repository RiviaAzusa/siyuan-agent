/**
 * Settings view delegate – extracted from ChatPanel for maintainability.
 */
import { Plugin, showMessage } from "siyuan";
import {
	AgentConfig,
	DEFAULT_CONFIG,
	cloneModelServices,
	flattenModelServices,
	genModelServiceId,
	genModelId,
	type ModelServiceConfig,
	type ModelServiceModelConfig,
	type McpServerConfig,
	type ScheduledTaskMeta,
} from "../types";
import type { SettingsSection, SettingsDraft } from "./chat-helpers";
import { escapeHtml } from "./chat-helpers";

const CONFIG_STORAGE = "agent-config";

/* ── Context interface ───────────────────────────────────────────────── */

export interface SettingsViewContext {
	settingsViewEl: HTMLElement;
	plugin: Plugin;
	getConfig: () => Promise<AgentConfig>;
	refreshModelSelector: () => Promise<void>;
	openTaskEditor: (task?: ScheduledTaskMeta) => Promise<void>;
	queryDocs: (keyword: string) => Promise<Array<{ id: string; title: string }>>;
	/** Called after config is persisted – handle MCP reconnection + tool rebuild. */
	onConfigSaved: (nextConfig: AgentConfig) => Promise<void>;
}

/* ── SettingsView class ──────────────────────────────────────────────── */

export class SettingsView {
	private ctx: SettingsViewContext;
	private currentSection: SettingsSection = "general";
	private draft: SettingsDraft | null = null;
	private autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(ctx: SettingsViewContext) {
		this.ctx = ctx;
	}

	async render(): Promise<void> {
		const config = await this.ctx.getConfig();
		const notebookOptions = this.draft?.notebookOptions?.length
			? this.draft.notebookOptions
			: await this.loadNotebookOptions();
		const draft = this.draft ?? {
			customInstructions: config.customInstructions || "",
			guideDoc: config.guideDoc || null,
			defaultNotebook: config.defaultNotebook || null,
			langSmithEnabled: Boolean(config.langSmithEnabled),
			langSmithApiKey: config.langSmithApiKey || "",
			langSmithEndpoint: config.langSmithEndpoint || DEFAULT_CONFIG.langSmithEndpoint,
			langSmithProject: config.langSmithProject || DEFAULT_CONFIG.langSmithProject,
			modelServices: cloneModelServices(config.modelServices),
			defaultModelId: config.defaultModelId || "",
			subAgentModelId: config.subAgentModelId || "",
			mcpServers: Array.isArray(config.mcpServers) ? config.mcpServers.map((item) => ({ ...item })) : [],
			notebookOptions,
		};
		this.draft = draft;

		const configuredModels = flattenModelServices(draft.modelServices);
		const modelOptions = configuredModels.map((item) => `
			<option value="${escapeHtml(item.id)}"${item.id === draft.defaultModelId ? " selected" : ""}>
				${escapeHtml(item.provider)} / ${escapeHtml(item.name)} (${escapeHtml(item.model)})
			</option>
		`).join("");
		const subAgentOptions = configuredModels.map((item) => `
			<option value="${escapeHtml(item.id)}"${item.id === draft.subAgentModelId ? " selected" : ""}>
				${escapeHtml(item.provider)} / ${escapeHtml(item.name)} (${escapeHtml(item.model)})
			</option>
		`).join("");
		const notebookOptionsHtml = draft.notebookOptions.map((item) => `
			<option value="${escapeHtml(item.id)}"${item.id === draft.defaultNotebook?.id ? " selected" : ""}>
				${escapeHtml(item.name)}
			</option>
		`).join("");
		const guideDocMeta = draft.guideDoc
			? `<div><span>当前文档</span><strong>${escapeHtml(draft.guideDoc.title)}</strong></div>
				<div><span>文档 ID</span><strong>${escapeHtml(draft.guideDoc.id)}</strong></div>`
			: `<div><span>当前文档</span><strong>未设置</strong></div>
				<div><span>说明</span><strong>选择后会拼接进系统提示词</strong></div>`;
		const notebookMeta = draft.defaultNotebook
			? `<div><span>默认笔记本</span><strong>${escapeHtml(draft.defaultNotebook.name)}</strong></div>
				<div><span>笔记本 ID</span><strong>${escapeHtml(draft.defaultNotebook.id)}</strong></div>`
			: `<div><span>默认笔记本</span><strong>未设置</strong></div>
				<div><span>说明</span><strong>Agent 将优先在这里工作</strong></div>`;
		const settingsSections: Array<{ id: SettingsSection; label: string }> = [
			{ id: "general", label: "常规" },
			{ id: "model-services", label: "模型服务" },
			{ id: "default-models", label: "默认模型" },
			{ id: "tools", label: "工具扩展" },
			{ id: "tracing", label: "追踪调试" },
		];

		this.ctx.settingsViewEl.innerHTML = `
<div class="settings-panel">
	<div class="settings-panel__header">
		<div>
			<h3>设置</h3>
		</div>
	</div>
	<form class="settings-panel__form">
		<div class="settings-panel__shell">
			<aside class="settings-panel__nav">
				${settingsSections.map((section) => `
					<button
						class="settings-panel__nav-item${section.id === this.currentSection ? " settings-panel__nav-item--active" : ""}"
						type="button"
						data-settings-section="${section.id}"
					>
						<span class="settings-panel__nav-label">${section.label}</span>
					</button>
				`).join("")}
			</aside>
			<div class="settings-panel__content">
					<section class="settings-panel__section${this.currentSection === "general" ? " settings-panel__section--active" : ""}" data-settings-panel="general">
						<div class="settings-panel__section-title">常规</div>
						<label class="settings-panel__field">
							<span>自定义指令</span>
							<textarea class="b3-text-field" name="customInstructions" rows="5" placeholder="附加给 AI 的个性化指令">${escapeHtml(draft.customInstructions)}</textarea>
						</label>
						<div class="settings-panel__section-title">知识库默认项</div>
						<div class="settings-panel__picker">
							<label class="settings-panel__field">
								<span>用户指南文档</span>
								<input
									class="b3-text-field"
									name="guideDocSearch"
									data-role="guide-doc-search"
									value="${escapeHtml(draft.guideDoc?.title || "")}"
									placeholder="输入文档标题搜索..."
									autocomplete="off"
								/>
							</label>
							<div class="settings-panel__picker-dropdown b3-menu fn__none" data-role="guide-doc-dropdown"></div>
						</div>
						<div class="settings-panel__meta-grid">${guideDocMeta}</div>
						<label class="settings-panel__field">
							<span>默认工作笔记本</span>
							<select class="b3-select" name="defaultNotebookId">
								<option value="">（不指定）</option>
								${notebookOptionsHtml || "<option value=\"\">（暂无可用笔记本）</option>"}
							</select>
						</label>
						<div class="settings-panel__meta-grid">${notebookMeta}</div>
					</section>

					<section class="settings-panel__section${this.currentSection === "model-services" ? " settings-panel__section--active" : ""}" data-settings-panel="model-services">
						<div class="settings-panel__section-title">模型服务</div>
						<div class="agent-model-list">
							${draft.modelServices.length
								? draft.modelServices.map((service) => `
									<div class="agent-model-service">
										<div class="agent-model-list__item">
											<div class="agent-model-list__info">
												<span class="agent-model-list__name">${escapeHtml(service.name)}</span>
												<span class="agent-model-list__detail">${escapeHtml(service.apiBaseURL)} · ${service.models.length} 个模型</span>
											</div>
											<div class="agent-model-list__actions">
												<button class="b3-button b3-button--small b3-button--outline" type="button" data-action="add-service-model" data-service-id="${escapeHtml(service.id)}">添加模型</button>
												<button class="b3-button b3-button--small b3-button--outline" type="button" data-action="edit-model-service" data-service-id="${escapeHtml(service.id)}">编辑服务</button>
												<button class="b3-button b3-button--small b3-button--outline b3-button--error" type="button" data-action="delete-model-service" data-service-id="${escapeHtml(service.id)}">删除服务</button>
											</div>
										</div>
										<div class="agent-model-service__models">
											${service.models.length
												? service.models.map((item) => `
													<div class="agent-model-list__item agent-model-list__item--sub">
														<div class="agent-model-list__info">
															<span class="agent-model-list__name">${escapeHtml(item.name)}</span>
															<span class="agent-model-list__detail">${escapeHtml(item.model)}</span>
														</div>
														<div class="agent-model-list__actions">
															<button class="b3-button b3-button--small b3-button--outline" type="button" data-action="edit-model" data-service-id="${escapeHtml(service.id)}" data-model-id="${escapeHtml(item.id)}">编辑</button>
															<button class="b3-button b3-button--small b3-button--outline b3-button--error" type="button" data-action="delete-model" data-service-id="${escapeHtml(service.id)}" data-model-id="${escapeHtml(item.id)}">删除</button>
														</div>
													</div>
												`).join("")
												: "<div class=\"agent-model-list__empty\">尚未添加模型。</div>"}
										</div>
									</div>
								`).join("")
								: "<div class=\"agent-model-list__empty\">尚未配置模型服务。点击下方按钮添加。</div>"}
						</div>
						<div class="settings-panel__actions settings-panel__actions--inline">
							<button class="b3-button b3-button--outline" type="button" data-action="add-model-service">添加模型服务</button>
						</div>
					</section>

					<section class="settings-panel__section${this.currentSection === "default-models" ? " settings-panel__section--active" : ""}" data-settings-panel="default-models">
						<div class="settings-panel__section-title">默认模型</div>
						<label class="settings-panel__field">
							<span>对话模型</span>
							<select class="b3-select" name="defaultModelId">
								<option value="">（未设置）</option>
								${modelOptions}
							</select>
						</label>
						<label class="settings-panel__field">
							<span>子智能体模型</span>
							<select class="b3-select" name="subAgentModelId">
								<option value="">（跟随对话模型）</option>
								${subAgentOptions}
							</select>
						</label>
					</section>

				<section class="settings-panel__section${this.currentSection === "tools" ? " settings-panel__section--active" : ""}" data-settings-panel="tools">
					<div class="settings-panel__section-title">工具扩展</div>
					<div class="agent-model-list">
						${draft.mcpServers.length
							? draft.mcpServers.map((item) => `
								<div class="agent-model-list__item">
									<div class="agent-model-list__info">
										<span class="agent-model-list__name">${item.enabled ? "已启用" : "已禁用"} · ${escapeHtml(item.name)}</span>
										<span class="agent-model-list__detail">${escapeHtml(item.url)}</span>
									</div>
									<div class="agent-model-list__actions">
										<button class="b3-button b3-button--small b3-button--outline" type="button" data-action="toggle-mcp" data-mcp-id="${escapeHtml(item.id)}">${item.enabled ? "禁用" : "启用"}</button>
										<button class="b3-button b3-button--small b3-button--outline" type="button" data-action="edit-mcp" data-mcp-id="${escapeHtml(item.id)}">编辑</button>
										<button class="b3-button b3-button--small b3-button--outline b3-button--error" type="button" data-action="delete-mcp" data-mcp-id="${escapeHtml(item.id)}">删除</button>
									</div>
								</div>
							`).join("")
							: "<div class=\"agent-model-list__empty\">尚未配置 MCP 服务。</div>"}
					</div>
					<div class="settings-panel__actions settings-panel__actions--inline">
						<button class="b3-button b3-button--outline" type="button" data-action="add-mcp">添加 MCP 服务</button>
					</div>
				</section>

				<section class="settings-panel__section${this.currentSection === "tracing" ? " settings-panel__section--active" : ""}" data-settings-panel="tracing">
					<div class="settings-panel__section-title">追踪调试</div>
					<label class="settings-panel__checkbox">
						<input type="checkbox" name="langSmithEnabled"${draft.langSmithEnabled ? " checked" : ""} />
						<span>启用 LangSmith Tracing</span>
					</label>
					<label class="settings-panel__field">
						<span>LangSmith API Key</span>
						<input class="b3-text-field" name="langSmithApiKey" type="password" value="${escapeHtml(draft.langSmithApiKey)}" placeholder="lsv2_..." />
					</label>
					<label class="settings-panel__field">
						<span>LangSmith Endpoint</span>
						<input class="b3-text-field" name="langSmithEndpoint" value="${escapeHtml(draft.langSmithEndpoint)}" placeholder="https://api.smith.langchain.com" />
					</label>
					<label class="settings-panel__field">
						<span>LangSmith Project</span>
						<input class="b3-text-field" name="langSmithProject" value="${escapeHtml(draft.langSmithProject)}" placeholder="SiYuan-Agent" />
					</label>
				</section>
			</div>
		</div>
	</form>
</div>`;

		const form = this.ctx.settingsViewEl.querySelector<HTMLFormElement>(".settings-panel__form");
		form?.addEventListener("submit", (event) => {
			event.preventDefault();
			void this.saveForm(form);
		});

		/* Auto-save: immediate on select/checkbox change, debounced on text input */
		const scheduleAutoSave = (immediate = false): void => {
			if (!form) return;
			if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
			if (immediate) {
				void this.saveForm(form);
			} else {
				this.autoSaveTimer = setTimeout(() => {
					void this.saveForm(form);
				}, 600);
			}
		};
		form?.addEventListener("change", (e) => {
			const target = e.target as HTMLElement;
			const isText = target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && (target as HTMLInputElement).type === "text");
			if (!isText) scheduleAutoSave(true);
		});
		form?.addEventListener("input", (e) => {
			const target = e.target as HTMLElement;
			const isText = target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && (target as HTMLInputElement).type !== "checkbox");
			if (isText) scheduleAutoSave(false);
		});
		this.ctx.settingsViewEl.querySelectorAll<HTMLElement>("[data-settings-section]").forEach((button) => {
			button.addEventListener("click", () => {
				const section = button.dataset.settingsSection as SettingsSection | undefined;
				if (!section) return;
				this.currentSection = section;
				this.setSection(section);
			});
		});
		this.bindGuideDocPicker();
		this.bindModelActions();
		this.bindMcpActions();
		this.ctx.settingsViewEl.querySelector<HTMLSelectElement>("select[name='defaultNotebookId']")?.addEventListener("change", (event) => {
			this.syncDraftFromForm();
			const value = (event.currentTarget as HTMLSelectElement).value;
			const nextNotebook = draft.notebookOptions.find((item) => item.id === value) || null;
			this.draft = {
				...draft,
				defaultNotebook: nextNotebook ? { ...nextNotebook } : null,
			};
			void this.render();
		});
	}

	private async saveForm(form: HTMLFormElement): Promise<void> {
		const formData = new FormData(form);
		this.syncDraftFromForm();
		const currentConfig = await this.ctx.getConfig();
		const draft = this.draft;
		if (!draft) return;
		const nextConfig: AgentConfig = {
			...currentConfig,
			customInstructions: String(formData.get("customInstructions") || ""),
			guideDoc: draft.guideDoc,
			defaultNotebook: draft.defaultNotebook,
			modelServices: cloneModelServices(draft.modelServices),
			models: [],
			defaultModelId: String(formData.get("defaultModelId") || "").trim(),
			subAgentModelId: String(formData.get("subAgentModelId") || "").trim(),
			mcpServers: draft.mcpServers.map((item) => ({ ...item })),
			langSmithEnabled: formData.get("langSmithEnabled") === "on",
			langSmithApiKey: String(formData.get("langSmithApiKey") || "").trim(),
			langSmithEndpoint: String(formData.get("langSmithEndpoint") || "").trim() || DEFAULT_CONFIG.langSmithEndpoint,
			langSmithProject: String(formData.get("langSmithProject") || "").trim() || DEFAULT_CONFIG.langSmithProject,
		};
		this.ctx.plugin.data[CONFIG_STORAGE] = nextConfig;
		await this.ctx.plugin.saveData(CONFIG_STORAGE, nextConfig);
		await this.ctx.onConfigSaved(nextConfig);
		this.draft = {
			...draft,
			customInstructions: nextConfig.customInstructions,
			guideDoc: nextConfig.guideDoc || null,
			defaultNotebook: nextConfig.defaultNotebook || null,
			langSmithEnabled: Boolean(nextConfig.langSmithEnabled),
			langSmithApiKey: nextConfig.langSmithApiKey || "",
			langSmithEndpoint: nextConfig.langSmithEndpoint || DEFAULT_CONFIG.langSmithEndpoint,
			langSmithProject: nextConfig.langSmithProject || DEFAULT_CONFIG.langSmithProject,
			modelServices: cloneModelServices(nextConfig.modelServices),
			defaultModelId: nextConfig.defaultModelId || "",
			subAgentModelId: nextConfig.subAgentModelId || "",
			mcpServers: (nextConfig.mcpServers || []).map((item) => ({ ...item })),
			notebookOptions: draft.notebookOptions,
		};
		await this.ctx.refreshModelSelector();
		void this.render();
	}

	private setSection(section: SettingsSection): void {
		this.ctx.settingsViewEl.querySelectorAll<HTMLElement>("[data-settings-section]").forEach((button) => {
			button.classList.toggle("settings-panel__nav-item--active", button.dataset.settingsSection === section);
		});
		this.ctx.settingsViewEl.querySelectorAll<HTMLElement>("[data-settings-panel]").forEach((panel) => {
			panel.classList.toggle("settings-panel__section--active", panel.dataset.settingsPanel === section);
		});
	}

	private syncDraftFromForm(): void {
		if (!this.draft) return;
		const form = this.ctx.settingsViewEl.querySelector<HTMLFormElement>(".settings-panel__form");
		if (!form) return;
		const guideDocInput = form.querySelector<HTMLInputElement>("[data-role='guide-doc-search']");
		const notebookSelect = form.querySelector<HTMLSelectElement>("select[name='defaultNotebookId']");
		const guideDocTitle = guideDocInput?.value.trim() || "";
		if (!guideDocTitle) {
			this.draft.guideDoc = null;
		} else if (this.draft.guideDoc?.title !== guideDocTitle) {
			this.draft.guideDoc = null;
		}
		const notebookId = notebookSelect?.value || "";
		const notebook = this.draft.notebookOptions.find((item) => item.id === notebookId) || null;
		this.draft.defaultNotebook = notebook ? { ...notebook } : null;
	}

	private bindGuideDocPicker(): void {
		const input = this.ctx.settingsViewEl.querySelector<HTMLInputElement>("[data-role='guide-doc-search']");
		const dropdown = this.ctx.settingsViewEl.querySelector<HTMLElement>("[data-role='guide-doc-dropdown']");
		if (!input || !dropdown) return;
		let timer: ReturnType<typeof setTimeout> | null = null;

		input.addEventListener("input", () => {
			if (this.draft) {
				this.draft.guideDoc = null;
			}
			if (timer) clearTimeout(timer);
			const keyword = input.value.trim();
			timer = setTimeout(async () => {
				const docs = await this.ctx.queryDocs(keyword);
				if (docs.length === 0) {
					dropdown.classList.add("fn__none");
					dropdown.innerHTML = "";
					return;
				}
				dropdown.innerHTML = docs.map((doc) => `
					<div class="b3-menu__item" data-guide-doc-id="${escapeHtml(doc.id)}" data-guide-doc-title="${escapeHtml(doc.title)}">
						<span class="b3-menu__label">${escapeHtml(doc.title)}</span>
					</div>
				`).join("");
				dropdown.querySelectorAll<HTMLElement>("[data-guide-doc-id]").forEach((item) => {
					item.addEventListener("mousedown", (event) => {
						event.preventDefault();
						if (!this.draft) return;
						this.syncDraftFromForm();
						this.draft.guideDoc = {
							id: item.dataset.guideDocId || "",
							title: item.dataset.guideDocTitle || "",
						};
						void this.render();
					});
				});
				dropdown.classList.remove("fn__none");
			}, 180);
		});

		input.addEventListener("blur", () => {
			setTimeout(() => dropdown.classList.add("fn__none"), 120);
		});

		this.ctx.settingsViewEl.querySelector<HTMLElement>("[data-action='clear-guide-doc']")?.addEventListener("click", () => {
			if (!this.draft) return;
			this.syncDraftFromForm();
			this.draft.guideDoc = null;
			void this.render();
		});
	}

	private bindModelActions(): void {
		this.ctx.settingsViewEl.querySelector<HTMLElement>("[data-action='add-model-service']")?.addEventListener("click", () => {
			this.syncDraftFromForm();
			this.openModelServiceEditor();
		});
		this.ctx.settingsViewEl.querySelectorAll<HTMLElement>("[data-action='edit-model-service']").forEach((button) => {
			button.addEventListener("click", () => {
				this.syncDraftFromForm();
				this.openModelServiceEditor(button.dataset.serviceId);
			});
		});
		this.ctx.settingsViewEl.querySelectorAll<HTMLElement>("[data-action='delete-model-service']").forEach((button) => {
			button.addEventListener("click", () => {
				if (!this.draft) return;
				this.syncDraftFromForm();
				const serviceId = button.dataset.serviceId || "";
				const service = this.draft.modelServices.find((item) => item.id === serviceId);
				if (!service) return;
				const removedModelIds = new Set(service.models.map((item) => item.id));
				this.draft.modelServices = this.draft.modelServices.filter((item) => item.id !== serviceId);
				if (removedModelIds.has(this.draft.defaultModelId)) this.draft.defaultModelId = "";
				if (removedModelIds.has(this.draft.subAgentModelId)) this.draft.subAgentModelId = "";
				void this.render();
			});
		});
		this.ctx.settingsViewEl.querySelectorAll<HTMLElement>("[data-action='add-service-model']").forEach((button) => {
			button.addEventListener("click", () => {
				this.syncDraftFromForm();
				this.openServiceModelEditor(button.dataset.serviceId || "");
			});
		});
		this.ctx.settingsViewEl.querySelectorAll<HTMLElement>("[data-action='edit-model']").forEach((button) => {
			button.addEventListener("click", () => {
				this.syncDraftFromForm();
				this.openServiceModelEditor(button.dataset.serviceId || "", button.dataset.modelId);
			});
		});
		this.ctx.settingsViewEl.querySelectorAll<HTMLElement>("[data-action='delete-model']").forEach((button) => {
			button.addEventListener("click", () => {
				if (!this.draft) return;
				this.syncDraftFromForm();
				const serviceId = button.dataset.serviceId || "";
				const modelId = button.dataset.modelId || "";
				const service = this.draft.modelServices.find((item) => item.id === serviceId);
				if (!service) return;
				service.models = service.models.filter((item) => item.id !== modelId);
				if (this.draft.defaultModelId === modelId) this.draft.defaultModelId = "";
				if (this.draft.subAgentModelId === modelId) this.draft.subAgentModelId = "";
				void this.render();
			});
		});
	}

	private openModelServiceEditor(serviceId?: string): void {
		if (!this.draft) return;
		const existing = this.draft.modelServices.find((item) => item.id === serviceId) || null;
		const draftService: ModelServiceConfig = existing ? {
			...existing,
			models: existing.models.map((item) => ({ ...item })),
		} : {
			id: genModelServiceId(),
			name: "",
			apiBaseURL: DEFAULT_CONFIG.apiBaseURL,
			apiKey: "",
			models: [],
		};
		const overlay = document.createElement("div");
		overlay.className = "agent-model-editor-overlay";
		overlay.innerHTML = `
			<div class="agent-model-editor">
				<h4 class="agent-model-editor__title">${existing ? "编辑模型服务" : "添加模型服务"}</h4>
				<label class="agent-model-editor__label">服务名称
					<input class="b3-text-field fn__block" data-field="name" value="${escapeHtml(draftService.name)}" placeholder="OpenAI / Azure / 自建网关" />
				</label>
				<label class="agent-model-editor__label">API Base URL
					<input class="b3-text-field fn__block" data-field="apiBaseURL" value="${escapeHtml(draftService.apiBaseURL)}" placeholder="https://api.openai.com/v1" />
				</label>
				<label class="agent-model-editor__label">API Key
					<input class="b3-text-field fn__block" type="password" data-field="apiKey" value="${escapeHtml(draftService.apiKey)}" placeholder="sk-..." />
				</label>
				<div class="agent-model-editor__buttons">
					<button class="b3-button b3-button--outline" type="button" data-action="cancel">取消</button>
					<button class="b3-button b3-button--text" type="button" data-action="save">保存</button>
				</div>
			</div>`;
		const nameField = overlay.querySelector<HTMLInputElement>("[data-field='name']");
		const baseUrlField = overlay.querySelector<HTMLInputElement>("[data-field='apiBaseURL']");
		overlay.querySelector<HTMLElement>("[data-action='cancel']")?.addEventListener("click", () => overlay.remove());
		overlay.querySelector<HTMLElement>("[data-action='save']")?.addEventListener("click", () => {
			if (!this.draft) return;
			const nextService: ModelServiceConfig = {
				...draftService,
				name: nameField?.value.trim() || "Unnamed Service",
				apiBaseURL: baseUrlField?.value.trim() || DEFAULT_CONFIG.apiBaseURL,
				apiKey: overlay.querySelector<HTMLInputElement>("[data-field='apiKey']")?.value.trim() || "",
			};
			if (!nextService.name.trim()) {
				showMessage("请填写服务名称");
				return;
			}
			if (!nextService.apiBaseURL.trim()) {
				showMessage("请填写 API Base URL");
				return;
			}
			const existingIndex = this.draft.modelServices.findIndex((item) => item.id === nextService.id);
			if (existingIndex >= 0) {
				this.draft.modelServices[existingIndex] = nextService;
			} else {
				this.draft.modelServices.push(nextService);
			}
			overlay.remove();
			void this.render();
		});
		overlay.addEventListener("click", (event) => {
			if (event.target === overlay) overlay.remove();
		});
		document.body.appendChild(overlay);
	}

	private openServiceModelEditor(serviceId: string, modelId?: string): void {
		if (!this.draft) return;
		const service = this.draft.modelServices.find((item) => item.id === serviceId);
		if (!service) {
			showMessage("未找到模型服务");
			return;
		}
		const existing = service.models.find((item) => item.id === modelId) || null;
		const draftModel: ModelServiceModelConfig = existing ? { ...existing } : {
			id: genModelId(),
			name: "",
			model: "",
		};
		const overlay = document.createElement("div");
		overlay.className = "agent-model-editor-overlay";
		overlay.innerHTML = `
			<div class="agent-model-editor">
				<h4 class="agent-model-editor__title">${existing ? "编辑模型" : "添加模型"}</h4>
				<label class="agent-model-editor__label">所属服务
					<input class="b3-text-field fn__block" value="${escapeHtml(service.name)}" disabled />
				</label>
				<label class="agent-model-editor__label">显示名称
					<input class="b3-text-field fn__block" data-field="name" value="${escapeHtml(draftModel.name)}" placeholder="GPT-4o / Claude Sonnet" />
				</label>
				<label class="agent-model-editor__label">模型标识
					<input class="b3-text-field fn__block" data-field="model" value="${escapeHtml(draftModel.model)}" placeholder="gpt-4o" />
				</label>
				<label class="agent-model-editor__label">Temperature（可选）
					<input class="b3-text-field fn__block" type="number" step="0.1" min="0" max="2" data-field="temperature" value="${draftModel.temperature ?? ""}" placeholder="0" />
				</label>
				<div class="agent-model-editor__buttons">
					<button class="b3-button b3-button--outline" type="button" data-action="cancel">取消</button>
					<button class="b3-button b3-button--text" type="button" data-action="save">保存</button>
				</div>
			</div>`;
		const nameField = overlay.querySelector<HTMLInputElement>("[data-field='name']");
		const modelField = overlay.querySelector<HTMLInputElement>("[data-field='model']");
		overlay.querySelector<HTMLElement>("[data-action='cancel']")?.addEventListener("click", () => overlay.remove());
		overlay.querySelector<HTMLElement>("[data-action='save']")?.addEventListener("click", () => {
			if (!this.draft) return;
			const nextService = this.draft.modelServices.find((item) => item.id === serviceId);
			if (!nextService) return;
			const nextModel: ModelServiceModelConfig = {
				...draftModel,
				name: nameField?.value.trim() || modelField?.value.trim() || "Unnamed Model",
				model: modelField?.value.trim() || "",
			};
			const temperature = overlay.querySelector<HTMLInputElement>("[data-field='temperature']")?.value.trim() || "";
			nextModel.temperature = temperature ? Number(temperature) : undefined;
			if (!nextModel.model) {
				showMessage("请填写模型标识");
				return;
			}
			const existingIndex = nextService.models.findIndex((item) => item.id === nextModel.id);
			if (existingIndex >= 0) {
				nextService.models[existingIndex] = nextModel;
			} else {
				nextService.models.push(nextModel);
			}
			overlay.remove();
			void this.render();
		});
		overlay.addEventListener("click", (event) => {
			if (event.target === overlay) overlay.remove();
		});
		document.body.appendChild(overlay);
	}

	private bindMcpActions(): void {
		this.ctx.settingsViewEl.querySelector<HTMLElement>("[data-action='add-mcp']")?.addEventListener("click", () => {
			this.syncDraftFromForm();
			this.openMcpEditor();
		});
		this.ctx.settingsViewEl.querySelectorAll<HTMLElement>("[data-action='edit-mcp']").forEach((button) => {
			button.addEventListener("click", () => {
				this.syncDraftFromForm();
				this.openMcpEditor(button.dataset.mcpId);
			});
		});
		this.ctx.settingsViewEl.querySelectorAll<HTMLElement>("[data-action='toggle-mcp']").forEach((button) => {
			button.addEventListener("click", () => {
				if (!this.draft) return;
				this.syncDraftFromForm();
				const server = this.draft.mcpServers.find((item) => item.id === button.dataset.mcpId);
				if (!server) return;
				server.enabled = !server.enabled;
				void this.render();
			});
		});
		this.ctx.settingsViewEl.querySelectorAll<HTMLElement>("[data-action='delete-mcp']").forEach((button) => {
			button.addEventListener("click", () => {
				if (!this.draft) return;
				this.syncDraftFromForm();
				this.draft.mcpServers = this.draft.mcpServers.filter((item) => item.id !== button.dataset.mcpId);
				void this.render();
			});
		});
	}

	private openMcpEditor(serverId?: string): void {
		if (!this.draft) return;
		const existing = this.draft.mcpServers.find((item) => item.id === serverId);
		const overlay = document.createElement("div");
		overlay.className = "agent-model-editor-overlay";
		overlay.innerHTML = `
			<div class="agent-model-editor">
				<h4 class="agent-model-editor__title">${existing ? "编辑 MCP 服务" : "添加 MCP 服务"}</h4>
				<label class="agent-model-editor__label">名称
					<input class="b3-text-field fn__block" data-field="name" value="${escapeHtml(existing?.name || "")}" placeholder="My MCP Server" />
				</label>
				<label class="agent-model-editor__label">URL (SSE / Streamable HTTP)
					<input class="b3-text-field fn__block" data-field="url" value="${escapeHtml(existing?.url || "")}" placeholder="http://localhost:3000/sse" />
				</label>
				<label class="agent-model-editor__label">API Key (可选)
					<input class="b3-text-field fn__block" data-field="apiKey" type="password" value="${escapeHtml(existing?.apiKey || "")}" placeholder="可选的认证密钥" />
				</label>
				<label class="agent-model-editor__label">描述 (可选)
					<input class="b3-text-field fn__block" data-field="description" value="${escapeHtml(existing?.description || "")}" placeholder="这个服务提供什么工具？" />
				</label>
				<div class="agent-model-editor__buttons">
					<button class="b3-button b3-button--outline" type="button" data-action="cancel">取消</button>
					<button class="b3-button b3-button--text" type="button" data-action="save">保存</button>
				</div>
			</div>`;
		overlay.querySelector<HTMLElement>("[data-action='cancel']")?.addEventListener("click", () => overlay.remove());
		overlay.querySelector<HTMLElement>("[data-action='save']")?.addEventListener("click", () => {
			if (!this.draft) return;
			const name = overlay.querySelector<HTMLInputElement>("[data-field='name']")?.value.trim() || "";
			const url = overlay.querySelector<HTMLInputElement>("[data-field='url']")?.value.trim() || "";
			if (!name || !url) {
				showMessage("名称和 URL 不能为空");
				return;
			}
			const nextServer: McpServerConfig = {
				id: existing?.id || genModelId(),
				name,
				url,
				enabled: existing?.enabled ?? true,
				apiKey: overlay.querySelector<HTMLInputElement>("[data-field='apiKey']")?.value.trim() || undefined,
				description: overlay.querySelector<HTMLInputElement>("[data-field='description']")?.value.trim() || undefined,
			};
			const existingIndex = this.draft.mcpServers.findIndex((item) => item.id === nextServer.id);
			if (existingIndex >= 0) {
				this.draft.mcpServers[existingIndex] = nextServer;
			} else {
				this.draft.mcpServers.push(nextServer);
			}
			overlay.remove();
			void this.render();
		});
		overlay.addEventListener("click", (event) => {
			if (event.target === overlay) overlay.remove();
		});
		document.body.appendChild(overlay);
	}

	private async loadNotebookOptions(): Promise<Array<{ id: string; name: string }>> {
		try {
			const resp = await fetch("/api/notebook/lsNotebooks", { method: "POST" });
			const json = await resp.json();
			const notebooks = Array.isArray(json.data?.notebooks) ? json.data.notebooks : [];
			return notebooks
				.filter((item: any) => !item?.closed && typeof item?.id === "string" && typeof item?.name === "string")
				.map((item: any) => ({ id: item.id, name: item.name }));
		} catch {
			return [];
		}
	}
}
