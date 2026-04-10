import { Plugin, showMessage, openTab } from "siyuan";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
	AgentConfig,
	AgentState,
	ScheduledTaskMeta,
	SessionData,
	SessionIndexEntry,
	ToolUIEvent,
	ToolUIEventPayload,
	DEFAULT_CONFIG,
	INIT_PROMPT,
	SLASH_COMMANDS,
} from "../types";
import { makeAgent, makeTracer } from "../core/agent";
import { mergeState, runAgentStream } from "../core/stream-runtime";
import { renderMarkdown } from "./markdown";
import { SessionStore } from "../core/session-store";
import { ScheduledTaskManager } from "../core/scheduled-task-manager";
import { groupTaskRuns, type TaskRunGroup } from "./task-run-group";
const CONFIG_STORAGE = "agent-config";

/** Extract the role string from either a live BaseMessage or a serialised dict. */
function msgType(m: any): string {
	// Live BaseMessage instance
	if (typeof m._getType === "function") return m._getType();
	// LangChain JS serialised format
	if (m.lc === 1 && Array.isArray(m.id)) {
		const cls = m.id[m.id.length - 1] as string;
		if (cls === "HumanMessage") return "human";
		if (cls === "AIMessage" || cls === "AIMessageChunk") return "ai";
		if (cls === "SystemMessage") return "system";
		if (cls === "ToolMessage") return "tool";
	}
	// Legacy plain-object
	return m.type ?? m.role ?? "";
}

function sessionTitle(state: AgentState): string {
	const msgs = state?.messages || [];
	const first = msgs.find((m: any) => {
		const t = msgType(m);
		return t === "human" || t === "user";
	});
	if (!first) return "New Chat";
	const rawContent = first.kwargs?.content ?? first.content;
	const text = (typeof rawContent === "string" ? rawContent : "").replace(/^>.*\n\n/s, "").trim();
	return text.length > 30 ? text.slice(0, 30) + "..." : text;
}

function cloneMessage(raw: Record<string, any>): Record<string, any> {
	return {
		...raw,
		kwargs: raw.kwargs ? { ...raw.kwargs } : raw.kwargs,
	};
}

function getMessageContent(raw: Record<string, any>): string {
	const content = raw.kwargs?.content ?? raw.content;
	return typeof content === "string" ? content : "";
}

function getMessageToolCalls(raw: Record<string, any>): any[] {
	const toolCalls = raw.kwargs?.tool_calls ?? raw.tool_calls;
	return Array.isArray(toolCalls) ? toolCalls : [];
}

function getMessageToolCallId(raw: Record<string, any>): string {
	const toolCallId = raw.kwargs?.tool_call_id ?? raw.tool_call_id;
	return typeof toolCallId === "string" ? toolCallId : "";
}

function getToolCallId(raw: Record<string, any>): string {
	const toolCallId = raw?.id ?? raw?.tool_call_id;
	return typeof toolCallId === "string" ? toolCallId : "";
}

function setMessageContent(raw: Record<string, any>, content: string): void {
	if (raw.kwargs && "content" in raw.kwargs) {
		raw.kwargs.content = content;
	} else {
		raw.content = content;
	}
}

function setMessageToolCalls(raw: Record<string, any>, toolCalls: any[]): void {
	if (raw.kwargs && ("tool_calls" in raw.kwargs || raw.lc === 1)) {
		raw.kwargs = raw.kwargs || {};
		raw.kwargs.tool_calls = toolCalls;
	} else {
		raw.tool_calls = toolCalls;
	}
}

function normalizeMessagesForDisplay(messages: any[]): any[] {
	const normalized: any[] = [];
	for (const raw of messages || []) {
		const type = msgType(raw);
		if (type !== "ai") {
			normalized.push(raw);
			continue;
		}

		const prev = normalized[normalized.length - 1];
		if (prev && msgType(prev) === "ai") {
			const merged = cloneMessage(prev);
			setMessageContent(merged, getMessageContent(prev) + getMessageContent(raw));
			setMessageToolCalls(merged, [...getMessageToolCalls(prev), ...getMessageToolCalls(raw)]);
			normalized[normalized.length - 1] = merged;
			continue;
		}

		normalized.push(cloneMessage(raw));
	}
	return normalized;
}

interface AssistantMessageShell {
	el: HTMLElement;
	contentEl: HTMLElement;
	stackEl: HTMLElement;
}

interface ActivityBlockRefs {
	el: HTMLElement;
	category: "lookup" | "change";
	currentEl: HTMLElement;
	archiveEl: HTMLDetailsElement;
	archiveListEl: HTMLElement;
}

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
	private sendBtn: HTMLElement;
	private contextBar: HTMLElement;
	private tasksSummaryEl: HTMLElement;
	private taskListEl: HTMLElement;
	private taskDetailEl: HTMLElement;

	private activeSession: SessionData;
	private selectedTaskId: string | null = null;
	private currentView: "chat" | "tasks" | "settings" = "chat";
	private pendingContext: string | null = null;
	private abortCtrl: AbortController | null = null;
	private pendingEl: HTMLElement | null = null;
	private autoScroll = true;
	private sessionListExpanded = false;
	private renderingTasks = false;
	private unsubs: Array<() => void> = [];

	/* Autocomplete */
	private completionEl: HTMLElement | null = null;
	private completionIdx = 0;
	private completionList: { id: string, title: string }[] = [];
	private completionRange: { start: number, end: number } | null = null;

	constructor(
		element: HTMLElement,
		plugin: Plugin,
		tools: StructuredToolInterface[],
		store: SessionStore,
		taskManager: ScheduledTaskManager,
	) {
		this.container = element;
		this.plugin = plugin;
		this.tools = tools;
		this.store = store;
		this.taskManager = taskManager;
		this.render();
		this.unsubs.push(this.store.subscribe(() => {
			void this.handleStoreChanged();
		}));
		void this.loadStore();
	}

	private render(): void {
		this.container.innerHTML = `
<div class="chat-panel fn__flex-column" style="height:100%">
	<div class="chat-panel__chat-view">
		<div class="chat-panel__session-bar">
			<button class="chat-panel__session-toggle b3-button b3-button--text" type="button" aria-expanded="false">
				<span class="chat-panel__session-toggle-main">
					<span class="chat-panel__session-name">New Chat</span>
				</span>
				<span class="chat-panel__session-toggle-side">
					<svg class="chat-panel__session-toggle-chevron" aria-hidden="true"><use xlink:href="#iconDown"></use></svg>
				</span>
			</button>
			<span class="fn__flex-1"></span>
			<span class="chat-panel__session-action chat-panel__new-session block__icon block__icon--show b3-tooltips b3-tooltips__sw" aria-label="New Chat">
				<svg style="width:16px;height:16px"><use xlink:href="#iconAdd"></use></svg>
			</span>
			<span class="chat-panel__session-action chat-panel__clear block__icon block__icon--show b3-tooltips b3-tooltips__sw" aria-label="Clear">
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
				<textarea class="chat-panel__textarea b3-text-field" rows="3" placeholder="Ask anything..."></textarea>
			</div>
		</div>
		<div class="chat-panel__bottom-footer">
			<div class="chat-panel__view-switcher" role="tablist" aria-label="视图切换">
				<button class="chat-panel__switch-btn chat-panel__switch-btn--active" type="button" data-view="chat">聊天</button>
				<button class="chat-panel__switch-btn" type="button" data-view="tasks">任务</button>
				<button class="chat-panel__switch-btn" type="button" data-view="settings">设置</button>
			</div>
			<div class="chat-panel__actions">
				<button class="chat-panel__send b3-button b3-button--text" type="button">
					<svg class="chat-panel__send-icon"><use xlink:href="#iconPlay"></use></svg>
					Send
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
		this.tasksSummaryEl = this.container.querySelector(".chat-panel__tasks-header");
		this.taskListEl = this.container.querySelector(".chat-panel__tasks-list");
		this.taskDetailEl = this.container.querySelector(".chat-panel__tasks-detail");
		this.applyEditorFontFamily();

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

		/* Send on Ctrl+Enter / Cmd+Enter */
		this.textareaEl.addEventListener("keydown", (e) => {
			if (this.completionEl) {
				this.handleCompletionKey(e);
				return;
			}
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				this.send();
			}
		});

		/* Autocomplete trigger */
		this.textareaEl.addEventListener("input", (e) => {
			this.handleInput(e);
		});
		this.textareaEl.addEventListener("click", () => {
			this.hideCompletion();
		});
		this.textareaEl.addEventListener("blur", () => {
			setTimeout(() => this.hideCompletion(), 200);
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
			this.sessionListEl.innerHTML = `<div class="chat-session-list__empty">暂无会话</div>`;
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
			const title = this.escapeHtml(s.title || "New Chat");
			const date = this.escapeHtml(this.formatSessionDate(s.updated));
			return `<div class="chat-session-item${active}" data-id="${s.id}">
				<div class="chat-session-item__info">
					<div class="chat-session-item__line">
						<span class="chat-session-item__title">${title}</span>
						<span class="chat-session-item__meta">${date}</span>
					</div>
				</div>
				<span class="chat-session-item__delete block__icon b3-tooltips b3-tooltips__sw" aria-label="Delete" data-delete="${s.id}">
					<svg><use xlink:href="#iconTrashcan"></use></svg>
				</span>
			</div>`;
		}).join("")}</div>
			${canExpand ? `
				<button class="chat-session-list__more b3-button b3-button--text" type="button" data-action="toggle-expand">
					<span>${this.sessionListExpanded ? "收起" : `展开更多 ${hiddenCount} 条`}</span>
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
			nameEl.textContent = entry?.title || "New Chat";
		this.updateSessionToggleState();

	/* Re-render messages from state */
		this.messagesEl.innerHTML = "";
		const messages = normalizeMessagesForDisplay(s.state?.messages || []);
		const toolUIEvents = Array.isArray(s.state?.toolUIEvents) ? s.state.toolUIEvents as ToolUIEvent[] : [];
		this.renderConversationMessages(messages, toolUIEvents);
	}

	/* --- Send --- */

	private async send(): Promise<void> {
		if (this.currentView !== "chat") {
			this.setCurrentView("chat");
			this.textareaEl.focus();
			return;
		}

		let text = this.textareaEl.value.trim();
		if (!text && !this.pendingContext)
			return;

		const config = await this.getConfig();
		if (!config.apiKey) {
			showMessage("Please configure API Key in plugin settings first.");
			return;
		}

		/* Handle slash commands */
		let extraSystemPrompt: string | null = null;
		const initMatch = text.match(/^\/init(?:\s+([\s\S]*))?$/i);
		if (initMatch) {
			const guideDocId = config.guideDoc?.id;
			if (!guideDocId) {
				showMessage("请先在插件设置中配置「用户指南文档」，/init 将把探索结果写入该文档。");
				return;
			}
			const extra = (initMatch[1] || "").trim();
			extraSystemPrompt = INIT_PROMPT.replace(
				"请开始探索。",
				`目标文档 ID（请将结果写入此文档）：${guideDocId}\n\n${extra ? "额外指令：" + extra + "\n\n" : ""}请开始探索。`
			);
		}

		/* Build user message content with optional context */
		let content = "";
		if (this.pendingContext) {
			content = `> ${this.pendingContext.replace(/\n/g, "\n> ")}\n\n${text}`;
			this.clearContext();
		} else {
			content = text;
		}

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
		this.pendingEl.innerHTML = `<span class="chat-msg__pending-spinner"></span><span class="chat-msg__pending-text">思考中</span>`;
		assistantShell.stackEl.appendChild(this.pendingEl);
		this.scrollToBottom();

		this.abortCtrl = new AbortController();

		let curTextEl: HTMLElement | null = null;
		let curBuffer = "";
		const pendingToolEls: HTMLElement[] = [];
		const existingToolUIEvents: ToolUIEvent[] = Array.isArray(s.state?.toolUIEvents) ? [...s.state.toolUIEvents] : [];
		const input = mergeState(s.state ?? null, content) as any;
		let latestState: AgentState = {
			...s.state,
			messages: input.messages,
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
			errorEl.textContent = `Error: ${String(error)}`;
			assistantShell.stackEl.appendChild(errorEl);
			this.scrollToBottom();
		};

		try {
			const agent = await makeAgent(config, this.tools, extraSystemPrompt);
			const tracer = makeTracer(config);
			const result = await runAgentStream({
				agent,
				input,
				callbacks: tracer ? [tracer] : undefined,
				signal: this.abortCtrl?.signal,
				existingToolUIEvents,
				onUiEvent: (event) => {
					if (event.type === "text_delta") {
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
			s.updated = Date.now();
			s.title = sessionTitle(latestState);
			const indexEntry = this.store.getSessionSummary(s.id);
			if (indexEntry) {
				indexEntry.title = s.title;
			}
			const nameEl = this.container.querySelector(".chat-panel__session-name");
			if (nameEl) nameEl.textContent = s.title || "New Chat";
			await this.store.saveSession(s);
			this.refreshSessionListUi();

			this.abortCtrl = null;
			this.setLoading(false);
		}
	}

	addContext(text: string): void {
		this.pendingContext = text;
		this.contextBar.classList.remove("fn__none");
		this.contextBar.innerHTML = `
<div class="chat-panel__context">
	<span class="chat-panel__context-label">📎 Reference</span>
	<span class="chat-panel__context-text">${this.escapeHtml(text.length > 100 ? text.slice(0, 100) + "..." : text)}</span>
	<span class="chat-panel__context-close block__icon b3-tooltips b3-tooltips__sw" aria-label="Remove">
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
			html = `<div class="chat-msg__tool-result">
				<div class="chat-msg__tool-header">🔧 Result${toolName ? `: ${this.escapeHtml(toolName)}` : ""}</div>
				<pre style="max-height: 200px; overflow-y: auto;">${this.escapeHtml(content)}</pre>
			</div>`;
		} else {
			if (content)
				html += renderMarkdown(content);
				if (toolCalls && toolCalls.length) {
					for (const tc of toolCalls) {
						toolCallIndex += 1;
						html += `<div class="chat-msg__tool" data-tool-call-index="${toolCallIndex}" data-tool-name="${this.escapeHtml(tc.name)}">
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
		el.dataset.toolCategory = this.getToolCategory(toolName);
		el.dataset.toolAction = this.getToolAction(toolName);
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
			`<span class="chat-msg__doc-meta">进行中</span>`,
			el.dataset.toolCategory as "lookup" | "change"
		);
		details.appendChild(summary);

		if (args !== undefined) {
			const pre = document.createElement("pre");
			pre.textContent = JSON.stringify(args, null, 2);
			details.appendChild(pre);
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

	private getToolCategory(toolName?: string, payload?: ToolUIEventPayload): "lookup" | "change" {
		if (payload?.type === "activity")
			return payload.category === "change" ? "change" : "lookup";
		if (payload?.type === "append_block" || payload?.type === "edit_blocks" || payload?.type === "created_document")
			return "change";
		const name = toolName || "";
		if ([
			"append_block",
			"edit_blocks",
			"create_document",
			"move_document",
			"rename_document",
			"delete_document",
			"create_scheduled_task",
			"update_scheduled_task",
			"delete_scheduled_task",
		].includes(name))
			return "change";
		return "lookup";
	}

	private getToolAction(toolName?: string, payload?: ToolUIEventPayload): string {
		if (payload?.type === "activity")
			return payload.action;
		if (payload?.type === "created_document") return "create";
		if (payload?.type === "append_block") return "append";
		if (payload?.type === "edit_blocks") return "edit";
		if (payload?.type === "document_link" || payload?.type === "document_blocks") return "read";

		switch (toolName) {
			case "list_notebooks":
			case "list_documents":
			case "recent_documents":
			case "list_scheduled_tasks":
				return "list";
			case "get_document":
			case "get_document_blocks":
				return "read";
			case "search_fulltext":
			case "search_documents":
				return "search";
			case "create_document":
			case "create_scheduled_task":
				return "create";
			case "append_block":
				return "append";
			case "edit_blocks":
			case "update_scheduled_task":
				return "edit";
			case "move_document":
				return "move";
			case "rename_document":
				return "rename";
			case "delete_document":
			case "delete_scheduled_task":
				return "delete";
			default:
				return "other";
		}
	}

	private getToolDisplayTitle(toolName: string): string {
		switch (toolName) {
			case "list_notebooks": return "列出笔记本";
			case "list_documents": return "列出文档";
			case "recent_documents": return "浏览最近文档";
			case "get_document": return "读取文档";
			case "get_document_blocks": return "读取文档块";
			case "search_fulltext": return "全文搜索";
			case "search_documents": return "搜索文档";
			case "append_block": return "追加内容";
			case "edit_blocks": return "编辑块";
			case "create_document": return "新建文档";
			case "move_document": return "移动文档";
			case "rename_document": return "重命名文档";
			case "delete_document": return "删除文档";
			case "create_scheduled_task": return "创建定时任务";
			case "list_scheduled_tasks": return "列出定时任务";
			case "update_scheduled_task": return "更新定时任务";
			case "delete_scheduled_task": return "删除定时任务";
			default: return toolName;
		}
	}

	private getActionLabel(action: string): string {
		switch (action) {
			case "list": return "列表";
			case "read": return "读取";
			case "search": return "搜索";
			case "create": return "新建";
			case "append": return "追加";
			case "edit": return "编辑";
			case "move": return "移动";
			case "rename": return "重命名";
			case "delete": return "删除";
			default: return "其他";
		}
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
			.map(([action, count]) => `<span class="chat-msg__activity-chip">${this.escapeHtml(this.getActionLabel(action))} ${count}</span>`)
			.join("");
		const title = block.category === "change" ? `已更改 ${total} 项` : `已查找 ${total} 项`;
		summary.innerHTML = `<span class="chat-msg__activity-title">${this.escapeHtml(title)}</span>${chips}`;
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
		const category = this.getToolCategory(event.toolName || toolEl.dataset.toolName, event.payload);
		toolEl.dataset.toolCategory = category;
		toolEl.dataset.toolAction = this.getToolAction(event.toolName || toolEl.dataset.toolName, event.payload);

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
				meta: "已创建文档",
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
				meta: "已读取文档",
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
				meta: `已读取 ${event.payload.blockCount} 个块`,
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
				meta: `已追加 ${event.payload.blockIDs.length || 0} 个块`,
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
				meta: `已编辑 ${event.payload.editedCount} 个块`,
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

		const pre = document.createElement("pre");
		pre.className = "chat-msg__tool-result";
		pre.textContent = result.length > 500 ? result.slice(0, 500) + "..." : result;
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
		const docTitle = this.escapeHtml(options.label || options.path || docId || "文档");
		const meta = options.meta ? `<span class="chat-msg__doc-meta">${this.escapeHtml(options.meta)}</span>` : "";
		const canOpen = Boolean(docId) && options.open !== false;
		const contentHtml = docId
			? `<a class="${canOpen ? "chat-msg__doc-link chat-msg__doc-link--open" : "chat-msg__doc-link chat-msg__doc-link--muted"}" data-id="${this.escapeHtml(docId)}" href="javascript:void(0)">${docTitle}</a>${meta}`
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
		const resolvedCategory = category || this.getToolCategory(toolName);
		const badge = resolvedCategory === "change" ? "更改" : "查找";
		return `<span class="chat-msg__tool-prefix"><span class="chat-msg__tool-dot" aria-hidden="true"></span>${this.escapeHtml(badge)}</span><span class="chat-msg__tool-title">${this.escapeHtml(this.getToolDisplayTitle(toolName))}</span>${contentHtml}`;
	}

	private scrollToBottom(): void {
		if (this.autoScroll)
			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private setLoading(loading: boolean): void {
		this.textareaEl.disabled = loading;
		if (loading) {
			this.sendBtn.innerHTML = `<svg class="chat-panel__send-icon"><use xlink:href="#iconClose"></use></svg>Stop`;
			this.sendBtn.onclick = () => this.stop();
		} else {
			this.sendBtn.innerHTML = `<svg class="chat-panel__send-icon"><use xlink:href="#iconPlay"></use></svg>Send`;
			this.sendBtn.onclick = () => this.send();
		}
	}

	private escapeHtml(text: string): string {
		const div = document.createElement("div");
		div.textContent = text;
		return div.innerHTML;
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
		this.selectedTaskId = this.taskManager.listTaskEntries()[0]?.id || null;
		this.renderCurrentSession();
		await this.renderTasksView();
		await this.renderSettingsView();
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
			await this.renderTasksView();
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
			void this.renderTasksView();
		} else if (view === "settings") {
			void this.renderSettingsView();
		}
	}

	private formatDateTime(timestamp?: number): string {
		if (!timestamp) return "—";
		return new Date(timestamp).toLocaleString();
	}

	private formatTaskSchedule(task: ScheduledTaskMeta): string {
		if (task.scheduleType === "once") {
			return `一次性 · ${this.formatDateTime(task.triggerAt)}`;
		}
		return `循环 · ${task.cron || "未配置 cron"}`;
	}

	private taskStatusText(task: ScheduledTaskMeta): string {
		switch (task.lastRunStatus) {
			case "running": return "执行中";
			case "success": return "最近成功";
			case "error": return "最近失败";
			default: return task.enabled ? "待执行" : "已停用";
		}
	}

	private async renderTasksView(): Promise<void> {
		if (this.renderingTasks) return;
		this.renderingTasks = true;
		try {
			await this.renderTasksViewInner();
		} finally {
			this.renderingTasks = false;
		}
	}

	private async renderTasksViewInner(): Promise<void> {
		const entries = this.taskManager.listTaskEntries();
		const runningCount = entries.filter((entry) => entry.task?.lastRunStatus === "running").length;
		const errorCount = entries.filter((entry) => entry.task?.lastRunStatus === "error").length;
		this.tasksSummaryEl.innerHTML = `
<span class="chat-panel__tasks-stats">${entries.length} 个任务${runningCount ? ` / ${runningCount} 执行中` : ""}${errorCount ? ` / ${errorCount} 失败` : ""}</span>
<button class="chat-panel__task-create b3-button" type="button">新建任务</button>`;
		this.tasksSummaryEl.querySelector(".chat-panel__task-create")?.addEventListener("click", () => {
			void this.openTaskEditor();
		});

		if (!entries.length) {
			this.taskListEl.innerHTML = `<div class="chat-session-list__empty">暂无定时任务</div>`;
			this.taskDetailEl.innerHTML = `<div class="chat-session-list__empty">从这里创建你的第一个定时任务</div>`;
			this.selectedTaskId = null;
			return;
		}

		if (!this.selectedTaskId || !entries.some((entry) => entry.id === this.selectedTaskId)) {
			this.selectedTaskId = entries[0].id;
		}

		this.taskListEl.innerHTML = entries.map((entry) => {
			const task = entry.task!;
			const statusLabel = this.taskStatusText(task);
			const scheduleLabel = this.formatTaskSchedule(task);
			return `<button class="task-list-item${entry.id === this.selectedTaskId ? " task-list-item--active" : ""}" type="button" data-task-id="${entry.id}">
				<div class="task-list-item__title">${this.escapeHtml(task.title)}</div>
				<div class="task-list-item__meta">${this.escapeHtml(statusLabel)} · ${this.escapeHtml(scheduleLabel)}</div>
			</button>`;
		}).join("");
		this.taskListEl.querySelectorAll<HTMLElement>("[data-task-id]").forEach((item) => {
			item.addEventListener("click", () => {
				this.selectedTaskId = item.dataset.taskId || null;
				void this.renderTasksView();
			});
		});

		const selected = this.selectedTaskId ? await this.taskManager.getTaskSession(this.selectedTaskId) : null;
		if (!selected?.task) {
			this.taskDetailEl.innerHTML = `<div class="chat-session-list__empty">请选择一个定时任务</div>`;
			return;
		}

		const task = selected.task;

		/* Execution history: split into run groups */
		const messages = normalizeMessagesForDisplay(selected.state?.messages || []);
		const toolUIEvents = Array.isArray(selected.state?.toolUIEvents) ? selected.state.toolUIEvents as ToolUIEvent[] : [];
		const runGroups = groupTaskRuns(messages, toolUIEvents);
		const historyHtml = this.renderRunGroupsHtml(runGroups);

		/* Build detail view */
		const nextRunText = task.nextRunAt ? this.formatDateTime(task.nextRunAt) : "—";
		const lastErrorHtml = task.lastRunError
			? `<div class="task-detail__error">⚠ ${this.escapeHtml(task.lastRunError)}</div>`
			: "";

		this.taskDetailEl.innerHTML = `
<div class="task-detail">
	<div class="task-detail__header">
		<div class="task-detail__title-area">
			<h3>${this.escapeHtml(task.title)}</h3>
			<span class="task-detail__badge task-detail__badge--${task.lastRunStatus}">${this.escapeHtml(this.taskStatusText(task))}</span>
			<span class="task-detail__next-run">下次执行：${this.escapeHtml(nextRunText)}</span>
		</div>
		<div class="task-detail__actions">
			<span class="task-detail__action-btn block__icon block__icon--show b3-tooltips b3-tooltips__sw" aria-label="${task.enabled ? "停用" : "启用"}" data-action="toggle">
				<svg style="width:16px;height:16px"><use xlink:href="${task.enabled ? "#iconPause" : "#iconPlay"}"></use></svg>
			</span>
			<span class="task-detail__action-btn block__icon block__icon--show b3-tooltips b3-tooltips__sw" aria-label="编辑" data-action="edit">
				<svg style="width:16px;height:16px"><use xlink:href="#iconEdit"></use></svg>
			</span>
			<span class="task-detail__action-btn block__icon block__icon--show b3-tooltips b3-tooltips__sw" aria-label="删除" data-action="delete">
				<svg style="width:16px;height:16px"><use xlink:href="#iconTrashcan"></use></svg>
			</span>
		</div>
	</div>
	${lastErrorHtml}
	<div class="task-detail__meta-row">
		<span>调度：${this.escapeHtml(this.formatTaskSchedule(task))}</span>
		<span>时区：${this.escapeHtml(task.timezone)}</span>
		<span>累计 ${task.runCount} 次</span>
		${task.lastRunAt ? `<span>上次：${this.escapeHtml(this.formatDateTime(task.lastRunAt))}</span>` : ""}
	</div>
	<div class="task-detail__history">
		<div class="task-detail__section-title">执行历史</div>
		${historyHtml}
	</div>
	<details class="task-detail__prompt-section">
		<summary class="task-detail__section-title">任务指令</summary>
		<pre class="task-detail__prompt-body">${this.escapeHtml(task.prompt)}</pre>
	</details>
</div>`;

		this.taskDetailEl.querySelector<HTMLElement>("[data-action='toggle']")?.addEventListener("click", () => {
			void this.taskManager.setTaskEnabled(task.id, !task.enabled).catch((error) => showMessage(String(error)));
		});
		this.taskDetailEl.querySelector<HTMLElement>("[data-action='edit']")?.addEventListener("click", () => {
			void this.openTaskEditor(task);
		});
		this.taskDetailEl.querySelector<HTMLElement>("[data-action='delete']")?.addEventListener("click", () => {
			void this.taskManager.deleteTask(task.id).catch((error) => showMessage(String(error)));
		});
	}

	private renderRunGroupsHtml(groups: TaskRunGroup[]): string {
		if (!groups.length) {
			return `<div class="chat-session-list__empty">暂无执行记录</div>`;
		}
		const reversed = [...groups].reverse();
		return reversed.map((group, idx) => {
			const isLatest = idx === 0;
			const statusClass = group.status === "error" ? "task-run-card--error" : group.status === "success" ? "task-run-card--success" : "";
			const statusLabel = group.status === "error" ? "失败" : group.status === "success" ? "成功" : "";
			const timeLabel = group.runAt || "未知时间";

			const host = document.createElement("div");
			this.renderConversationMessages(group.messages, group.toolUIEvents, host);
			const bodyHtml = host.innerHTML || `<div class="chat-session-list__empty">无内容</div>`;

			return `<details class="task-run-card ${statusClass}" ${isLatest ? "open" : ""}>
				<summary class="task-run-card__header">
					<span class="task-run-card__time">${this.escapeHtml(timeLabel)}</span>
					${statusLabel ? `<span class="task-run-card__status">${this.escapeHtml(statusLabel)}</span>` : ""}
				</summary>
				<div class="task-run-card__body">${bodyHtml}</div>
			</details>`;
		}).join("");
	}

	private async renderSettingsView(): Promise<void> {
		const config = await this.getConfig();
		const guideDocLabel = config.guideDoc?.title || "未设置";
		const notebookLabel = config.defaultNotebook?.name || "未设置";
		this.settingsViewEl.innerHTML = `
<div class="settings-panel">
	<div class="settings-panel__header">
		<div>
			<h3>设置</h3>
			<p>常用模型与连接配置放在这里，复杂项仍可打开完整设置。</p>
		</div>
	</div>
	<form class="settings-panel__form">
		<div class="settings-panel__section">
			<div class="settings-panel__section-title">模型与连接</div>
			<label class="settings-panel__field">
				<span>API Base URL</span>
				<input class="b3-text-field" name="apiBaseURL" value="${this.escapeHtml(config.apiBaseURL || DEFAULT_CONFIG.apiBaseURL)}" placeholder="https://api.openai.com/v1" />
			</label>
			<label class="settings-panel__field">
				<span>API Key</span>
				<input class="b3-text-field" name="apiKey" type="password" value="${this.escapeHtml(config.apiKey || "")}" placeholder="sk-..." />
			</label>
			<label class="settings-panel__field">
				<span>Model</span>
				<input class="b3-text-field" name="model" value="${this.escapeHtml(config.model || DEFAULT_CONFIG.model)}" placeholder="gpt-4o" />
			</label>
			<label class="settings-panel__field">
				<span>自定义指令</span>
				<textarea class="b3-text-field" name="customInstructions" rows="5" placeholder="附加给 AI 的个性化指令">${this.escapeHtml(config.customInstructions || "")}</textarea>
			</label>
		</div>
		<div class="settings-panel__section">
			<div class="settings-panel__section-title">追踪</div>
			<label class="settings-panel__checkbox">
				<input type="checkbox" name="langSmithEnabled"${config.langSmithEnabled ? " checked" : ""} />
				<span>启用 LangSmith Tracing</span>
			</label>
			<label class="settings-panel__field">
				<span>LangSmith API Key</span>
				<input class="b3-text-field" name="langSmithApiKey" type="password" value="${this.escapeHtml(config.langSmithApiKey || "")}" placeholder="lsv2_..." />
			</label>
			<label class="settings-panel__field">
				<span>LangSmith Endpoint</span>
				<input class="b3-text-field" name="langSmithEndpoint" value="${this.escapeHtml(config.langSmithEndpoint || DEFAULT_CONFIG.langSmithEndpoint)}" placeholder="https://api.smith.langchain.com" />
			</label>
			<label class="settings-panel__field">
				<span>LangSmith Project</span>
				<input class="b3-text-field" name="langSmithProject" value="${this.escapeHtml(config.langSmithProject || DEFAULT_CONFIG.langSmithProject)}" placeholder="SiYuan-Agent" />
			</label>
		</div>
		<div class="settings-panel__section settings-panel__section--compact">
			<div class="settings-panel__section-title">知识库默认项</div>
			<div class="settings-panel__meta-grid">
				<div><span>用户指南文档</span><strong>${this.escapeHtml(guideDocLabel)}</strong></div>
				<div><span>默认工作笔记本</span><strong>${this.escapeHtml(notebookLabel)}</strong></div>
			</div>
		</div>
		<div class="settings-panel__actions">
			<button class="b3-button" type="submit">保存设置</button>
			<button class="b3-button b3-button--text" type="button" data-action="open-native-settings">更多设置</button>
		</div>
	</form>
</div>`;

		const form = this.settingsViewEl.querySelector<HTMLFormElement>(".settings-panel__form");
		form?.addEventListener("submit", (event) => {
			event.preventDefault();
			void this.saveSettingsForm(form);
		});
		this.settingsViewEl.querySelector<HTMLElement>("[data-action='open-native-settings']")?.addEventListener("click", () => {
			const pluginAny = this.plugin as Plugin & { openSetting?: () => void };
			pluginAny.openSetting?.();
		});
	}

	private async saveSettingsForm(form: HTMLFormElement): Promise<void> {
		const formData = new FormData(form);
		const currentConfig = await this.getConfig();
		const nextConfig: AgentConfig = {
			...currentConfig,
			apiBaseURL: String(formData.get("apiBaseURL") || "").trim() || DEFAULT_CONFIG.apiBaseURL,
			apiKey: String(formData.get("apiKey") || "").trim(),
			model: String(formData.get("model") || "").trim() || DEFAULT_CONFIG.model,
			customInstructions: String(formData.get("customInstructions") || ""),
			langSmithEnabled: formData.get("langSmithEnabled") === "on",
			langSmithApiKey: String(formData.get("langSmithApiKey") || "").trim(),
			langSmithEndpoint: String(formData.get("langSmithEndpoint") || "").trim() || DEFAULT_CONFIG.langSmithEndpoint,
			langSmithProject: String(formData.get("langSmithProject") || "").trim() || DEFAULT_CONFIG.langSmithProject,
		};
		this.plugin.data[CONFIG_STORAGE] = nextConfig;
		await this.plugin.saveData(CONFIG_STORAGE, nextConfig);
		showMessage("设置已保存");
	}

	private async openTaskEditor(task?: ScheduledTaskMeta): Promise<void> {
		const isEditing = Boolean(task);
		const scheduleType = task?.scheduleType || "recurring";
		this.taskDetailEl.innerHTML = `
<form class="task-editor">
	<label class="task-editor__field">
		<span>标题</span>
		<input class="b3-text-field" name="title" value="${this.escapeHtml(task?.title || "")}" required />
	</label>
	<label class="task-editor__field">
		<span>Prompt</span>
		<textarea class="b3-text-field" name="prompt" rows="6" required>${this.escapeHtml(task?.prompt || "")}</textarea>
	</label>
	<label class="task-editor__field">
		<span>类型</span>
		<select class="b3-select" name="scheduleType">
			<option value="recurring"${scheduleType === "recurring" ? " selected" : ""}>循环</option>
			<option value="once"${scheduleType === "once" ? " selected" : ""}>一次性</option>
		</select>
	</label>
	<label class="task-editor__field">
		<span>Cron</span>
		<input class="b3-text-field" name="cron" value="${this.escapeHtml(task?.cron || "")}" placeholder="0 18 * * *" />
	</label>
	<label class="task-editor__field">
		<span>触发时间</span>
		<input class="b3-text-field" name="triggerAt" value="${task?.triggerAt ? new Date(task.triggerAt).toISOString().slice(0, 16) : ""}" type="datetime-local" />
	</label>
	<label class="task-editor__field">
		<span>时区</span>
		<input class="b3-text-field" name="timezone" value="${this.escapeHtml(task?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)}" />
	</label>
	<label class="task-editor__checkbox">
		<input type="checkbox" name="enabled"${task?.enabled !== false ? " checked" : ""} />
		<span>启用</span>
	</label>
	<div class="task-editor__actions">
		<button class="b3-button" type="submit">${isEditing ? "保存" : "创建"}</button>
		<button class="b3-button b3-button--text" type="button" data-action="cancel">取消</button>
	</div>
</form>`;
		const form = this.taskDetailEl.querySelector<HTMLFormElement>(".task-editor");
		form?.addEventListener("submit", (event) => {
			event.preventDefault();
			const formData = new FormData(form);
			const nextScheduleType = formData.get("scheduleType") === "once" ? "once" : "recurring";
			const triggerAtValue = formData.get("triggerAt");
			const triggerAt = typeof triggerAtValue === "string" && triggerAtValue
				? new Date(triggerAtValue).getTime()
				: undefined;
			const payload = {
				title: String(formData.get("title") || "").trim(),
				prompt: String(formData.get("prompt") || "").trim(),
				scheduleType: nextScheduleType as "once" | "recurring",
				cron: String(formData.get("cron") || "").trim() || undefined,
				triggerAt,
				timezone: String(formData.get("timezone") || "").trim() || undefined,
				enabled: formData.get("enabled") === "on",
			};
			if (isEditing && task) {
				void this.taskManager.updateTask(task.id, payload).then(() => {
					this.selectedTaskId = task.id;
					return this.renderTasksView();
				}).catch((error) => showMessage(String(error)));
				return;
			}
			void this.taskManager.createTask(payload).then((session) => {
				this.selectedTaskId = session.id;
				return this.renderTasksView();
			}).catch((error) => showMessage(String(error)));
		});
		this.taskDetailEl.querySelector<HTMLElement>("[data-action='cancel']")?.addEventListener("click", () => {
			void this.renderTasksView();
		});
	}

	private async getConfig(): Promise<AgentConfig> {
		try {
			await this.plugin.loadData(CONFIG_STORAGE);
			const saved = this.plugin.data[CONFIG_STORAGE];
			if (saved)
				return { ...DEFAULT_CONFIG, ...saved };
		} catch {
			/* Use defaults */
		}
		return { ...DEFAULT_CONFIG };
	}

	/* --- Autocomplete --- */

	private async handleInput(e: Event): Promise<void> {
		const target = e.target as HTMLTextAreaElement;
		const cursor = target.selectionStart;
		const text = target.value;

		/* Slash commands: only when at start of input */
		const slashMatch = text.slice(0, cursor).match(/^(\/\S*)$/);
		if (slashMatch) {
			const prefix = slashMatch[1].toLowerCase();
			const matched = SLASH_COMMANDS.filter(c => c.name.startsWith(prefix));
			if (matched.length > 0) {
				this.completionRange = { start: 0, end: cursor };
				this.completionList = matched.map(c => ({ id: c.name, title: `${c.name}  —  ${c.description}` }));
				this.completionIdx = 0;
				this.showCompletion();
				return;
			}
		}

		const match = text.slice(0, cursor).match(/@([^\s@]*)$/);

		if (match) {
			const keyword = match[1];
			const start = match.index!;
			this.completionRange = { start, end: cursor };

			const docs = await this.queryDocs(keyword);
			if (docs.length > 0) {
				this.completionList = docs;
				this.completionIdx = 0;
				this.showCompletion();
			} else {
				this.hideCompletion();
			}
		} else {
			this.hideCompletion();
		}
	}

	private handleCompletionKey(e: KeyboardEvent): void {
		switch (e.key) {
			case "ArrowUp":
				e.preventDefault();
				this.completionIdx = (this.completionIdx - 1 + this.completionList.length) % this.completionList.length;
				this.renderCompletion();
				break;
			case "ArrowDown":
				e.preventDefault();
				this.completionIdx = (this.completionIdx + 1) % this.completionList.length;
				this.renderCompletion();
				break;
			case "Enter":
			case "Tab":
				e.preventDefault();
				this.insertCompletion();
				break;
			case "Escape":
				e.preventDefault();
				this.hideCompletion();
				break;
		}
	}

	private async queryDocs(keyword: string): Promise<{ id: string, title: string }[]> {
		const escaped = keyword.replace(/'/g, "''");
		const stmt = keyword
			? `SELECT * FROM blocks WHERE type='d' AND content LIKE '%${escaped}%' ORDER BY updated DESC LIMIT 8`
			: `SELECT * FROM blocks WHERE type='d' ORDER BY updated DESC LIMIT 8`;

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

	private showCompletion(): void {
		if (!this.completionEl) {
			this.completionEl = document.createElement("div");
			this.completionEl.className = "chat-panel__completion b3-menu fn__none";
			this.completionEl.style.position = "fixed";
			this.completionEl.style.zIndex = "200";
			this.completionEl.style.maxHeight = "200px";
			this.completionEl.style.overflowY = "auto";
			document.body.appendChild(this.completionEl);
		}

		const rect = this.textareaEl.getBoundingClientRect();
		this.completionEl.style.bottom = (window.innerHeight - rect.top + 5) + "px";
		this.completionEl.style.left = rect.left + "px";
		this.completionEl.style.width = rect.width + "px";

		this.completionEl.classList.remove("fn__none");
		this.renderCompletion();
	}

	private hideCompletion(): void {
		if (this.completionEl) {
			this.completionEl.classList.add("fn__none");
			this.completionEl.remove();
			this.completionEl = null;
		}
		this.completionList = [];
		this.completionRange = null;
	}

	private renderCompletion(): void {
		if (!this.completionEl) return;

		this.completionEl.innerHTML = this.completionList.map((item, idx) => `
			<div class="b3-menu__item${idx === this.completionIdx ? " b3-menu__item--current" : ""}" data-idx="${idx}">
				<span class="b3-menu__label">${this.escapeHtml(item.title)}</span>
			</div>
		`).join("");

		this.completionEl.querySelectorAll(".b3-menu__item").forEach(el => {
			el.addEventListener("click", () => {
				this.completionIdx = parseInt((el as HTMLElement).dataset.idx || "0");
				this.insertCompletion();
			});
		});
	}

	private insertCompletion(): void {
		if (!this.completionRange || !this.completionList[this.completionIdx]) return;

		const item = this.completionList[this.completionIdx];
		const text = this.textareaEl.value;
		const before = text.slice(0, this.completionRange.start);
		const after = text.slice(this.completionRange.end);

		/* Slash command: insert just the command name (no doc-ref syntax) */
		const isSlashCmd = SLASH_COMMANDS.some(c => c.name === item.id);
		const insertion = isSlashCmd ? item.id + " " : `((${item.id} "${item.title}")) `;

		this.textareaEl.value = before + insertion + after;
		this.textareaEl.selectionStart = this.textareaEl.selectionEnd = before.length + insertion.length;
		this.textareaEl.focus();

		this.hideCompletion();
	}
}
