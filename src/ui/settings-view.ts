/**
 * Settings view delegate – extracted from ChatPanel for maintainability.
 */
import { Plugin, showMessage } from "siyuan";
import {
	AgentConfig,
	DEEPSEEK_API_BASE_URL,
	DEFAULT_CONFIG,
	cloneModelServices,
	flattenModelServices,
	genModelServiceId,
	genModelId,
	type ModelServiceConfig,
	type ModelServiceModelConfig,
	type ModelProviderType,
	type McpServerConfig,
	type ScheduledTaskMeta,
} from "../types";
import type { SettingsSection, SettingsDraft } from "./chat-helpers";
import { escapeHtml } from "./chat-helpers";
import { defaultTranslator, type Translator } from "../i18n";

const CONFIG_STORAGE = "agent-config";

/* ── Context interface ───────────────────────────────────────────────── */

export interface SettingsViewContext {
	settingsViewEl: HTMLElement;
	plugin: Plugin;
	i18n?: Translator;
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
	private i18n: Translator;
	private editingModelServiceId: string | null = null;
	private editingServiceModelTarget: { serviceId: string; modelId?: string } | null = null;

	constructor(ctx: SettingsViewContext) {
		this.ctx = ctx;
		this.i18n = ctx.i18n || defaultTranslator;
	}

	private t(key: string, params?: Record<string, string | number | boolean | null | undefined>, fallback?: string): string {
		return this.i18n.t(key, params, fallback);
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
			? `<div><span>${escapeHtml(this.t("settings.currentDoc"))}</span><strong>${escapeHtml(draft.guideDoc.title)}</strong></div>
				<div><span>${escapeHtml(this.t("settings.docId"))}</span><strong>${escapeHtml(draft.guideDoc.id)}</strong></div>`
			: `<div><span>${escapeHtml(this.t("settings.currentDoc"))}</span><strong>${escapeHtml(this.t("common.notSet"))}</strong></div>
				<div><span>${escapeHtml(this.t("settings.guideDoc.helpLabel"))}</span><strong>${escapeHtml(this.t("settings.guideDoc.help"))}</strong></div>`;
		const notebookMeta = draft.defaultNotebook
			? `<div><span>${escapeHtml(this.t("settings.defaultNotebook"))}</span><strong>${escapeHtml(draft.defaultNotebook.name)}</strong></div>
				<div><span>${escapeHtml(this.t("settings.defaultNotebookId"))}</span><strong>${escapeHtml(draft.defaultNotebook.id)}</strong></div>`
			: `<div><span>${escapeHtml(this.t("settings.defaultNotebook"))}</span><strong>${escapeHtml(this.t("common.notSet"))}</strong></div>
				<div><span>${escapeHtml(this.t("settings.guideDoc.helpLabel"))}</span><strong>${escapeHtml(this.t("settings.defaultNotebook.help"))}</strong></div>`;
		const settingsSections: Array<{ id: SettingsSection; label: string }> = [
			{ id: "general", label: this.t("settings.nav.general") },
			{ id: "model-services", label: this.t("settings.nav.modelServices") },
			{ id: "default-models", label: this.t("settings.nav.defaultModels") },
			{ id: "tracing", label: this.t("settings.nav.tracing") },
		];
		const modelServicesHtml = this.renderModelServices(draft.modelServices);

		this.ctx.settingsViewEl.innerHTML = `
<div class="settings-panel">
	<div class="settings-panel__header">
		<div>
			<h3>${escapeHtml(this.t("settings.title"))}</h3>
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
						<div class="settings-panel__section-title">${escapeHtml(this.t("settings.general.title"))}</div>
						<label class="settings-panel__field">
							<span>${escapeHtml(this.t("settings.customInstructions"))}</span>
							<textarea class="b3-text-field" name="customInstructions" rows="5" placeholder="${escapeHtml(this.t("settings.customInstructions.placeholder"))}">${escapeHtml(draft.customInstructions)}</textarea>
						</label>
						<div class="settings-panel__section-title">${escapeHtml(this.t("settings.defaults.title"))}</div>
						<div class="settings-panel__picker">
							<label class="settings-panel__field">
								<span>${escapeHtml(this.t("settings.guideDoc"))}</span>
								<input
									class="b3-text-field"
									name="guideDocSearch"
									data-role="guide-doc-search"
									value="${escapeHtml(draft.guideDoc?.title || "")}"
									placeholder="${escapeHtml(this.t("settings.guideDoc.placeholder"))}"
									autocomplete="off"
								/>
							</label>
							<div class="settings-panel__picker-dropdown b3-menu fn__none" data-role="guide-doc-dropdown"></div>
						</div>
						<div class="settings-panel__meta-grid">${guideDocMeta}</div>
						<label class="settings-panel__field">
							<span>${escapeHtml(this.t("settings.defaultNotebook"))}</span>
							<select class="b3-select" name="defaultNotebookId">
								<option value="">${escapeHtml(this.t("settings.defaultNotebook.none"))}</option>
								${notebookOptionsHtml || `<option value="">${escapeHtml(this.t("settings.defaultNotebook.empty"))}</option>`}
							</select>
						</label>
						<div class="settings-panel__meta-grid">${notebookMeta}</div>
					</section>

					<section class="settings-panel__section${this.currentSection === "model-services" ? " settings-panel__section--active" : ""}" data-settings-panel="model-services">
						<div class="agent-model-section__header">
							<div class="settings-panel__section-title">${escapeHtml(this.t("settings.modelServices.title"))}</div>
							<button class="b3-button b3-button--outline" type="button" data-action="add-model-service">${escapeHtml(this.t("settings.modelServices.addServiceInline"))}</button>
						</div>
						${modelServicesHtml}
					</section>

					<section class="settings-panel__section${this.currentSection === "default-models" ? " settings-panel__section--active" : ""}" data-settings-panel="default-models">
						<div class="settings-panel__section-title">${escapeHtml(this.t("settings.defaultModels.title"))}</div>
						<label class="settings-panel__field">
							<span>${escapeHtml(this.t("settings.defaultModels.chat"))}</span>
							<select class="b3-select" name="defaultModelId">
								<option value="">${escapeHtml(this.t("settings.defaultModels.notSet"))}</option>
								${modelOptions}
							</select>
						</label>
						<label class="settings-panel__field">
							<span>${escapeHtml(this.t("settings.defaultModels.subAgent"))}</span>
							<select class="b3-select" name="subAgentModelId">
								<option value="">${escapeHtml(this.t("settings.defaultModels.followChat"))}</option>
								${subAgentOptions}
							</select>
						</label>
					</section>

				<section class="settings-panel__section${this.currentSection === "tracing" ? " settings-panel__section--active" : ""}" data-settings-panel="tracing">
					<div class="settings-panel__section-title">${escapeHtml(this.t("settings.tracing.title"))}</div>
					<label class="settings-panel__checkbox">
						<input type="checkbox" name="langSmithEnabled"${draft.langSmithEnabled ? " checked" : ""} />
						<span>${escapeHtml(this.t("settings.tracing.enable"))}</span>
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
			if (target.closest(".agent-model-inline-form")) return;
			const isText = target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && (target as HTMLInputElement).type === "text");
			if (!isText) scheduleAutoSave(true);
		});
		form?.addEventListener("input", (e) => {
			const target = e.target as HTMLElement;
			if (target.closest(".agent-model-inline-form")) return;
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

	private saveCurrentForm(): void {
		const form = this.ctx.settingsViewEl.querySelector<HTMLFormElement>(".settings-panel__form");
		if (form) {
			void this.saveForm(form);
		} else {
			void this.render();
		}
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

	private renderIconAction(action: string, icon: string, label: string, attrs = ""): string {
		return `<span class="agent-model-icon-btn block__icon block__icon--show b3-tooltips b3-tooltips__sw" role="button" tabindex="0" aria-label="${escapeHtml(label)}" data-action="${escapeHtml(action)}" ${attrs}>
			<svg style="width:16px;height:16px"><use xlink:href="${icon}"></use></svg>
		</span>`;
	}

	private renderModelServices(services: ModelServiceConfig[]): string {
		const addServiceForm = this.editingModelServiceId === "__new__" ? this.renderServiceInlineForm() : "";
		const listHtml = services.length
			? services.map((service) => this.renderModelService(service)).join("")
			: `<div class="agent-model-list__empty">${escapeHtml(this.t("settings.modelServices.emptyServices"))}</div>`;
		return `<div class="agent-model-list">${listHtml}${addServiceForm}</div>`;
	}

	private renderModelService(service: ModelServiceConfig): string {
		const providerLabel = service.providerType === "deepseek" ? "DeepSeek" : "OpenAI Compatible";
		const serviceAttrs = `data-service-id="${escapeHtml(service.id)}"`;
		const serviceForm = this.editingModelServiceId === service.id ? this.renderServiceInlineForm(service) : "";
		const modelFormAtEnd = this.editingServiceModelTarget?.serviceId === service.id && !this.editingServiceModelTarget.modelId
			? this.renderModelInlineForm(service)
			: "";
		return `
			<div class="agent-model-service">
				<div class="agent-model-service__header">
					<div class="agent-model-list__info">
						<span class="agent-model-list__name">${escapeHtml(service.name)}</span>
						<span class="agent-model-list__detail">${escapeHtml(providerLabel)} · ${escapeHtml(service.apiBaseURL)} · ${escapeHtml(this.t("settings.modelServices.count", { count: service.models.length }))}</span>
					</div>
					<div class="agent-model-list__actions">
						${this.renderIconAction("add-service-model", "#iconAdd", this.t("settings.modelServices.addModel"), serviceAttrs)}
						${this.renderIconAction("edit-model-service", "#iconEdit", this.t("settings.modelServices.editService"), serviceAttrs)}
						${this.renderIconAction("delete-model-service", "#iconTrashcan", this.t("settings.modelServices.deleteService"), serviceAttrs)}
					</div>
				</div>
				${serviceForm}
				<div class="agent-model-service__models">
					${service.models.length
						? service.models.map((item) => this.renderServiceModel(service, item)).join("")
						: `<div class="agent-model-list__empty agent-model-list__empty--sub">${escapeHtml(this.t("settings.modelServices.emptyModels"))}</div>`}
					${modelFormAtEnd}
				</div>
			</div>`;
	}

	private renderServiceModel(service: ModelServiceConfig, model: ModelServiceModelConfig): string {
		const attrs = `data-service-id="${escapeHtml(service.id)}" data-model-id="${escapeHtml(model.id)}"`;
		const modelForm = this.editingServiceModelTarget?.serviceId === service.id && this.editingServiceModelTarget.modelId === model.id
			? this.renderModelInlineForm(service, model)
			: "";
		return `
			<div class="agent-model-row">
				<div class="agent-model-list__info">
					<span class="agent-model-list__name">${escapeHtml(model.name)}</span>
					<span class="agent-model-list__detail">${escapeHtml(model.model)}</span>
				</div>
				<div class="agent-model-list__actions">
					${this.renderIconAction("edit-model", "#iconEdit", this.t("common.edit"), attrs)}
					${this.renderIconAction("delete-model", "#iconTrashcan", this.t("common.delete"), attrs)}
				</div>
			</div>
			${modelForm}`;
	}

	private renderServiceInlineForm(service?: ModelServiceConfig): string {
		const providerType = service?.providerType || "openai-compatible";
		const title = service ? this.t("settings.editor.editService") : this.t("settings.editor.addService");
		return `
			<div class="agent-model-inline-form agent-model-inline-form--service" data-inline-form="service" data-service-id="${escapeHtml(service?.id || "")}">
				<div class="agent-model-inline-form__title">${escapeHtml(title)}</div>
				<div class="agent-model-inline-form__grid">
					<label class="settings-panel__field">
						<span>${escapeHtml(this.t("settings.editor.serviceName"))}</span>
						<input class="b3-text-field" data-field="name" value="${escapeHtml(service?.name || "")}" placeholder="${escapeHtml(this.t("settings.editor.serviceNamePlaceholder"))}" />
					</label>
					<label class="settings-panel__field">
						<span>${escapeHtml(this.t("settings.editor.providerType"))}</span>
						<select class="b3-select" data-field="providerType" data-is-new="${service ? "false" : "true"}">
							<option value="openai-compatible"${providerType !== "deepseek" ? " selected" : ""}>OpenAI Compatible</option>
							<option value="deepseek"${providerType === "deepseek" ? " selected" : ""}>DeepSeek</option>
						</select>
					</label>
					<label class="settings-panel__field">
						<span>API Base URL</span>
						<input class="b3-text-field" data-field="apiBaseURL" value="${escapeHtml(service?.apiBaseURL || DEFAULT_CONFIG.apiBaseURL)}" placeholder="https://api.openai.com/v1" />
					</label>
					<label class="settings-panel__field">
						<span>API Key</span>
						<input class="b3-text-field" type="password" data-field="apiKey" value="${escapeHtml(service?.apiKey || "")}" placeholder="sk-..." />
					</label>
				</div>
				<div class="agent-model-inline-form__actions">
					<button class="b3-button b3-button--text" type="button" data-action="cancel-inline-service">${escapeHtml(this.t("settings.modelServices.cancelEdit"))}</button>
					<button class="b3-button b3-button--outline" type="button" data-action="save-inline-service">${escapeHtml(this.t("settings.modelServices.saveService"))}</button>
				</div>
			</div>`;
	}

	private renderModelInlineForm(service: ModelServiceConfig, model?: ModelServiceModelConfig): string {
		const title = model ? this.t("settings.editor.editModel") : this.t("settings.editor.addModel");
		return `
			<div class="agent-model-inline-form agent-model-inline-form--model" data-inline-form="model" data-service-id="${escapeHtml(service.id)}" data-model-id="${escapeHtml(model?.id || "")}">
				<div class="agent-model-inline-form__title">${escapeHtml(title)}</div>
				<div class="agent-model-inline-form__grid agent-model-inline-form__grid--model">
					<label class="settings-panel__field">
						<span>${escapeHtml(this.t("settings.editor.displayName"))}</span>
						<input class="b3-text-field" data-field="name" value="${escapeHtml(model?.name || "")}" placeholder="GPT-4o / Claude Sonnet" />
					</label>
					<label class="settings-panel__field">
						<span>${escapeHtml(this.t("settings.editor.modelId"))}</span>
						<input class="b3-text-field" data-field="model" value="${escapeHtml(model?.model || "")}" placeholder="gpt-4o" />
					</label>
					<label class="settings-panel__field">
						<span>${escapeHtml(this.t("settings.editor.temperatureOptional"))}</span>
						<input class="b3-text-field" type="number" step="0.1" min="0" max="2" data-field="temperature" value="${model?.temperature ?? ""}" placeholder="0" />
					</label>
				</div>
				<div class="agent-model-inline-form__actions">
					<button class="b3-button b3-button--text" type="button" data-action="cancel-inline-model">${escapeHtml(this.t("settings.modelServices.cancelEdit"))}</button>
					<button class="b3-button b3-button--outline" type="button" data-action="save-inline-model">${escapeHtml(this.t("settings.modelServices.saveModel"))}</button>
				</div>
			</div>`;
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
			this.editingModelServiceId = "__new__";
			this.editingServiceModelTarget = null;
			void this.render();
		});
		this.ctx.settingsViewEl.querySelectorAll<HTMLElement>("[data-action='edit-model-service']").forEach((button) => {
			button.addEventListener("click", () => {
				this.syncDraftFromForm();
				this.editingModelServiceId = button.dataset.serviceId || null;
				this.editingServiceModelTarget = null;
				void this.render();
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
				if (this.editingModelServiceId === serviceId) this.editingModelServiceId = null;
				if (this.editingServiceModelTarget?.serviceId === serviceId) this.editingServiceModelTarget = null;
				this.saveCurrentForm();
			});
		});
		this.ctx.settingsViewEl.querySelectorAll<HTMLElement>("[data-action='add-service-model']").forEach((button) => {
			button.addEventListener("click", () => {
				this.syncDraftFromForm();
				this.editingServiceModelTarget = { serviceId: button.dataset.serviceId || "" };
				this.editingModelServiceId = null;
				void this.render();
			});
		});
		this.ctx.settingsViewEl.querySelectorAll<HTMLElement>("[data-action='edit-model']").forEach((button) => {
			button.addEventListener("click", () => {
				this.syncDraftFromForm();
				this.editingServiceModelTarget = {
					serviceId: button.dataset.serviceId || "",
					modelId: button.dataset.modelId,
				};
				this.editingModelServiceId = null;
				void this.render();
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
				if (this.editingServiceModelTarget?.modelId === modelId) this.editingServiceModelTarget = null;
				this.saveCurrentForm();
			});
		});
		this.ctx.settingsViewEl.querySelectorAll<HTMLSelectElement>(".agent-model-inline-form [data-field='providerType']").forEach((select) => {
			select.addEventListener("change", () => {
				const form = select.closest<HTMLElement>(".agent-model-inline-form");
				if (!form || select.dataset.isNew !== "true" || select.value !== "deepseek") return;
				const nameField = form.querySelector<HTMLInputElement>("[data-field='name']");
				const baseUrlField = form.querySelector<HTMLInputElement>("[data-field='apiBaseURL']");
				if (nameField && !nameField.value.trim()) nameField.value = "DeepSeek";
				if (baseUrlField && (!baseUrlField.value.trim() || baseUrlField.value.trim() === DEFAULT_CONFIG.apiBaseURL)) {
					baseUrlField.value = DEEPSEEK_API_BASE_URL;
				}
			});
		});
		this.ctx.settingsViewEl.querySelectorAll<HTMLElement>("[data-action='cancel-inline-service']").forEach((button) => {
			button.addEventListener("click", () => {
				this.editingModelServiceId = null;
				void this.render();
			});
		});
		this.ctx.settingsViewEl.querySelectorAll<HTMLElement>("[data-action='save-inline-service']").forEach((button) => {
			button.addEventListener("click", () => {
				this.saveInlineService(button.closest<HTMLElement>(".agent-model-inline-form"));
			});
		});
		this.ctx.settingsViewEl.querySelectorAll<HTMLElement>("[data-action='cancel-inline-model']").forEach((button) => {
			button.addEventListener("click", () => {
				this.editingServiceModelTarget = null;
				void this.render();
			});
		});
		this.ctx.settingsViewEl.querySelectorAll<HTMLElement>("[data-action='save-inline-model']").forEach((button) => {
			button.addEventListener("click", () => {
				this.saveInlineModel(button.closest<HTMLElement>(".agent-model-inline-form"));
			});
		});
	}

	private saveInlineService(form: HTMLElement | null): void {
		if (!this.draft || !form) return;
		this.syncDraftFromForm();
		const serviceId = form.dataset.serviceId || "";
		const existing = this.draft.modelServices.find((item) => item.id === serviceId) || null;
		const providerType = form.querySelector<HTMLSelectElement>("[data-field='providerType']")?.value === "deepseek"
			? "deepseek"
			: "openai-compatible";
		const nextService: ModelServiceConfig = {
			id: existing?.id || genModelServiceId(),
			name: form.querySelector<HTMLInputElement>("[data-field='name']")?.value.trim() || (providerType === "deepseek" ? "DeepSeek" : "Unnamed Service"),
			providerType: providerType as ModelProviderType,
			apiBaseURL: form.querySelector<HTMLInputElement>("[data-field='apiBaseURL']")?.value.trim() || (providerType === "deepseek" ? DEEPSEEK_API_BASE_URL : DEFAULT_CONFIG.apiBaseURL),
			apiKey: form.querySelector<HTMLInputElement>("[data-field='apiKey']")?.value.trim() || "",
			models: existing?.models.map((item) => ({ ...item })) || [],
		};
		if (!nextService.name.trim()) {
			showMessage(this.t("settings.editor.serviceNameRequired"));
			return;
		}
		if (!nextService.apiBaseURL.trim()) {
			showMessage(this.t("settings.editor.apiBaseRequired"));
			return;
		}
		if (!existing && nextService.providerType === "deepseek" && nextService.models.length === 0) {
			nextService.models = [
				{ id: genModelId(), name: "DeepSeek V4 Pro", model: "deepseek-v4-pro" },
				{ id: genModelId(), name: "DeepSeek V4 Flash", model: "deepseek-v4-flash" },
			];
		}
		const existingIndex = this.draft.modelServices.findIndex((item) => item.id === nextService.id);
		if (existingIndex >= 0) {
			this.draft.modelServices[existingIndex] = nextService;
		} else {
			this.draft.modelServices.push(nextService);
		}
		this.editingModelServiceId = null;
		this.saveCurrentForm();
	}

	private saveInlineModel(form: HTMLElement | null): void {
		if (!this.draft || !form) return;
		this.syncDraftFromForm();
		const serviceId = form.dataset.serviceId || "";
		const modelId = form.dataset.modelId || "";
		const service = this.draft.modelServices.find((item) => item.id === serviceId);
		if (!service) {
			showMessage(this.t("settings.editor.serviceNotFound"));
			return;
		}
		const existing = service.models.find((item) => item.id === modelId) || null;
		const modelValue = form.querySelector<HTMLInputElement>("[data-field='model']")?.value.trim() || "";
		const nextModel: ModelServiceModelConfig = {
			id: existing?.id || genModelId(),
			name: form.querySelector<HTMLInputElement>("[data-field='name']")?.value.trim() || modelValue || "Unnamed Model",
			model: modelValue,
		};
		const temperature = form.querySelector<HTMLInputElement>("[data-field='temperature']")?.value.trim() || "";
		nextModel.temperature = temperature ? Number(temperature) : undefined;
		if (!nextModel.model) {
			showMessage(this.t("settings.editor.modelIdRequired"));
			return;
		}
		const existingIndex = service.models.findIndex((item) => item.id === nextModel.id);
		if (existingIndex >= 0) {
			service.models[existingIndex] = nextModel;
		} else {
			service.models.push(nextModel);
			if (!this.draft.defaultModelId) {
				this.draft.defaultModelId = nextModel.id;
			}
		}
		this.editingServiceModelTarget = null;
		this.saveCurrentForm();
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
				<h4 class="agent-model-editor__title">${escapeHtml(existing ? this.t("settings.editor.editMcp") : this.t("settings.editor.addMcp"))}</h4>
				<label class="agent-model-editor__label">${escapeHtml(this.t("settings.editor.name"))}
					<input class="b3-text-field fn__block" data-field="name" value="${escapeHtml(existing?.name || "")}" placeholder="My MCP Server" />
				</label>
				<label class="agent-model-editor__label">URL (SSE / Streamable HTTP)
					<input class="b3-text-field fn__block" data-field="url" value="${escapeHtml(existing?.url || "")}" placeholder="http://localhost:3000/sse" />
				</label>
				<label class="agent-model-editor__label">${escapeHtml(this.t("settings.editor.apiKeyOptional"))}
					<input class="b3-text-field fn__block" data-field="apiKey" type="password" value="${escapeHtml(existing?.apiKey || "")}" placeholder="${escapeHtml(this.t("settings.editor.mcpApiKeyPlaceholder"))}" />
				</label>
				<label class="agent-model-editor__label">${escapeHtml(this.t("settings.editor.descriptionOptional"))}
					<input class="b3-text-field fn__block" data-field="description" value="${escapeHtml(existing?.description || "")}" placeholder="${escapeHtml(this.t("settings.editor.mcpDescriptionPlaceholder"))}" />
				</label>
				<div class="agent-model-editor__buttons">
					<button class="b3-button b3-button--outline" type="button" data-action="cancel">${escapeHtml(this.t("common.cancel"))}</button>
					<button class="b3-button b3-button--text" type="button" data-action="save">${escapeHtml(this.t("common.save"))}</button>
				</div>
			</div>`;
		overlay.querySelector<HTMLElement>("[data-action='cancel']")?.addEventListener("click", () => overlay.remove());
		overlay.querySelector<HTMLElement>("[data-action='save']")?.addEventListener("click", () => {
			if (!this.draft) return;
			const name = overlay.querySelector<HTMLInputElement>("[data-field='name']")?.value.trim() || "";
			const url = overlay.querySelector<HTMLInputElement>("[data-field='url']")?.value.trim() || "";
			if (!name || !url) {
				showMessage(this.t("settings.editor.nameUrlRequired"));
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
