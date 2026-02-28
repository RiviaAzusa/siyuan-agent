import { Plugin, showMessage, fetchPost } from "siyuan";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
	HumanMessage, AIMessage, SystemMessage, ToolMessage,
	type BaseMessage,
} from "@langchain/core/messages";
import { AgentConfig, AgentState, SessionData, SessionIndex, DEFAULT_CONFIG } from "../types";
import { makeAgent, makeTracer } from "../core/agent";
import { renderMarkdown } from "./markdown";

// ─── Message serialisation helpers ───────────────────────────────────────────

/**
 * LangChain JS serialises messages as:
 *   { lc:1, type:"constructor", id:[...path, ClassName], kwargs:{...} }
 * This function restores such a dict back to a BaseMessage instance.
 * Also handles the legacy plain-object format { type: "human"|"ai"|..., content, ... }.
 */
function messageFromDict(raw: Record<string, any>): BaseMessage {
	if (raw.lc === 1 && raw.type === "constructor" && Array.isArray(raw.id)) {
		const className = raw.id[raw.id.length - 1] as string;
		const kwargs = raw.kwargs ?? {};
		if (className === "HumanMessage")   return new HumanMessage(kwargs);
		if (className === "AIMessage")      return new AIMessage(kwargs);
		if (className === "AIMessageChunk") return new AIMessage(kwargs);
		if (className === "SystemMessage")  return new SystemMessage(kwargs);
		if (className === "ToolMessage")    return new ToolMessage({ tool_call_id: "", ...kwargs });
		throw new Error(`Unknown LangChain message class: ${className}`);
	}
	// Legacy plain-object: { type: "human"|"ai"|"system"|"tool", content, ... }
	const { type, ...rest } = raw;
	if (type === "human" || type === "user") return new HumanMessage(rest);
	if (type === "ai" || type === "assistant") return new AIMessage(rest);
	if (type === "system") return new SystemMessage(rest);
	if (type === "tool")   return new ToolMessage({ tool_call_id: "", ...rest });
	throw new Error(`Unknown message type: ${type}`);
}

/** Deserialise an array of raw message dicts to BaseMessage instances. */
function messagesFromDict(messages: Record<string, any>[]): BaseMessage[] {
	return messages.map(messageFromDict);
}

/**
 * Merge existing saved state with an optional new user message string.
 * Mirrors Python-side _merge_state; returned object can be passed directly
 * to agent.invoke() / agent.stream().
 */
function mergeState(
	savedState: Record<string, any> | null,
	inputMsgStr?: string,
): { messages: BaseMessage[] } {
	let messages: BaseMessage[] = [];
	if (savedState?.messages && Array.isArray(savedState.messages)) {
		messages = messagesFromDict(savedState.messages);
	}
	if (inputMsgStr) {
		messages.push(new HumanMessage({ content: inputMsgStr }));
	}
	return { messages };
}

const INDEX_STORAGE = "chat-sessions-index";
const SESSION_PREFIX = "chat-session-";
const CONFIG_STORAGE = "agent-config";

function genId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function makeSessionData(): SessionData {
	const now = Date.now();
	return { id: genId(), title: "New Chat", created: now, updated: now, state: {} };
}

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

function sessionTitle(session: SessionData): string {
	const msgs = session.state?.messages || [];
	const first = msgs.find((m: any) => {
		const t = msgType(m);
		return t === "human" || t === "user";
	});
	if (!first) return session.title;
	// Content may be in kwargs.content (serialised) or directly in .content
	const rawContent = first.kwargs?.content ?? first.content;
	const text = (typeof rawContent === "string" ? rawContent : "").replace(/^>.*\n\n/s, "").trim();
	return text.length > 30 ? text.slice(0, 30) + "..." : text;
}

export class ChatPanel {
	private container: HTMLElement;
	private plugin: Plugin;
	private tools: StructuredToolInterface[];

	private sessionListEl: HTMLElement;
	private messagesEl: HTMLElement;
	private textareaEl: HTMLTextAreaElement;
	private sendBtn: HTMLElement;
	private contextBar: HTMLElement;

	private sessionIndex: SessionIndex;
	private activeSession: SessionData;
	private pendingContext: string | null = null;
	private abortCtrl: AbortController | null = null;
	private autoScroll = true;

	/* Autocomplete */
	private completionEl: HTMLElement | null = null;
	private completionIdx = 0;
	private completionList: { id: string, title: string }[] = [];
	private completionRange: { start: number, end: number } | null = null;

	constructor(element: HTMLElement, plugin: Plugin, tools: StructuredToolInterface[]) {
		this.container = element;
		this.plugin = plugin;
		this.tools = tools;
		this.render();
		this.loadStore();
	}

	private render(): void {
		this.container.innerHTML = `
<div class="chat-panel fn__flex-column" style="height:100%">
	<div class="chat-panel__session-bar">
		<button class="chat-panel__session-toggle b3-button b3-button--text">
			<svg style="width:14px;height:14px;margin-right:4px"><use xlink:href="#iconHistory"></use></svg>
			<span class="chat-panel__session-name">New Chat</span>
			<svg style="width:10px;height:10px;margin-left:4px"><use xlink:href="#iconDown"></use></svg>
		</button>
		<span class="fn__flex-1"></span>
		<span class="chat-panel__new-session block__icon b3-tooltips b3-tooltips__sw" aria-label="New Chat">
			<svg style="width:16px;height:16px"><use xlink:href="#iconAdd"></use></svg>
		</span>
		<span class="chat-panel__clear block__icon b3-tooltips b3-tooltips__sw" aria-label="Clear">
			<svg style="width:16px;height:16px"><use xlink:href="#iconTrashcan"></use></svg>
		</span>
	</div>
	<div class="chat-panel__session-list fn__none"></div>
	<div class="chat-panel__context-bar fn__none"></div>
	<div class="chat-panel__messages fn__flex-1"></div>
	<div class="chat-panel__input">
		<textarea class="chat-panel__textarea b3-text-field" rows="3" placeholder="Ask anything..."></textarea>
		<div class="chat-panel__actions">
			<button class="chat-panel__send b3-button b3-button--text">
				<svg class="chat-panel__send-icon"><use xlink:href="#iconPlay"></use></svg>
				Send
			</button>
		</div>
	</div>
</div>`;

		this.sessionListEl = this.container.querySelector(".chat-panel__session-list");
		this.messagesEl = this.container.querySelector(".chat-panel__messages");
		this.textareaEl = this.container.querySelector(".chat-panel__textarea");
		this.sendBtn = this.container.querySelector(".chat-panel__send");
		this.contextBar = this.container.querySelector(".chat-panel__context-bar");

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
		this.container.querySelector(".chat-panel__session-toggle").addEventListener("click", () => {
			this.toggleSessionList();
		});

		/* New session */
		this.container.querySelector(".chat-panel__new-session").addEventListener("click", () => {
			this.newSession();
		});

		/* Delete current session */
		this.container.querySelector(".chat-panel__clear").addEventListener("click", () => {
			this.deleteSession(this.sessionIndex.activeId);
		});
	}

	/* --- Session management --- */

	private toggleSessionList(): void {
		const hidden = this.sessionListEl.classList.toggle("fn__none");
		if (!hidden)
			this.renderSessionList();
	}

	private renderSessionList(): void {
		const sessions = this.sessionIndex.sessions;
		if (!sessions.length) {
			this.sessionListEl.innerHTML = `<div class="chat-session-list__empty">No conversations</div>`;
			return;
		}

		const sorted = [...sessions].sort((a, b) => b.updated - a.updated);
		this.sessionListEl.innerHTML = sorted.map(s => {
			const active = s.id === this.sessionIndex.activeId ? " chat-session-item--active" : "";
			const title = this.escapeHtml(s.title);
			const date = new Date(s.updated).toLocaleDateString();
			return `<div class="chat-session-item${active}" data-id="${s.id}">
				<div class="chat-session-item__info">
					<span class="chat-session-item__title">${title}</span>
					<span class="chat-session-item__meta">${date}</span>
				</div>
				<span class="chat-session-item__delete block__icon b3-tooltips b3-tooltips__sw" aria-label="Delete" data-delete="${s.id}">
					<svg><use xlink:href="#iconTrashcan"></use></svg>
				</span>
			</div>`;
		}).join("");

		/* Click to switch */
		this.sessionListEl.querySelectorAll(".chat-session-item").forEach(el => {
			el.addEventListener("click", (e) => {
				const target = e.target as HTMLElement;
				if (target.closest("[data-delete]"))
					return;
				const id = (el as HTMLElement).dataset.id;
				if (id && id !== this.sessionIndex.activeId)
					this.switchSession(id);
			});
		});

		/* Click to delete */
		this.sessionListEl.querySelectorAll("[data-delete]").forEach(el => {
			el.addEventListener("click", (e) => {
				e.stopPropagation();
				const id = (el as HTMLElement).dataset.delete;
				if (id)
					this.deleteSession(id);
			});
		});
	}

	private newSession(): void {
		// If the current session is already empty, just focus the input
		const msgs = this.activeSession?.state?.messages;
		if (!msgs || msgs.length === 0) {
			this.textareaEl.focus();
			return;
		}
		const s = makeSessionData();
		this.sessionIndex.sessions.push({
			id: s.id, title: s.title, created: s.created, updated: s.updated,
		});
		this.sessionIndex.activeId = s.id;
		this.activeSession = s;
		this.renderCurrentSession();
		this.saveIndex();
		this.saveSession(s);
		this.textareaEl.focus();
	}

	private async switchSession(id: string): Promise<void> {
		this.sessionIndex.activeId = id;
		this.activeSession = await this.loadSession(id);
		this.renderCurrentSession();
		this.saveIndex();
		this.sessionListEl.classList.add("fn__none");
	}

	private deleteSession(id: string): void {
		const idx = this.sessionIndex.sessions.findIndex(s => s.id === id);
		if (idx < 0) return;
		this.sessionIndex.sessions.splice(idx, 1);

		if (this.sessionIndex.activeId === id) {
			if (this.sessionIndex.sessions.length) {
				this.sessionIndex.activeId = this.sessionIndex.sessions[0].id;
				this.loadSession(this.sessionIndex.activeId).then(s => {
					this.activeSession = s;
					this.renderCurrentSession();
				});
			} else {
				const s = makeSessionData();
				this.sessionIndex.sessions.push({
					id: s.id, title: s.title, created: s.created, updated: s.updated,
				});
				this.sessionIndex.activeId = s.id;
				this.activeSession = s;
				this.renderCurrentSession();
				this.saveSession(s);
			}
		}

		this.saveIndex();
		// TODO: could also delete the session file from storage

		if (!this.sessionListEl.classList.contains("fn__none"))
			this.renderSessionList();
	}

	private renderCurrentSession(): void {
		const s = this.activeSession;
		/* Update header name */
		const nameEl = this.container.querySelector(".chat-panel__session-name");
		if (nameEl)
			nameEl.textContent = sessionTitle(s);

		/* Re-render messages from state */
		this.messagesEl.innerHTML = "";
		const messages = s.state?.messages || [];
		for (const msg of messages) {
			const type = msgType(msg);
			// Content / tool_calls may live in kwargs (serialised) or directly on the object
			const content = msg.kwargs?.content ?? msg.content;
			const toolCalls = msg.kwargs?.tool_calls ?? msg.tool_calls;
			const toolName  = msg.kwargs?.name ?? msg.name;
			if (type === "human" || type === "user")
				this.appendStaticMessage("user", typeof content === "string" ? content : JSON.stringify(content));
			else if (type === "ai")
				this.appendStaticMessage("assistant", typeof content === "string" ? content : "", toolCalls);
			else if (type === "tool")
				this.appendStaticMessage("tool", typeof content === "string" ? content : JSON.stringify(content), null, toolName);
		}
	}

	/* --- Send --- */

	private async send(): Promise<void> {
		const text = this.textareaEl.value.trim();
		if (!text && !this.pendingContext)
			return;

		const config = await this.getConfig();
		if (!config.apiKey) {
			showMessage("Please configure API Key in plugin settings first.");
			return;
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
		this.appendStaticMessage("user", content);

		/* Update session title from first user message */
		const s = this.activeSession;
		s.updated = Date.now();
		const nameEl = this.container.querySelector(".chat-panel__session-name");
		if (nameEl) nameEl.textContent = sessionTitle(s);

		this.textareaEl.value = "";
		this.setLoading(true);

		/* Create assistant message container for streaming */
		const assistantEl = document.createElement("div");
		assistantEl.className = "chat-msg chat-msg--assistant";
		const contentEl = document.createElement("div");
		contentEl.className = "chat-msg__content";
		assistantEl.appendChild(contentEl);
		this.messagesEl.appendChild(assistantEl);
		this.scrollToBottom();

		this.abortCtrl = new AbortController();

		let curTextEl: HTMLElement | null = null;
		let curBuffer = "";
		let lastToolEl: HTMLElement | null = null;

		const getTextEl = (): HTMLElement => {
			if (curTextEl) return curTextEl;
			curBuffer = "";
			curTextEl = document.createElement("div");
			curTextEl.className = "chat-msg__text";
			contentEl.appendChild(curTextEl);
			return curTextEl;
		};

		try {
			const agent = makeAgent(config, this.tools);
			const tracer = makeTracer(config);

			/* Build input: deserialise saved state + append new human message */
			const input = mergeState(s.state ?? null, content) as any;

			const streamOpts: any = {
				streamMode: ["messages", "values", "custom"],
			};
			if (tracer) streamOpts.callbacks = [tracer];
			if (this.abortCtrl) streamOpts.signal = this.abortCtrl.signal;

			const stream = await agent.stream(input, streamOpts);

			let latestState: AgentState = {};

			for await (const [streamType, data] of stream) {
				if (streamType === "messages") {
					const [message, _metadata] = data as [any, any];
					const msgType = message._getType?.() || message.constructor?.name || "";

					if (msgType === "ai" || msgType === "AIMessageChunk") {
						/* Streaming AI text */
						const textContent = typeof message.content === "string" ? message.content : "";
						if (textContent) {
							const el = getTextEl();
							curBuffer += textContent;
							el.innerHTML = renderMarkdown(curBuffer);
							this.scrollToBottom();
						}

						/* Detect tool call start from tool_call_chunks */
						const chunks = message.tool_call_chunks || [];
						for (const tc of chunks) {
							if (tc.name) {
								curTextEl = null;
								const el = document.createElement("div");
								el.className = "chat-msg__tool";
								el.innerHTML = `<details open><summary>🔧 ${this.escapeHtml(tc.name)}</summary></details>`;
								contentEl.appendChild(el);
								lastToolEl = el;
								this.scrollToBottom();
							}
						}
					} else if (msgType === "tool" || msgType === "ToolMessage") {
						/* Tool result */
						const result = typeof message.content === "string"
							? message.content : JSON.stringify(message.content);
						if (lastToolEl) {
							const details = lastToolEl.querySelector("details");
							if (details) {
								const pre = document.createElement("pre");
								pre.className = "chat-msg__tool-result";
								pre.textContent = result.length > 500 ? result.slice(0, 500) + "..." : result;
								details.appendChild(pre);
							}
							lastToolEl = null;
						}
						curTextEl = null;
						this.scrollToBottom();
					}
				} else if (streamType === "values") {
					latestState = data;
				} else if (streamType === "custom") {
					console.log("[tool-progress]", data);
				}
			}

			/* Persist the complete agent state */
			s.state = latestState;
			s.updated = Date.now();
			/* Update title in index */
			const indexEntry = this.sessionIndex.sessions.find(e => e.id === s.id);
			if (indexEntry) {
				indexEntry.title = sessionTitle(s);
				indexEntry.updated = s.updated;
			}
			this.saveIndex();
			this.saveSession(s);
		} catch (err) {
			if (!this.abortCtrl?.signal.aborted) {
				const el = getTextEl();
				el.innerHTML = `<p class="chat-msg__error">Error: ${this.escapeHtml(String(err))}</p>`;
			}
		} finally {
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
	}

	/* --- DOM helpers --- */

	private appendStaticMessage(
		role: string,
		content: string,
		toolCalls?: any[] | null,
		toolName?: string,
	): void {
		const el = document.createElement("div");
		el.className = `chat-msg chat-msg--${role}`;

		let html = "";

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
					html += `<div class="chat-msg__tool">
						<details>
							<summary>🔧 ${this.escapeHtml(tc.name)}</summary>
							<pre>${this.escapeHtml(JSON.stringify(tc.args, null, 2))}</pre>
						</details>
					</div>`;
				}
			}
		}

		el.innerHTML = `<div class="chat-msg__content">${html}</div>`;
		this.messagesEl.appendChild(el);
		this.scrollToBottom();
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
		try {
			await this.plugin.loadData(INDEX_STORAGE);
			const index = this.plugin.data[INDEX_STORAGE];

			if (index && index.sessions) {
				this.sessionIndex = index as SessionIndex;
				this.activeSession = await this.loadSession(this.sessionIndex.activeId);
			} else {
				/* Try migrating old format */
				await this.plugin.loadData("chat-history");
				const old = this.plugin.data["chat-history"];

				if (old && old.sessions && old.sessions.length) {
					/* Migrate old ChatStore to new per-session format */
					const entries: SessionIndex["sessions"] = [];
					for (const s of old.sessions) {
						const data: SessionData = {
							id: s.id,
							title: s.title || "New Chat",
							created: s.created || Date.now(),
							updated: s.updated || Date.now(),
							state: {
								messages: (s.messages || []).map((m: any) => ({
									role: m.role === "user" ? "human" : m.role,
									content: m.content,
								})),
							},
						};
						entries.push({ id: data.id, title: data.title, created: data.created, updated: data.updated });
						await this.plugin.saveData(SESSION_PREFIX + data.id, data);
					}
					this.sessionIndex = { activeId: old.activeId || entries[0].id, sessions: entries };
					this.saveIndex();
					this.activeSession = await this.loadSession(this.sessionIndex.activeId);
				} else {
					/* Fresh start */
					const s = makeSessionData();
					this.sessionIndex = {
						activeId: s.id,
						sessions: [{ id: s.id, title: s.title, created: s.created, updated: s.updated }],
					};
					this.activeSession = s;
					this.saveIndex();
					this.saveSession(s);
				}
			}
		} catch {
			const s = makeSessionData();
			this.sessionIndex = {
				activeId: s.id,
				sessions: [{ id: s.id, title: s.title, created: s.created, updated: s.updated }],
			};
			this.activeSession = s;
			this.saveIndex();
			this.saveSession(s);
		}

		this.renderCurrentSession();
	}

	private saveIndex(): void {
		this.plugin.saveData(INDEX_STORAGE, this.sessionIndex);
	}

	private saveSession(session: SessionData): void {
		this.plugin.saveData(SESSION_PREFIX + session.id, session);
	}

	private async loadSession(id: string): Promise<SessionData> {
		const key = SESSION_PREFIX + id;
		await this.plugin.loadData(key);
		return this.plugin.data[key] || makeSessionData();
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
		const stmt = keyword
			? `SELECT * FROM blocks WHERE type='d' AND content LIKE '%${keyword}%' ORDER BY updated DESC LIMIT 8`
			: `SELECT * FROM blocks WHERE type='d' ORDER BY updated DESC LIMIT 8`;

		return new Promise((resolve) => {
			fetchPost("/api/query/sql", { stmt }, (resp: any) => {
				if (resp.code === 0) {
					resolve(resp.data.map((d: any) => ({
						id: d.id,
						title: d.content
					})));
				} else {
					resolve([]);
				}
			});
		});
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

		const insertion = `((${item.id} "${item.title}")) `;

		this.textareaEl.value = before + insertion + after;
		this.textareaEl.selectionStart = this.textareaEl.selectionEnd = before.length + insertion.length;
		this.textareaEl.focus();

		this.hideCompletion();
	}
}
