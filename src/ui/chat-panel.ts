import { Plugin, showMessage, openTab } from "siyuan";
import { ChatOpenAI } from "@langchain/openai";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
	AgentConfig,
	AgentState,
	ScheduledTaskMeta,
	SessionData,
	SessionIndexEntry,
	TodoList,
	ToolUIEvent,
	ToolMessageUi,
	UiMessage,
	DEFAULT_CONFIG,
	buildInitPrompt,
	cloneModelServices,
	genModelServiceId,
	genModelId,
	isToolMessageUi,
	normalizeAgentConfig,
	resolveModelConfig,
	type ModelConfig,
	type ModelServiceConfig,
	type ModelServiceModelConfig,
	type McpServerConfig,
} from "../types";
import { defaultTranslator, localizeErrorMessage, type Translator } from "../i18n";
import { makeAgent, makeTracer } from "../core/agent";
import { mergeState, runAgentStream } from "../core/stream-runtime";
import { renderMarkdown } from "./markdown";
import { SessionStore } from "../core/session-store";
import { ScheduledTaskManager } from "../core/scheduled-task-manager";
import { UiMessageBuilder, ensureMessagesUi } from "../core/ui-message-builder";
import { compactMessages, shouldCompact } from "../core/compaction";
import { getDefaultTools } from "../core/tools";
import { SettingsView, type SettingsViewContext } from "./settings-view";
import { TasksView, type TasksViewContext } from "./tasks-view";
import { Autocomplete } from "./autocomplete";
import {
	msgType, sessionTitle, cloneMessage, getMessageContent, getMessageToolCalls,
	getMessageToolCallId, getToolCallId, setMessageContent, setMessageToolCalls,
	normalizeMessagesForDisplay, escapeHtml, getToolCategory, getToolAction,
	getToolDisplayTitle, getActionLabel,
	type AssistantMessageShell, type ActivityBlockRefs,
} from "./chat-helpers";
const CONFIG_STORAGE = "agent-config";

export class ChatPanel {
	private container: HTMLElement;
	private plugin: Plugin;
	private tools: StructuredToolInterface[];
	private store: SessionStore;
	private taskManager: ScheduledTaskManager;
	private panelEl: HTMLElement;
	private chatViewEl: HTMLElement;
	private tasksViewEl: HTMLElement;
	private settingsViewEl: HTMLElement;
	private bottomBarEl: HTMLElement;
	private composerBodyEl: HTMLElement;

	private sessionToggleEl: HTMLButtonElement;
	private sessionListEl: HTMLElement;
	private messagesEl: HTMLElement;
	private textareaEl: HTMLTextAreaElement;
	private sendBtn: HTMLButtonElement;
	private contextBar: HTMLElement;

	private activeSession: SessionData;
	private currentView: "chat" | "tasks" | "settings" = "chat";
	private pendingContext: string | null = null;
	private abortCtrl: AbortController | null = null;
	private pendingEl: HTMLElement | null = null;
	private autoScroll = true;
	private sessionListExpanded = false;
	private unsubs: Array<() => void> = [];

	private settingsView: SettingsView;
	private tasksView: TasksView;
	private autocomplete: Autocomplete;
	private i18n: Translator;

	constructor(
		element: HTMLElement,
		plugin: Plugin,
		tools: StructuredToolInterface[],
		store: SessionStore,
		taskManager: ScheduledTaskManager,
		i18n: Translator = defaultTranslator,
	) {
		this.container = element;
		this.plugin = plugin;
		this.tools = tools;
		this.store = store;
		this.taskManager = taskManager;
		this.i18n = i18n;
		this.render();
		this.unsubs.push(this.store.subscribe(() => {
			void this.handleStoreChanged();
		}));
		void this.loadStore();
	}

	public openSettingsView(): void {
		this.setCurrentView("settings");
	}

	private t(key: string, params?: Record<string, string | number | boolean | null | undefined>, fallback?: string): string {
		return this.i18n.t(key, params, fallback);
	}

	private localizeToolResult(result: string): string {
		const trimmed = result?.trim?.() || "";
		if (!trimmed) return trimmed;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
				return JSON.stringify({
					...parsed,
					error: localizeErrorMessage(parsed.error, this.i18n),
				}, null, 2);
			}
		} catch {
			/* Plain text tool result. */
		}
		if (/^(Error|ToolError):/i.test(trimmed) || /^\[(MCP Error|MCP tool error:)/i.test(trimmed)) {
			return this.t("chat.error.prefix", { message: localizeErrorMessage(trimmed, this.i18n) });
		}
		return trimmed;
	}

	private render(): void {
		this.container.innerHTML = `
<div class="chat-panel fn__flex-column" style="height:100%">
	<div class="chat-panel__chat-view">
		<div class="chat-panel__session-bar">
			<button class="chat-panel__session-toggle b3-button b3-button--text" type="button" aria-expanded="false">
				<span class="chat-panel__session-toggle-main">
					<span class="chat-panel__session-name">${escapeHtml(this.t("chat.newChat"))}</span>
				</span>
				<span class="chat-panel__session-toggle-side">
					<svg class="chat-panel__session-toggle-chevron" aria-hidden="true"><use xlink:href="#iconDown"></use></svg>
				</span>
			</button>
			<span class="fn__flex-1"></span>
			<span class="chat-panel__session-action chat-panel__new-session block__icon block__icon--show b3-tooltips b3-tooltips__sw" aria-label="${escapeHtml(this.t("chat.newChat"))}">
				<svg style="width:16px;height:16px"><use xlink:href="#iconAdd"></use></svg>
			</span>
			<span class="chat-panel__session-action chat-panel__clear block__icon block__icon--show b3-tooltips b3-tooltips__sw" aria-label="${escapeHtml(this.t("chat.clear"))}">
				<svg style="width:16px;height:16px"><use xlink:href="#iconTrashcan"></use></svg>
			</span>
		</div>
		<div class="chat-panel__session-list fn__none"></div>
		<div class="chat-panel__context-bar fn__none"></div>
		<div class="chat-panel__messages fn__flex-1"></div>
	</div>
	<div class="chat-panel__tasks-view fn__none">
		<div class="chat-panel__tasks-header"></div>
		<div class="chat-panel__tasks-board">
			<div class="chat-panel__tasks-list"></div>
			<div class="chat-panel__tasks-detail"></div>
		</div>
	</div>
	<div class="chat-panel__settings-view fn__none"></div>
	<div class="chat-panel__bottom-bar">
		<div class="chat-panel__composer-body">
			<div class="chat-panel__input">
				<textarea class="chat-panel__textarea b3-text-field" rows="2" placeholder="${escapeHtml(this.t("chat.placeholder"))}"></textarea>
			</div>
		</div>
		<div class="chat-panel__bottom-footer">
			<div class="chat-panel__view-switcher" role="tablist" aria-label="${escapeHtml(this.t("chat.viewSwitcher"))}">
				<button class="chat-panel__switch-btn chat-panel__switch-btn--active" type="button" data-view="chat">${escapeHtml(this.t("chat.view.chat"))}</button>
				<button class="chat-panel__switch-btn" type="button" data-view="tasks">${escapeHtml(this.t("chat.view.tasks"))}</button>
				<button class="chat-panel__switch-btn" type="button" data-view="settings">${escapeHtml(this.t("chat.view.settings"))}</button>
			</div>
			<div class="chat-panel__actions">
				<button class="chat-panel__send" type="button" title="${escapeHtml(this.t("chat.sendTitle"))}" aria-label="${escapeHtml(this.t("chat.send"))}">
					${this.getSendIconMarkup()}
				</button>
			</div>
		</div>
	</div>
</div>`;

		this.panelEl = this.container.querySelector(".chat-panel");
		this.chatViewEl = this.container.querySelector(".chat-panel__chat-view");
		this.tasksViewEl = this.container.querySelector(".chat-panel__tasks-view");
		this.settingsViewEl = this.container.querySelector(".chat-panel__settings-view");
		this.bottomBarEl = this.container.querySelector(".chat-panel__bottom-bar");
		this.composerBodyEl = this.container.querySelector(".chat-panel__composer-body");
		this.sessionToggleEl = this.container.querySelector(".chat-panel__session-toggle");
		this.sessionListEl = this.container.querySelector(".chat-panel__session-list");
		this.messagesEl = this.container.querySelector(".chat-panel__messages");
		this.textareaEl = this.container.querySelector(".chat-panel__textarea");
		this.sendBtn = this.container.querySelector(".chat-panel__send");
		this.contextBar = this.container.querySelector(".chat-panel__context-bar");
		this.applyEditorFontFamily();

		// Create delegates
		this.autocomplete = new Autocomplete(this.textareaEl);

		this.tasksView = new TasksView({
			tasksSummaryEl: this.container.querySelector(".chat-panel__tasks-header"),
			taskListEl: this.container.querySelector(".chat-panel__tasks-list"),
			taskDetailEl: this.container.querySelector(".chat-panel__tasks-detail"),
			taskManager: this.taskManager,
			i18n: this.i18n,
			renderConversationMessages: (messages, toolUIEvents, targetEl) =>
				this.renderConversationMessages(messages, toolUIEvents, targetEl),
			renderConversationMessagesUi: (messagesUi, targetEl) =>
				this.renderConversationMessagesUi(messagesUi, targetEl),
		});

		this.settingsView = new SettingsView({
			settingsViewEl: this.settingsViewEl,
			plugin: this.plugin,
			i18n: this.i18n,
			getConfig: () => this.getConfig(),
			refreshModelSelector: () => this.refreshModelSelector(),
			openTaskEditor: (task?) => this.tasksView.openTaskEditor(task),
			queryDocs: (keyword) => this.queryDocs(keyword),
			onConfigSaved: async (nextConfig) => {
				await this.handleConfigSaved(nextConfig);
			},
		});

		/* Bottom view switching */
		this.bottomBarEl.querySelectorAll<HTMLElement>("[data-view]").forEach((button) => {
			button.addEventListener("click", () => {
				const view = button.dataset.view;
				this.setCurrentView(view === "tasks" || view === "settings" ? view : "chat");
			});
		});

		/* Auto-scroll detection */
		this.messagesEl.addEventListener("scroll", () => {
			const el = this.messagesEl;
			this.autoScroll = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
		});

		/* Send on click */
		this.sendBtn.onclick = () => this.send();

		this.refreshModelSelector();

		/* Send on Enter (Shift+Enter for new line) */
		this.textareaEl.addEventListener("keydown", (e) => {
			if (this.autocomplete.isActive) {
				this.autocomplete.handleKey(e);
				return;
			}
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.send();
			}
			/* Escape to stop generation */
			if (e.key === "Escape" && this.abortCtrl) {
				e.preventDefault();
				this.stop();
			}
		});

		/* Auto-resize textarea */
		const autoResize = () => {
			this.textareaEl.style.height = "auto";
			const maxH = 200;
			this.textareaEl.style.height = Math.min(this.textareaEl.scrollHeight, maxH) + "px";
			this.textareaEl.style.overflowY = this.textareaEl.scrollHeight > maxH ? "auto" : "hidden";
		};
		this.textareaEl.addEventListener("input", autoResize);
		this.textareaEl.style.overflowY = "hidden";

		/* Autocomplete trigger */
		this.textareaEl.addEventListener("input", (e) => {
			void this.autocomplete.handleInput(e);
		});
		this.textareaEl.addEventListener("click", () => {
			this.autocomplete.hide();
		});
		this.textareaEl.addEventListener("blur", () => {
			setTimeout(() => this.autocomplete.hide(), 200);
		});

		/* Toggle session list */
		this.sessionToggleEl.addEventListener("click", () => {
			this.toggleSessionList();
		});

		/* New session */
		this.container.querySelector(".chat-panel__new-session").addEventListener("click", () => {
			void this.newSession();
		});

		/* Delete current session */
		this.container.querySelector(".chat-panel__clear").addEventListener("click", () => {
			void this.deleteSession(this.activeSession.id);
		});
	}

	private applyEditorFontFamily(): void {
		const editorFont = (window as any).siyuan?.config?.editor?.fontFamily?.trim?.() || "";
		if (!editorFont) {
			this.panelEl.style.removeProperty("--agent-editor-font-family");
			return;
		}
		const escapedFont = editorFont.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		this.panelEl.style.setProperty(
			"--agent-editor-font-family",
			`"Emojis Additional", "Emojis Reset", "${escapedFont}", var(--b3-font-family)`
		);
	}

	/* --- Session management --- */

	private toggleSessionList(): void {
		if (this.isSessionListOpen()) {
			this.sessionListExpanded = false;
			this.sessionListEl.classList.add("fn__none");
			this.updateSessionToggleState();
			return;
		}
		this.renderSessionList();
		this.sessionListEl.classList.remove("fn__none");
		this.updateSessionToggleState();
	}

	private isSessionListOpen(): boolean {
		return !this.sessionListEl.classList.contains("fn__none");
	}

	private updateSessionToggleState(): void {
		const open = this.isSessionListOpen();
		this.sessionToggleEl.classList.toggle("chat-panel__session-toggle--open", open);
		this.sessionToggleEl.setAttribute("aria-expanded", String(open));
	}

	private toggleSessionListExpanded(): void {
		this.sessionListExpanded = !this.sessionListExpanded;
		this.renderSessionList();
	}

	private refreshSessionListUi(): void {
		this.updateSessionToggleState();
		if (this.isSessionListOpen())
			this.renderSessionList();
	}

	private formatSessionDate(timestamp: number): string {
		const date = new Date(timestamp);
		const now = new Date();
		if (date.getFullYear() === now.getFullYear()) {
			return date.toLocaleDateString(undefined, {
				month: "numeric",
				day: "numeric",
			});
		}
		return date.toLocaleDateString();
	}

	private getChatSessions(): SessionIndexEntry[] {
		return this.store.listSessions("chat");
	}

	private renderSessionList(): void {
		const sessions = this.getChatSessions();
		if (!sessions.length) {
			this.sessionListEl.innerHTML = `<div class="chat-session-list__empty">${escapeHtml(this.t("chat.noSessions"))}</div>`;
			this.sessionListEl.classList.remove("chat-panel__session-list--expanded");
			return;
		}

		const previewCount = 3;
		const sorted = [...sessions].sort((a, b) => b.updated - a.updated);
		const activeChatId = this.store.getIndex().activeId;
		const canExpand = sorted.length > previewCount;
		if (!canExpand)
			this.sessionListExpanded = false;
		const visible = this.sessionListExpanded ? sorted : sorted.slice(0, previewCount);
		const hiddenCount = Math.max(0, sorted.length - previewCount);
		this.sessionListEl.classList.toggle("chat-panel__session-list--expanded", this.sessionListExpanded);
		this.sessionListEl.innerHTML = `
			<div class="chat-session-list__items">${visible.map(s => {
			const active = s.id === activeChatId ? " chat-session-item--active" : "";
			const title = escapeHtml(s.title || this.t("chat.newChat"));
			const date = escapeHtml(this.formatSessionDate(s.updated));
			return `<div class="chat-session-item${active}" data-id="${s.id}">
				<div class="chat-session-item__info">
					<div class="chat-session-item__line">
						<span class="chat-session-item__title">${title}</span>
						<span class="chat-session-item__meta">${date}</span>
					</div>
				</div>
				<span class="chat-session-item__delete block__icon b3-tooltips b3-tooltips__sw" aria-label="${escapeHtml(this.t("chat.delete"))}" data-delete="${s.id}">
					<svg><use xlink:href="#iconTrashcan"></use></svg>
				</span>
			</div>`;
		}).join("")}</div>
			${canExpand ? `
				<button class="chat-session-list__more b3-button b3-button--text" type="button" data-action="toggle-expand">
					<span>${escapeHtml(this.sessionListExpanded ? this.t("chat.collapse") : this.t("chat.expandMore", { count: hiddenCount }))}</span>
					<svg class="chat-session-list__more-icon" aria-hidden="true"><use xlink:href="#iconDown"></use></svg>
				</button>
			` : ""}
		`;

		/* Click to switch */
		this.sessionListEl.querySelectorAll(".chat-session-item").forEach(el => {
			el.addEventListener("click", (e) => {
				const target = e.target as HTMLElement;
				if (target.closest("[data-delete]"))
					return;
				const id = (el as HTMLElement).dataset.id;
				if (id && id !== activeChatId)
					void this.switchSession(id);
			});
		});

		/* Click to delete */
		this.sessionListEl.querySelectorAll("[data-delete]").forEach(el => {
			el.addEventListener("click", (e) => {
				e.stopPropagation();
				const id = (el as HTMLElement).dataset.delete;
				if (id)
					void this.deleteSession(id);
			});
		});

		const moreBtn = this.sessionListEl.querySelector<HTMLElement>("[data-action='toggle-expand']");
		if (moreBtn) {
			moreBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.toggleSessionListExpanded();
			});
		}
	}

	private async newSession(): Promise<void> {
		const msgs = this.activeSession.state?.messages;
		if (!msgs || msgs.length === 0) {
			this.textareaEl.focus();
			return;
		}
		const s = await this.store.createChatSession();
		this.activeSession = s;
		this.renderCurrentSession();
		this.refreshSessionListUi();
		this.textareaEl.focus();
	}

	private async switchSession(id: string): Promise<void> {
		await this.store.saveSession(this.activeSession);
		await this.store.setActiveChatSession(id);
		this.activeSession = await this.store.loadSession(id);
		this.renderCurrentSession();
		this.sessionListExpanded = false;
		this.sessionListEl.classList.add("fn__none");
		this.updateSessionToggleState();
	}

	private async deleteSession(id: string): Promise<void> {
		await this.store.deleteSession(id);
		const activeId = this.store.getIndex().activeId;
		this.activeSession = await this.store.loadSession(activeId);
		this.renderCurrentSession();
		this.refreshSessionListUi();
	}

	private renderCurrentSession(): void {
		const s = this.activeSession;
		const entry = this.store.getSessionSummary(s.id);
		const nameEl = this.container.querySelector(".chat-panel__session-name");
		if (nameEl)
			nameEl.textContent = entry?.title || this.t("chat.newChat");
		this.updateSessionToggleState();
		void this.refreshModelSelector();

	/* Lazy-migrate old sessions that lack messagesUi */
		if (!s.state) s.state = {};
		ensureMessagesUi(s.state);

	/* Re-render messages from messagesUi */
		this.messagesEl.innerHTML = "";
		const messagesUi: UiMessage[] = Array.isArray(s.state?.messagesUi) ? s.state.messagesUi : [];
		if (messagesUi.length === 0) {
			this.renderWelcomeScreen();
		} else {
			this.renderConversationMessagesUi(messagesUi);
			/* Render persisted todos bar at the end if present */
			if (s.state?.todos && s.state.todos.items.length > 0) {
				this.renderPersistedTodosBar(s.state.todos);
			}
		}
	}

	private renderWelcomeScreen(): void {
		const el = document.createElement("div");
		el.className = "chat-panel__welcome";
		el.innerHTML = `
			<div class="chat-panel__welcome-icon">📚</div>
			<h3 class="chat-panel__welcome-title">${escapeHtml(this.t("chat.welcome.title"))}</h3>
			<p class="chat-panel__welcome-desc">${escapeHtml(this.t("chat.welcome.desc"))}</p>
			<div class="chat-panel__welcome-actions">
				<button class="chat-panel__welcome-btn" data-prompt="${escapeHtml(this.t("chat.welcome.recentPrompt"))}">📋 ${escapeHtml(this.t("chat.welcome.recentLabel"))}</button>
				<button class="chat-panel__welcome-btn" data-prompt="${escapeHtml(this.t("chat.welcome.structurePrompt"))}">🗂️ ${escapeHtml(this.t("chat.welcome.structureLabel"))}</button>
				<button class="chat-panel__welcome-btn" data-prompt="${escapeHtml(this.t("chat.welcome.searchPrompt"))}">🔍 ${escapeHtml(this.t("chat.welcome.searchLabel"))}</button>
				<button class="chat-panel__welcome-btn" data-prompt="${escapeHtml(this.t("chat.welcome.todoPrompt"))}">✅ ${escapeHtml(this.t("chat.welcome.todoLabel"))}</button>
			</div>`;
		el.querySelectorAll(".chat-panel__welcome-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				const prompt = (btn as HTMLElement).dataset.prompt || "";
				this.textareaEl.value = prompt;
				this.textareaEl.focus();
				// For search prompt, position cursor between quotes
				if (prompt.includes("「」") || prompt.includes("\"\"")) {
					const idx = prompt.includes("「」") ? prompt.indexOf("「") + 1 : prompt.indexOf("\"\"") + 1;
					this.textareaEl.setSelectionRange(idx, idx);
				}
			});
		});
		this.messagesEl.appendChild(el);
	}

	/* --- Send --- */

	private async send(): Promise<void> {
		if (this.currentView !== "chat") {
			this.setCurrentView("chat");
			this.textareaEl.focus();
			return;
		}

		const text = this.textareaEl.value.trim();
		if (!text && !this.pendingContext)
			return;

		const config = await this.getConfig();
		const sessionModelId = this.activeSession?.modelId;
		const activeModel = resolveModelConfig(config, sessionModelId);
		if (!activeModel.apiKey) {
			showMessage(this.t("chat.error.apiKeyMissing"));
			return;
		}

		/* Handle /compact command */
		const compactMatch = text.match(/^\/compac?t(?:\s+([\s\S]*))?$/i);
		if (compactMatch) {
			this.textareaEl.value = "";
			await this.handleCompact(activeModel, (compactMatch[1] || "").trim());
			return;
		}

		/* Handle /help command */
		if (/^\/help$/i.test(text)) {
			this.textareaEl.value = "";
			this.showHelpMessage();
			return;
		}

		/* Handle /clear command */
		if (/^\/clear$/i.test(text)) {
			this.textareaEl.value = "";
			this.newSession();
			return;
		}

		/* Handle slash commands */
		let extraSystemPrompt: string | null = null;
		const initMatch = text.match(/^\/init(?:\s+([\s\S]*))?$/i);
		if (initMatch) {
			const guideDocId = config.guideDoc?.id;
				if (!guideDocId) {
					showMessage(this.t("chat.init.missingGuideDoc"));
					return;
				}
			const extra = (initMatch[1] || "").trim();
			extraSystemPrompt = [
				buildInitPrompt(this.i18n),
				this.t("chat.init.targetDoc", { id: guideDocId }),
				extra ? this.t("chat.init.extra", { extra }) : "",
				this.t("chat.init.start"),
			].filter(Boolean).join("\n\n");
		}

		/* Build user message content with optional context */
		let content = "";
		if (this.pendingContext) {
			content = `> ${this.pendingContext.replace(/\n/g, "\n> ")}\n\n${text}`;
			this.clearContext();
		} else {
			content = text;
		}

		/* Remove welcome screen if present */
		this.messagesEl.querySelector(".chat-panel__welcome")?.remove();

		/* Show user message in UI */
		const { listEl } = this.createConversationTurn(content);

		this.textareaEl.value = "";
		const s = this.activeSession;
		this.setLoading(true);

		/* Create assistant message container for streaming */
		const assistantShell = this.createAssistantMessageShell();
		listEl.appendChild(assistantShell.el);

		/* Insert pending placeholder (waiting state) */
		this.pendingEl = document.createElement("div");
		this.pendingEl.className = "chat-msg__pending";
		this.pendingEl.innerHTML = `<span class="chat-msg__pending-spinner"></span><span class="chat-msg__pending-text">${escapeHtml(this.t("chat.pending"))}</span>`;
		assistantShell.stackEl.appendChild(this.pendingEl);
		this.scrollToBottom();

		this.abortCtrl = new AbortController();

		let curTextEl: HTMLElement | null = null;
		let curBuffer = "";
		let reasoningEl: HTMLElement | null = null;
		let reasoningBuffer = "";
		const pendingToolEls: HTMLElement[] = [];
		const existingToolUIEvents: ToolUIEvent[] = Array.isArray(s.state?.toolUIEvents) ? [...s.state.toolUIEvents] : [];

		/* Lazy-migrate old sessions before merging */
		if (!s.state) s.state = {};
		ensureMessagesUi(s.state);

		const input = mergeState(s.state ?? null, content) as any;

		/* Push the human message into the carried-over messagesUi */
		const humanMsgDict = {
			lc: 1,
			type: "constructor",
			id: ["langchain_core", "messages", "HumanMessage"],
			kwargs: { content },
		};
		if (!Array.isArray(input.messagesUi)) input.messagesUi = [];
		input.messagesUi.push(humanMsgDict);

		let latestState: AgentState = {
			...s.state,
			messages: input.messages,
			messagesUi: input.messagesUi,
			compaction: input.compaction,
			toolUIEvents: existingToolUIEvents,
		};

		const removePending = (): void => {
			if (this.pendingEl) {
				this.pendingEl.remove();
				this.pendingEl = null;
			}
		};

		const getTextEl = (): HTMLElement => {
			if (curTextEl) return curTextEl;
			removePending();
			curBuffer = "";
			this.compactCompletedActivityBlocks(assistantShell, "lookup");
			curTextEl = document.createElement("div");
			curTextEl.className = "chat-msg__text";
			assistantShell.stackEl.appendChild(curTextEl);
			return curTextEl;
		};

		const showStreamError = (error: unknown): void => {
			if (this.abortCtrl?.signal.aborted) return;
			removePending();
			const errorEl = document.createElement("p");
			errorEl.className = "chat-msg__error";

			const msg = localizeErrorMessage(error, this.i18n);
			errorEl.textContent = this.t("chat.error.prefix", { message: msg });
			// Add a retry button for recoverable errors
			const retryBtn = document.createElement("button");
			retryBtn.className = "chat-msg__retry-btn b3-button b3-button--outline";
			retryBtn.textContent = this.t("chat.retry");
			retryBtn.addEventListener("click", () => {
				errorEl.remove();
				// Re-send the last user message
				if (this.textareaEl && !this.textareaEl.value.trim()) {
					this.textareaEl.value = text;
				}
				this.send();
			});
			assistantShell.stackEl.appendChild(errorEl);
			assistantShell.stackEl.appendChild(retryBtn);
			this.scrollToBottom();
		};

		try {
			const modelOverride = sessionModelId ? activeModel : null;
			const agent = await makeAgent(config, this.tools, extraSystemPrompt, modelOverride, this.i18n);
			const tracer = makeTracer(config);
			const result = await runAgentStream({
				agent,
				input,
				callbacks: tracer ? [tracer] : undefined,
				signal: this.abortCtrl?.signal,
				existingToolUIEvents,
				onUiEvent: (event) => {
					if (event.type === "reasoning_delta") {
						if (!reasoningEl) {
							removePending();
							reasoningEl = document.createElement("details");
							reasoningEl.className = "chat-msg__reasoning";
							reasoningEl.open = true;
							reasoningEl.innerHTML = `<summary class="chat-msg__reasoning-summary">💭 ${escapeHtml(this.t("chat.reasoning.thinking"))}</summary><div class="chat-msg__reasoning-content"></div>`;
							assistantShell.stackEl.appendChild(reasoningEl);
						}
						reasoningBuffer += event.text;
						const contentEl = reasoningEl.querySelector(".chat-msg__reasoning-content")!;
						contentEl.innerHTML = renderMarkdown(reasoningBuffer);
						this.scrollToBottom();
						return;
					}

					if (event.type === "text_delta") {
						// When text starts, close the reasoning section
						if (reasoningEl) {
							reasoningEl.open = false;
							const summary = reasoningEl.querySelector(".chat-msg__reasoning-summary");
							if (summary) summary.textContent = `💭 ${this.t("chat.reasoning.process")}`;
							reasoningEl = null;
						}
						const el = getTextEl();
						curBuffer += event.text;
						el.innerHTML = renderMarkdown(curBuffer);
						this.scrollToBottom();
						return;
					}

					if (event.type === "tool_call_start") {
						removePending();
						curTextEl = null;
						const el = this.createToolCallElement(
							event.toolName,
							event.args,
							event.toolCallIndex,
							event.toolCallId,
						);
						this.attachToolElementToShell(assistantShell, el);
						pendingToolEls.push(el);
						this.scrollToBottom();
						return;
					}

					if (event.type === "tool_result") {
						const toolEl = this.findPendingToolElement(event.toolCallId || "", pendingToolEls);
						if (toolEl) {
							this.appendToolResultToElement(toolEl, event.result);
							this.finalizeToolElement(toolEl);
						}
						curTextEl = null;
						this.scrollToBottom();
						return;
					}

					if (event.type === "todos_update") {
						this.renderTodosBar(assistantShell, event.todos);
						this.scrollToBottom();
						return;
					}

					const toolEl = this.findToolElementForEvent(assistantShell, event.event, pendingToolEls);
					if (toolEl && event.event.toolCallIndex >= 0) {
						event.event.toolCallIndex = Number(toolEl.dataset.toolCallIndex || event.event.toolCallIndex);
						event.event.toolName = event.event.toolName || toolEl.dataset.toolName;
						this.applyToolUIEvent(toolEl, event.event);
					}
				},
			});

			latestState = result.lastState;
			if (result.error && !result.aborted) {
				showStreamError(result.error);
			}
		} catch (err) {
			showStreamError(err);
		} finally {
			removePending();
			/* If aborted and assistant shell is empty, remove it */
			if (this.abortCtrl?.signal.aborted && assistantShell.stackEl.children.length === 0) {
				assistantShell.el.remove();
			}
			this.compactCompletedActivityBlocks(assistantShell, "lookup");

			s.state = latestState;

			/* Auto-compact if context grew too large */
			if (!this.abortCtrl?.signal.aborted && shouldCompact(latestState)) {
				try {
					const compactModel = new ChatOpenAI({
						model: activeModel.model,
						temperature: 0,
						apiKey: activeModel.apiKey,
						configuration: { dangerouslyAllowBrowser: true, baseURL: activeModel.apiBaseURL },
					});
					await compactMessages(s.state, { model: compactModel, source: "auto" });
				} catch (_) { /* best-effort, don't block save */ }
			}

			s.updated = Date.now();
			s.title = sessionTitle(latestState);
			const indexEntry = this.store.getSessionSummary(s.id);
			if (indexEntry) {
				indexEntry.title = s.title;
			}
			const nameEl = this.container.querySelector(".chat-panel__session-name");
			if (nameEl) nameEl.textContent = s.title || this.t("chat.newChat");
			await this.store.saveSession(s);
			this.refreshSessionListUi();

			this.abortCtrl = null;
			this.setLoading(false);
		}
	}

	/* --- /compact --- */

	private async handleCompact(config: ModelConfig, requirement: string): Promise<void> {
		const s = this.activeSession;
		if (!s.state?.messages || s.state.messages.length === 0) {
			showMessage(this.t("chat.compact.noContext"));
			return;
		}

		this.setLoading(true);
		try {
			const model = new ChatOpenAI({
				model: config.model,
				temperature: 0,
				apiKey: config.apiKey,
				configuration: {
					dangerouslyAllowBrowser: true,
					baseURL: config.apiBaseURL,
				},
			});
			const summary = await compactMessages(s.state, {
				model,
				keepRecentTurns: 4,
				requirement: requirement || undefined,
				source: "manual",
			});
			if (!summary) {
				showMessage(this.t("chat.compact.tooFewTurns"));
				return;
			}

			/* Append a notice-style ToolMessageUi */
			if (!Array.isArray(s.state.messagesUi)) s.state.messagesUi = [];
			const notice: ToolMessageUi = {
				type: "tool_message_ui",
				toolCallId: `compact-${Date.now().toString(36)}`,
				toolName: "compact",
				status: "done",
				summary: this.t("chat.compact.summary", {
					requirement: requirement || this.t("chat.compact.defaultRequirement"),
				}),
				events: [],
				startedAt: Date.now(),
				finishedAt: Date.now(),
			};
			s.state.messagesUi.push(notice);

			s.updated = Date.now();
			await this.store.saveSession(s);
			showMessage(this.t("chat.compact.success"));
			this.renderCurrentSession();
		} catch (err) {
			showMessage(this.t("chat.compact.failed", { error: String(err) }));
		} finally {
			this.setLoading(false);
		}
	}

	/* --- /help --- */

	private showHelpMessage(): void {
		const helpHtml = `
<div class="chat-msg__help">
<h4>📖 ${escapeHtml(this.t("chat.help.commandsTitle"))}</h4>
<table>
<tr><td><code>/init</code></td><td>${escapeHtml(this.t("slash.init"))}</td></tr>
<tr><td><code>/compact</code></td><td>${escapeHtml(this.t("slash.compact"))}</td></tr>
<tr><td><code>/help</code></td><td>${escapeHtml(this.t("slash.help"))}</td></tr>
<tr><td><code>/clear</code></td><td>${escapeHtml(this.t("slash.clear"))}</td></tr>
</table>
<h4>🔧 ${escapeHtml(this.t("chat.help.toolsTitle", { count: this.tools.length }))}</h4>
<p>${escapeHtml(this.t("chat.help.toolsDesc"))}</p>
<details>
<summary>${escapeHtml(this.t("chat.help.allTools"))}</summary>
<ul>${this.tools.map(t => `<li><strong>${t.name}</strong>: ${t.description?.slice(0, 80) || ""}</li>`).join("")}</ul>
</details>
<h4>💡 ${escapeHtml(this.t("chat.help.tipsTitle"))}</h4>
<ul>
<li>${this.t("chat.help.tipSelection")}</li>
<li>${escapeHtml(this.t("chat.help.tipContextMenu"))}</li>
<li>${escapeHtml(this.t("chat.help.tipModel"))}</li>
</ul>
</div>`;
		const el = document.createElement("div");
		el.className = "chat-msg chat-msg--system";
		el.innerHTML = helpHtml;
		this.messagesEl.appendChild(el);
		this.scrollToBottom();
	}

	addContext(text: string): void {
		this.pendingContext = text;
		this.contextBar.classList.remove("fn__none");
		this.contextBar.innerHTML = `
<div class="chat-panel__context">
	<span class="chat-panel__context-label">📎 ${escapeHtml(this.t("chat.context.reference"))}</span>
	<span class="chat-panel__context-text">${escapeHtml(text.length > 100 ? text.slice(0, 100) + "..." : text)}</span>
	<span class="chat-panel__context-close block__icon b3-tooltips b3-tooltips__sw" aria-label="${escapeHtml(this.t("chat.context.remove"))}">
		<svg><use xlink:href="#iconClose"></use></svg>
	</span>
</div>`;
		this.contextBar.querySelector(".chat-panel__context-close").addEventListener("click", () => {
			this.clearContext();
		});
		this.textareaEl.focus();
	}

	private clearContext(): void {
		this.pendingContext = null;
		this.contextBar.classList.add("fn__none");
		this.contextBar.innerHTML = "";
	}

	stop(): void {
		this.abortCtrl?.abort();
	}

	destroy(): void {
		this.stop();
		this.unsubs.splice(0).forEach((unsubscribe) => unsubscribe());
	}

	private getSendIconMarkup(): string {
		return "<svg class=\"chat-panel__send-icon\" viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M12 22.2V2.2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.15\" stroke-linecap=\"round\"></path><polyline points=\"3.9 10.3 12 2.2 20.1 10.3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.15\" stroke-linecap=\"round\" stroke-linejoin=\"round\"></polyline></svg>";
	}

	private getStopIconMarkup(): string {
		return "<svg class=\"chat-panel__send-icon\" aria-hidden=\"true\"><use xlink:href=\"#iconClose\"></use></svg>";
	}

	/* --- DOM helpers --- */

	private createConversationTurn(userContent?: string, targetEl?: HTMLElement): { turnEl: HTMLElement; listEl: HTMLElement } {
		const turnEl = document.createElement("div");
		turnEl.className = "chat-turn";

		if (userContent) {
			turnEl.appendChild(this.createStaticMessageElement("user", userContent));
		}

		const listEl = document.createElement("div");
		listEl.className = "chat-turn__messages";
		turnEl.appendChild(listEl);
		(targetEl || this.messagesEl).appendChild(turnEl);
		this.scrollToBottom();
		return { turnEl, listEl };
	}

	private renderConversationMessages(messages: any[], toolUIEvents: ToolUIEvent[], targetEl?: HTMLElement): void {
		let toolCallIndex = -1;
		const pendingToolEls: HTMLElement[] = [];
		let currentListEl: HTMLElement | null = null;
		let currentAssistantShell: AssistantMessageShell | null = null;

		for (const msg of messages) {
			const type = msgType(msg);
			const content = msg.kwargs?.content ?? msg.content;
			const toolCalls = getMessageToolCalls(msg);
			const toolName = msg.kwargs?.name ?? msg.name;

			if (type === "human" || type === "user") {
				const { listEl } = this.createConversationTurn(
					typeof content === "string" ? content : JSON.stringify(content),
					targetEl,
				);
				currentListEl = listEl;
				currentAssistantShell = null;
				pendingToolEls.length = 0;
				continue;
			}

			if (type === "ai") {
				if (!currentListEl) {
					const turn = this.createConversationTurn(undefined, targetEl);
					currentListEl = turn.listEl;
				}
				if (!currentAssistantShell) {
					currentAssistantShell = this.createAssistantMessageShell();
					currentListEl.appendChild(currentAssistantShell.el);
				}
				const { toolCallIndex: nextToolCallIndex, toolEls } = this.appendAssistantSegment(
					currentAssistantShell,
					typeof content === "string" ? content : "",
					toolCalls,
					toolUIEvents,
					toolCallIndex,
				);
				toolCallIndex = nextToolCallIndex;
				pendingToolEls.push(...toolEls);
				this.scrollToBottom();
				continue;
			}

			if (type === "tool") {
				if (!currentListEl) {
					const turn = this.createConversationTurn(undefined, targetEl);
					currentListEl = turn.listEl;
				}
				const result = typeof content === "string" ? content : JSON.stringify(content);
				const toolEl = this.findPendingToolElement(getMessageToolCallId(msg), pendingToolEls);
				if (toolEl) {
					this.appendToolResultToElement(toolEl, result);
					this.finalizeToolElement(toolEl);
				} else {
					this.appendStaticMessage("tool", result, null, toolName, undefined, -1, currentListEl);
				}
			}
		}

		if (currentAssistantShell)
			this.compactCompletedActivityBlocks(currentAssistantShell, "lookup");
	}

	/**
	 * Render conversation from `messagesUi`.
	 *
	 * UiMessage[] contains:
	 *   - HumanMessage dicts  → conversation turn header
	 *   - AIMessage dicts     → assistant shell with content + tool_calls
	 *   - ToolMessageUi       → rendered via events, keyed by toolCallId
	 *
	 * AI messages and their following ToolMessageUi entries form one visual
	 * "assistant turn".
	 */
	private renderConversationMessagesUi(messagesUi: UiMessage[], targetEl?: HTMLElement): void {
		let currentListEl: HTMLElement | null = null;
		let currentAssistantShell: AssistantMessageShell | null = null;

		/* Build toolCallId → args map from AI messages */
		const toolCallArgsMap = new Map<string, unknown>();
		for (const m of messagesUi) {
			if (isToolMessageUi(m)) continue;
			const toolCalls = getMessageToolCalls(m);
			for (const tc of toolCalls) {
				const tcId = getToolCallId(tc);
				if (tcId && tc.args) toolCallArgsMap.set(tcId, tc.args);
			}
		}

		for (const m of messagesUi) {
			if (isToolMessageUi(m)) {
				/* ToolMessageUi: attach to current assistant shell */
				if (!currentListEl) {
					const turn = this.createConversationTurn(undefined, targetEl);
					currentListEl = turn.listEl;
				}
				if (!currentAssistantShell) {
					currentAssistantShell = this.createAssistantMessageShell();
					currentListEl.appendChild(currentAssistantShell.el);
				}
				const args = toolCallArgsMap.get(m.toolCallId);
				const toolEl = this.createToolCallElement(m.toolName, args, undefined, m.toolCallId);
				this.attachToolElementToShell(currentAssistantShell, toolEl);
				if (m.events.length > 0) {
					for (const event of m.events) {
						this.applyToolUIEvent(toolEl, event);
					}
				} else if (m.summary) {
					/* No events but has a summary (e.g. /compact notice) */
					const details = toolEl.querySelector("details");
					const summary = details?.querySelector("summary");
					if (summary) {
						summary.innerHTML = this.buildToolSummaryHtml(
							m.toolName,
							`<span class="chat-msg__doc-meta">${escapeHtml(m.summary)}</span>`,
						);
					}
				}
				if (m.status === "done" || m.status === "error") {
					this.finalizeToolElement(toolEl);
				}
				this.scrollToBottom();
				continue;
			}

			const type = msgType(m);
			const content = getMessageContent(m);
			const toolCalls = getMessageToolCalls(m);

			if (type === "human" || type === "user") {
				const { listEl } = this.createConversationTurn(
					typeof content === "string" ? content : JSON.stringify(content),
					targetEl,
				);
				currentListEl = listEl;
				currentAssistantShell = null;
				continue;
			}

			if (type === "ai") {
				if (!currentListEl) {
					const turn = this.createConversationTurn(undefined, targetEl);
					currentListEl = turn.listEl;
				}
				if (!currentAssistantShell) {
					currentAssistantShell = this.createAssistantMessageShell();
					currentListEl.appendChild(currentAssistantShell.el);
				}
				if (content) {
					this.compactCompletedActivityBlocks(currentAssistantShell, "lookup");
					const textEl = document.createElement("div");
					textEl.className = "chat-msg__text";
					textEl.innerHTML = renderMarkdown(content);
					currentAssistantShell.stackEl.appendChild(textEl);
				}
				/* Tool call elements are created by the subsequent
				   ToolMessageUi entries — not here. */
				this.scrollToBottom();
				continue;
			}

			/* Unknown message type — skip */
		}

		if (currentAssistantShell)
			this.compactCompletedActivityBlocks(currentAssistantShell, "lookup");
	}

	private appendStaticMessage(
		role: string,
		content: string,
		toolCalls?: any[] | null,
		toolName?: string,
		toolUIEvents?: ToolUIEvent[],
		startToolCallIndex = -1,
		targetEl?: HTMLElement,
	): number {
		const el = this.createStaticMessageElement(role, content, toolCalls, toolName, toolUIEvents, startToolCallIndex);
		(targetEl || this.messagesEl).appendChild(el);
		this.scrollToBottom();
		if (role === "tool") return startToolCallIndex;
		const toolEls = el.querySelectorAll<HTMLElement>(".chat-msg__tool[data-tool-call-index]");
		if (!toolEls.length) return startToolCallIndex;
		const lastToolEl = toolEls[toolEls.length - 1];
		return Number(lastToolEl.dataset.toolCallIndex || startToolCallIndex);
	}

	private createStaticMessageElement(
		role: string,
		content: string,
		toolCalls?: any[] | null,
		toolName?: string,
		toolUIEvents?: ToolUIEvent[],
		startToolCallIndex = -1,
	): HTMLElement {
		if (role === "assistant") {
			const shell = this.createAssistantMessageShell();
			if (content) {
				const textEl = document.createElement("div");
				textEl.className = "chat-msg__text";
				textEl.innerHTML = renderMarkdown(content);
				shell.stackEl.appendChild(textEl);
			}

			let toolCallIndex = startToolCallIndex;
			for (const tc of toolCalls || []) {
				toolCallIndex += 1;
				const toolEl = this.createToolCallElement(tc.name, undefined, toolCallIndex, getToolCallId(tc));
				this.attachToolElementToShell(shell, toolEl);
				if (toolUIEvents?.length) {
					for (const event of toolUIEvents) {
						if (this.toolEventMatchesElement(event, toolEl))
							this.applyToolUIEvent(toolEl, event);
					}
				}
			}
			return shell.el;
		}

		const el = document.createElement("div");
		el.className = `chat-msg chat-msg--${role}`;

		let html = "";
		let toolCallIndex = startToolCallIndex;

		if (role === "tool") {
			const trimmed = this.localizeToolResult(content || "");
			if (!trimmed) {
				// skip empty tool results entirely
			} else {
				html = `<div class="chat-msg__tool-result">
				<div class="chat-msg__tool-header">🔧 ${escapeHtml(this.t("chat.tool.result"))}${toolName ? `: ${escapeHtml(toolName)}` : ""}</div>
				<pre style="max-height: 200px; overflow-y: auto;">${escapeHtml(trimmed)}</pre>
			</div>`;
			}
		} else {
			if (content)
				html += renderMarkdown(content);
				if (toolCalls && toolCalls.length) {
					for (const tc of toolCalls) {
						toolCallIndex += 1;
						html += `<div class="chat-msg__tool" data-tool-call-index="${toolCallIndex}" data-tool-name="${escapeHtml(tc.name)}">
							<details>
								<summary>${this.buildToolSummaryHtml(tc.name)}</summary>
							</details>
						</div>`;
					}
				}
		}

		el.innerHTML = `<div class="chat-msg__content">${html}</div>`;
		if (role !== "tool" && toolUIEvents?.length) {
			const toolEls = el.querySelectorAll<HTMLElement>(".chat-msg__tool[data-tool-call-index]");
			for (const toolEl of toolEls) {
				for (const event of toolUIEvents) {
					if (this.toolEventMatchesElement(event, toolEl))
						this.applyToolUIEvent(toolEl, event);
				}
			}
		}
		return el;
	}

	private createAssistantMessageShell(): AssistantMessageShell {
		const el = document.createElement("div");
		el.className = "chat-msg chat-msg--assistant";

		const contentEl = document.createElement("div");
		contentEl.className = "chat-msg__content chat-msg__assistant-shell";

		const stackEl = document.createElement("div");
		stackEl.className = "chat-msg__assistant-stack";

		contentEl.appendChild(stackEl);
		el.appendChild(contentEl);
		const refs: AssistantMessageShell = {
			el,
			contentEl,
			stackEl,
		};
		(el as any).__assistantShell = refs;
		return refs;
	}

	private appendAssistantSegment(
		shell: AssistantMessageShell,
		content: string,
		toolCalls: any[] | null | undefined,
		toolUIEvents: ToolUIEvent[] | undefined,
		startToolCallIndex = -1,
	): { toolCallIndex: number; toolEls: HTMLElement[] } {
		if (content) {
			this.compactCompletedActivityBlocks(shell, "lookup");
			const textEl = document.createElement("div");
			textEl.className = "chat-msg__text";
			textEl.innerHTML = renderMarkdown(content);
			shell.stackEl.appendChild(textEl);
		}

		let toolCallIndex = startToolCallIndex;
		const toolEls: HTMLElement[] = [];
		for (const tc of toolCalls || []) {
			toolCallIndex += 1;
			const toolEl = this.createToolCallElement(tc.name, undefined, toolCallIndex, getToolCallId(tc));
			this.attachToolElementToShell(shell, toolEl);
			if (toolUIEvents?.length) {
				for (const event of toolUIEvents) {
					if (this.toolEventMatchesElement(event, toolEl))
						this.applyToolUIEvent(toolEl, event);
				}
			}
			toolEls.push(toolEl);
		}

		return { toolCallIndex, toolEls };
	}

	private createToolCallElement(toolName: string, args?: unknown, toolCallIndex?: number, toolCallId?: string): HTMLElement {
		const el = document.createElement("div");
		el.className = "chat-msg__tool";
		el.dataset.toolName = toolName;
		el.dataset.toolCategory = getToolCategory(toolName);
		el.dataset.toolAction = getToolAction(toolName);
		el.dataset.toolStatus = "pending";
		if (typeof toolCallIndex === "number")
			el.dataset.toolCallIndex = String(toolCallIndex);
		if (toolCallId)
			el.dataset.toolCallId = toolCallId;

		const details = document.createElement("details");
		details.open = true;
		const summary = document.createElement("summary");
		summary.innerHTML = this.buildToolSummaryHtml(
			toolName,
			`<span class="chat-msg__doc-meta">${escapeHtml(this.t("chat.tool.pending"))}</span>`,
			el.dataset.toolCategory as "lookup" | "change"
		);
		details.appendChild(summary);

		if (args !== undefined && args !== null && args !== "") {
			const argsStr = typeof args === "string" ? args : JSON.stringify(args, null, 2);
			if (argsStr && argsStr !== "{}" && argsStr !== "\"\"") {
				const pre = document.createElement("pre");
				pre.className = "chat-msg__tool-args";
				pre.textContent = argsStr;
				details.appendChild(pre);
			}
		}

		el.appendChild(details);
		return el;
	}

	private getAssistantShellFromElement(el: HTMLElement | null): AssistantMessageShell | null {
		return el ? ((el as any).__assistantShell ?? null) : null;
	}

	private getActivityBlockFromElement(el: HTMLElement | null): ActivityBlockRefs | null {
		return el ? ((el as any).__activityBlock ?? null) : null;
	}

	private attachToolElementToShell(shell: AssistantMessageShell, toolEl: HTMLElement): void {
		const category = (toolEl.dataset.toolCategory as "lookup" | "change") || "lookup";
		const block = this.getTailActivityBlock(shell, category) || this.createActivityBlock(shell, category);
		this.compactActivityBlock(block, { includeLatestDone: false });
		block.currentEl.appendChild(toolEl);
		this.refreshActivityBlock(block);
	}

	private getTailActivityBlock(shell: AssistantMessageShell, category: "lookup" | "change"): ActivityBlockRefs | null {
		const last = shell.stackEl.lastElementChild as HTMLElement | null;
		const block = this.getActivityBlockFromElement(last);
		return block?.category === category ? block : null;
	}

	private createActivityBlock(shell: AssistantMessageShell, category: "lookup" | "change"): ActivityBlockRefs {
		const el = document.createElement("div");
		el.className = `chat-msg__activity-block chat-msg__activity-block--${category}`;
		el.dataset.category = category;

		const archiveEl = document.createElement("details");
		archiveEl.className = "chat-msg__activity-archive fn__none";
		const archiveSummary = document.createElement("summary");
		archiveEl.appendChild(archiveSummary);
		const archiveListEl = document.createElement("div");
		archiveListEl.className = "chat-msg__activity-list";
		archiveEl.appendChild(archiveListEl);

		const currentEl = document.createElement("div");
		currentEl.className = "chat-msg__activity-current";

		el.append(archiveEl, currentEl);
		shell.stackEl.appendChild(el);

		const refs: ActivityBlockRefs = {
			el,
			category,
			currentEl,
			archiveEl,
			archiveListEl,
		};
		(el as any).__activityBlock = refs;
		return refs;
	}

	private compactCompletedActivityBlocks(shell: AssistantMessageShell, category: "lookup" | "change"): void {
		const children = Array.from(shell.stackEl.children) as HTMLElement[];
		for (const child of children) {
			const block = this.getActivityBlockFromElement(child);
			if (!block || block.category !== category)
				continue;
			this.compactActivityBlock(block, { includeLatestDone: true });
		}
	}

	private compactActivityBlock(
		block: ActivityBlockRefs,
		options: { includeLatestDone: boolean },
	): void {
		const currentTools = Array.from(block.currentEl.querySelectorAll<HTMLElement>(":scope > .chat-msg__tool"));
		if (currentTools.length === 0) {
			this.refreshActivityBlock(block);
			return;
		}

		const doneTools = currentTools.filter((toolEl) => toolEl.dataset.toolStatus === "done");
		if (doneTools.length === 0) {
			this.refreshActivityBlock(block);
			return;
		}

		const keepVisible = !options.includeLatestDone && currentTools[currentTools.length - 1]?.dataset.toolStatus === "done"
			? currentTools[currentTools.length - 1]
			: null;

		for (const toolEl of doneTools) {
			if (keepVisible === toolEl)
				continue;
			if (!toolEl.classList.contains("chat-msg__tool--archived")) {
				block.archiveListEl.appendChild(toolEl);
				toolEl.classList.add("chat-msg__tool--archived");
			}
		}

		this.refreshActivityBlock(block);
	}

	private refreshActivityBlock(block: ActivityBlockRefs): void {
		const tools = Array.from(block.archiveListEl.querySelectorAll<HTMLElement>(".chat-msg__tool"));
		const total = tools.length;
		block.archiveEl.classList.toggle("fn__none", total === 0);
		block.el.classList.toggle("fn__none", total === 0 && block.currentEl.children.length === 0);

		const summary = block.archiveEl.querySelector("summary");
		if (!summary) return;

		const counts = new Map<string, number>();
		for (const toolEl of tools) {
			const action = toolEl.dataset.toolAction || "other";
			counts.set(action, (counts.get(action) || 0) + 1);
		}
		const chips = [...counts.entries()]
			.map(([action, count]) => `<span class="chat-msg__activity-chip">${escapeHtml(getActionLabel(action, this.i18n))} ${count}</span>`)
			.join("");
		const title = block.category === "change"
			? this.t("chat.tool.changed", { count: total })
			: this.t("chat.tool.lookedUp", { count: total });
		summary.innerHTML = `<span class="chat-msg__activity-title">${escapeHtml(title)}</span>${chips}`;
	}

	private findPendingToolElement(toolCallId: string, pendingToolEls: HTMLElement[]): HTMLElement | null {
		if (toolCallId) {
			const matchedIndex = pendingToolEls.findIndex(el => el.dataset.toolCallId === toolCallId);
			if (matchedIndex >= 0)
				return pendingToolEls.splice(matchedIndex, 1)[0];
		}
		return pendingToolEls.shift() || null;
	}

	private findToolElementForEvent(
		shell: AssistantMessageShell,
		event: ToolUIEvent,
		pendingToolEls: HTMLElement[],
	): HTMLElement | null {
		if (event.toolCallId) {
			const pendingMatch = pendingToolEls.find(el => el.dataset.toolCallId === event.toolCallId);
			if (pendingMatch)
				return pendingMatch;
			return shell.el.querySelector<HTMLElement>(`.chat-msg__tool[data-tool-call-id="${CSS.escape(event.toolCallId)}"]`);
		}
		if (typeof event.toolCallIndex === "number" && event.toolCallIndex >= 0) {
			return shell.el.querySelector<HTMLElement>(`.chat-msg__tool[data-tool-call-index="${event.toolCallIndex}"]`);
		}
		return pendingToolEls[pendingToolEls.length - 1] || null;
	}

	private toolEventMatchesElement(event: ToolUIEvent, toolEl: HTMLElement): boolean {
		if (event.toolCallId && toolEl.dataset.toolCallId)
			return event.toolCallId === toolEl.dataset.toolCallId;
		return Number(toolEl.dataset.toolCallIndex) === event.toolCallIndex;
	}

	private applyToolUIEvent(toolEl: HTMLElement, event: ToolUIEvent): void {
		const details = toolEl.querySelector("details");
		if (!details) return;
		toolEl.dataset.hasEvents = "true";
		const category = getToolCategory(event.toolName || toolEl.dataset.toolName, event.payload);
		toolEl.dataset.toolCategory = category;
		toolEl.dataset.toolAction = getToolAction(event.toolName || toolEl.dataset.toolName, event.payload);

		if (event.payload.type === "activity") {
			this.renderToolActivitySummary(toolEl, details, event, event.payload);
			return;
		}

		if (event.payload.type === "created_document") {
			this.renderToolActivitySummary(toolEl, details, event, {
				type: "activity",
				category: "change",
				action: "create",
				id: event.payload.id,
				path: event.payload.path,
				label: event.payload.path,
				meta: this.t("chat.tool.createdDocument"),
				open: true,
			});
			return;
		}

		if (event.payload.type === "document_link") {
			this.renderToolActivitySummary(toolEl, details, event, {
				type: "activity",
				category: "lookup",
				action: "read",
				id: event.payload.id,
				path: event.payload.path,
				label: event.payload.label,
				meta: this.t("chat.tool.readDocument"),
				open: event.payload.open,
			});
			return;
		}

		if (event.payload.type === "document_blocks") {
			this.renderToolActivitySummary(toolEl, details, event, {
				type: "activity",
				category: "lookup",
				action: "read",
				id: event.payload.id,
				path: event.payload.path,
				label: event.payload.path,
				meta: this.t("chat.tool.readBlocks", { count: event.payload.blockCount }),
				open: event.payload.open,
			});
			return;
		}

		if (event.payload.type === "append_block") {
			this.renderToolActivitySummary(toolEl, details, event, {
				type: "activity",
				category: "change",
				action: "append",
				id: event.payload.parentID,
				path: event.payload.path,
				label: event.payload.path,
				meta: this.t("chat.tool.appendedBlocks", { count: event.payload.blockIDs.length || 0 }),
				open: event.payload.open,
			});
			return;
		}

		if (event.payload.type === "edit_blocks") {
			this.renderToolActivitySummary(toolEl, details, event, {
				type: "activity",
				category: "change",
				action: "edit",
				id: event.payload.primaryDocumentID || event.payload.documentIDs[0],
				path: event.payload.path,
				label: event.payload.path,
				meta: this.t("chat.tool.editedBlocks", { count: event.payload.editedCount }),
				open: event.payload.open,
			});
			return;
		}

		const line = document.createElement("div");
		line.className = "chat-msg__tool-progress";
		line.textContent = event.payload.type === "text"
			? event.payload.text
			: event.payload.raw;
		details.appendChild(line);
	}

	private appendToolResultToElement(toolEl: HTMLElement, result: string): void {
		const details = toolEl.querySelector("details");
		if (!details) return;

		// Skip raw result if the tool already has rich UI events
		if (toolEl.dataset.hasEvents === "true") return;

		// Skip empty or whitespace-only results
		const trimmed = this.localizeToolResult(result);
		if (!trimmed) return;

		const pre = document.createElement("pre");
		pre.className = "chat-msg__tool-result";
		pre.textContent = trimmed.length > 500 ? trimmed.slice(0, 500) + "..." : trimmed;
		details.appendChild(pre);
	}

	private finalizeToolElement(toolEl: HTMLElement): void {
		if (toolEl.dataset.toolStatus === "done")
			return;
		toolEl.dataset.toolStatus = "done";
		const details = toolEl.querySelector("details");
		if (details)
			details.open = false;
		const block = this.getActivityBlockFromElement(toolEl.parentElement?.closest(".chat-msg__activity-block") as HTMLElement | null);
		if (block)
			this.refreshActivityBlock(block);
	}

	private renderToolActivitySummary(
		toolEl: HTMLElement,
		details: HTMLDetailsElement,
		event: ToolUIEvent,
		options: { id?: string; path?: string; label?: string; meta?: string; open?: boolean; category?: "lookup" | "change"; action?: string },
	): void {
		const summary = details.querySelector("summary");
		if (!summary) return;

		const docId = options.id || "";
		const docTitle = escapeHtml(options.label || options.path || docId || this.t("chat.tool.defaultDocument"));
		const meta = options.meta ? `<span class="chat-msg__doc-meta">${escapeHtml(options.meta)}</span>` : "";
		const canOpen = Boolean(docId) && options.open !== false;
		const contentHtml = docId
			? `<a class="${canOpen ? "chat-msg__doc-link chat-msg__doc-link--open" : "chat-msg__doc-link chat-msg__doc-link--muted"}" data-id="${escapeHtml(docId)}" href="javascript:void(0)">${docTitle}</a>${meta}`
			: `<span class="chat-msg__doc-label">${docTitle}</span>${meta}`;
		summary.innerHTML = this.buildToolSummaryHtml(
			event.toolName || toolEl.dataset.toolName || "tool",
			contentHtml,
			(options.category || toolEl.dataset.toolCategory as "lookup" | "change")
		);

		const link = summary.querySelector<HTMLElement>(".chat-msg__doc-link");
		if (link && canOpen && docId) {
			link.addEventListener("click", () => {
				openTab({ app: (globalThis as any).siyuanApp, doc: { id: docId } });
			});
		} else if (link) {
			link.addEventListener("click", (e) => {
				e.preventDefault();
			});
		}

		const block = this.getActivityBlockFromElement(toolEl.closest(".chat-msg__activity-block") as HTMLElement | null);
		if (block)
			this.refreshActivityBlock(block);
	}

	private buildToolSummaryHtml(toolName: string, contentHtml = "", category?: "lookup" | "change"): string {
		const resolvedCategory = category || getToolCategory(toolName);
		const badge = resolvedCategory === "change" ? this.t("chat.tool.badge.change") : this.t("chat.tool.badge.lookup");
		return `<span class="chat-msg__tool-prefix"><span class="chat-msg__tool-dot" aria-hidden="true"></span>${escapeHtml(badge)}</span><span class="chat-msg__tool-title">${escapeHtml(getToolDisplayTitle(toolName, this.i18n))}</span>${contentHtml}`;
	}

	private scrollToBottom(): void {
		if (this.autoScroll)
			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private setLoading(loading: boolean): void {
		if (loading) {
			this.sendBtn.innerHTML = this.getStopIconMarkup();
			this.sendBtn.title = this.t("chat.stopTitle");
			this.sendBtn.setAttribute("aria-label", this.t("chat.stop"));
			this.sendBtn.onclick = () => this.stop();
			this.textareaEl.placeholder = this.t("chat.loadingPlaceholder");
		} else {
			this.sendBtn.innerHTML = this.getSendIconMarkup();
			this.sendBtn.title = this.t("chat.sendTitle");
			this.sendBtn.setAttribute("aria-label", this.t("chat.send"));
			this.sendBtn.onclick = () => this.send();
			this.textareaEl.placeholder = this.t("chat.placeholder");
		}
	}

	/* --- Todos progress bar rendering --- */

	private renderTodosBar(shell: AssistantMessageShell, todos: TodoList): void {
		/* Remove any existing todos bar in the same assistant message */
		const existing = shell.stackEl.querySelector(".chat-todos-bar");
		if (existing) existing.remove();

		const bar = this.buildTodosBarElement(todos);
		shell.stackEl.appendChild(bar);
	}

	private renderPersistedTodosBar(todos: TodoList): void {
		/* Render at end of messagesEl for persisted sessions */
		const bar = this.buildTodosBarElement(todos);
		this.messagesEl.appendChild(bar);
	}

	private buildTodosBarElement(todos: TodoList): HTMLElement {
		const bar = document.createElement("details");
		bar.className = "chat-todos-bar";
		bar.open = true;

		const completed = todos.items.filter((i) => i.status === "completed").length;
		const total = todos.items.length;
		const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

		const summary = document.createElement("summary");
		summary.className = "chat-todos-bar__summary";
		summary.innerHTML = `📋 ${escapeHtml(todos.goal)} <span class="chat-todos-bar__progress">${completed}/${total} (${pct}%)</span>`;
		bar.appendChild(summary);

		const list = document.createElement("ul");
		list.className = "chat-todos-bar__list";
		for (const item of todos.items) {
			const li = document.createElement("li");
			li.className = `chat-todos-bar__item chat-todos-bar__item--${item.status}`;
			const icon = item.status === "completed" ? "✅" : item.status === "in_progress" ? "🔄" : "⬜";
			li.textContent = `${icon} ${item.content}`;
			list.appendChild(li);
		}
		bar.appendChild(list);

		return bar;
	}

	/* --- Edit blocks diff rendering (commented out for future reimplementation) --- */

	// private renderEditBlocksDiff(resultJson: string): HTMLElement { ... }
	// private stripIAL(kramdown: string): string { ... }
	// private computeLineDiff(oldText: string, newText: string): string { ... }
	// private lcsLines(a: string[], b: string[]): string[] { ... }
	// private undoBlockEdit(blockId: string, originalContent: string): Promise<void> { ... }

	/* --- Persistence --- */

	private async loadStore(): Promise<void> {
		await this.store.ensureLoaded();
		const activeId = this.store.getIndex().activeId;
		this.activeSession = await this.store.loadSession(activeId);
		this.tasksView.selectedTaskId = this.taskManager.listTaskEntries()[0]?.id || null;
		this.renderCurrentSession();
		await this.tasksView.render();
		await this.settingsView.render();
		this.setCurrentView(this.currentView);
		this.updateSessionToggleState();
	}

	private async handleStoreChanged(): Promise<void> {
		await this.store.ensureLoaded();
		const chatSessions = this.getChatSessions();
		if (!chatSessions.some((session) => session.id === this.activeSession?.id)) {
			const activeId = this.store.getIndex().activeId;
			this.activeSession = await this.store.loadSession(activeId);
			this.renderCurrentSession();
		}
		if (this.currentView === "tasks") {
			await this.tasksView.render();
		}
		this.refreshSessionListUi();
	}

	private setCurrentView(view: "chat" | "tasks" | "settings"): void {
		this.currentView = view;
		this.chatViewEl.classList.toggle("fn__none", view !== "chat");
		this.tasksViewEl.classList.toggle("fn__none", view !== "tasks");
		this.settingsViewEl.classList.toggle("fn__none", view !== "settings");
		this.bottomBarEl.classList.toggle("chat-panel__bottom-bar--chat", view === "chat");
		this.composerBodyEl.classList.toggle("chat-panel__composer-body--collapsed", view !== "chat");
		this.bottomBarEl.querySelectorAll<HTMLElement>("[data-view]").forEach((button) => {
			button.classList.toggle("chat-panel__switch-btn--active", button.dataset.view === view);
			button.setAttribute("aria-selected", String(button.dataset.view === view));
		});
		if (view === "tasks") {
			void this.tasksView.render();
		} else if (view === "settings") {
			void this.settingsView.render();
		}
	}

	private async refreshModelSelector(): Promise<void> {
		return Promise.resolve();
	}

	private async getConfig(): Promise<AgentConfig> {
		if (Object.prototype.hasOwnProperty.call(this.plugin.data, CONFIG_STORAGE)) {
			const cached = this.plugin.data[CONFIG_STORAGE];
			return normalizeAgentConfig(cached);
		}
		try {
			await this.plugin.loadData(CONFIG_STORAGE);
			const saved = this.plugin.data[CONFIG_STORAGE];
			if (Object.prototype.hasOwnProperty.call(this.plugin.data, CONFIG_STORAGE)) {
				return normalizeAgentConfig(saved);
			}
		} catch {
			/* Use defaults */
		}
		return normalizeAgentConfig();
	}

	/* --- Autocomplete --- */

	private async queryDocs(keyword: string): Promise<{ id: string, title: string }[]> {
		const escaped = keyword.replace(/'/g, "''");
		const stmt = keyword
			? `SELECT * FROM blocks WHERE type='d' AND content LIKE '%${escaped}%' ORDER BY updated DESC LIMIT 8`
			: "SELECT * FROM blocks WHERE type='d' ORDER BY updated DESC LIMIT 8";

		try {
			const resp = await fetch("/api/query/sql", {
				method: "POST",
				body: JSON.stringify({ stmt }),
			});
			const json = await resp.json();
			if (json.code === 0 && Array.isArray(json.data)) {
				return json.data.map((d: any) => ({
					id: d.id,
					title: d.content,
				}));
			}
		} catch { /* ignore */ }
		return [];
	}

	private async handleConfigSaved(nextConfig: AgentConfig): Promise<void> {
		const pluginAny = this.plugin as Plugin & {
			mcpManager?: { connectAll?: (servers: McpServerConfig[]) => Promise<unknown>; getAllTools?: () => StructuredToolInterface[] };
		};
		await pluginAny.mcpManager?.connectAll?.((nextConfig.mcpServers || []).filter((item) => item.enabled));
		this.tools = [
			...getDefaultTools(() => nextConfig, () => this.taskManager, this.i18n),
			...(pluginAny.mcpManager?.getAllTools?.() || []),
		];
		await this.refreshModelSelector();
	}
}
