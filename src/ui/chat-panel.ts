import { Plugin, showMessage, fetchPost } from "siyuan";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { AgentConfig, ChatMessage, ChatSession, ChatStore, DEFAULT_CONFIG } from "../types";
import { runAgent, AgentCallbacks } from "../core/agent";
import { renderMarkdown } from "./markdown";

const CHAT_STORAGE = "chat-history";
const CONFIG_STORAGE = "agent-config";

function genId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function makeSession(): ChatSession {
	const now = Date.now();
	return { id: genId(), title: "New Chat", created: now, updated: now, messages: [] };
}

function sessionTitle(session: ChatSession): string {
	const first = session.messages.find(m => m.role === "user");
	if (!first)
		return session.title;
	const text = first.content.replace(/^>.*\n\n/s, "").trim();
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

	private store: ChatStore;
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

	private get session(): ChatSession {
		return this.store.sessions.find(s => s.id === this.store.activeId)
			|| this.store.sessions[0];
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
			// Delay hiding to allow click event on completion item
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
			this.deleteSession(this.store.activeId);
		});
	}

	/* --- Session management --- */

	private toggleSessionList(): void {
		const hidden = this.sessionListEl.classList.toggle("fn__none");
		if (!hidden)
			this.renderSessionList();
	}

	private renderSessionList(): void {
		const sessions = this.store.sessions;
		if (!sessions.length) {
			this.sessionListEl.innerHTML = `<div class="chat-session-list__empty">No conversations</div>`;
			return;
		}

		const sorted = [...sessions].sort((a, b) => b.updated - a.updated);
		this.sessionListEl.innerHTML = sorted.map(s => {
			const active = s.id === this.store.activeId ? " chat-session-item--active" : "";
			const title = this.escapeHtml(sessionTitle(s));
			const date = new Date(s.updated).toLocaleDateString();
			const count = s.messages.filter(m => m.role === "user").length;
			return `<div class="chat-session-item${active}" data-id="${s.id}">
				<div class="chat-session-item__info">
					<span class="chat-session-item__title">${title}</span>
					<span class="chat-session-item__meta">${count} msgs · ${date}</span>
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
				if (id && id !== this.store.activeId)
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
		const s = makeSession();
		this.store.sessions.push(s);
		this.store.activeId = s.id;
		this.renderCurrentSession();
		this.saveStore();
		this.textareaEl.focus();
	}

	private switchSession(id: string): void {
		this.store.activeId = id;
		this.renderCurrentSession();
		this.saveStore();
		this.sessionListEl.classList.add("fn__none");
	}

	private deleteSession(id: string): void {
		const idx = this.store.sessions.findIndex(s => s.id === id);
		if (idx < 0)
			return;
		this.store.sessions.splice(idx, 1);

		/* If we deleted the active session, switch to another or create new */
		if (this.store.activeId === id) {
			if (this.store.sessions.length) {
				this.store.activeId = this.store.sessions[0].id;
			} else {
				const s = makeSession();
				this.store.sessions.push(s);
				this.store.activeId = s.id;
			}
		}

		this.renderCurrentSession();
		this.saveStore();

		if (!this.sessionListEl.classList.contains("fn__none"))
			this.renderSessionList();
	}

	private renderCurrentSession(): void {
		const s = this.session;
		/* Update header name */
		const nameEl = this.container.querySelector(".chat-panel__session-name");
		if (nameEl)
			nameEl.textContent = sessionTitle(s);

		/* Re-render messages */
		this.messagesEl.innerHTML = "";
		for (const msg of s.messages) {
			if (msg.role === "user" || msg.role === "assistant" || msg.role === "tool")
				this.appendMessageEl(msg);
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

		const s = this.session;

		/* Build user message with optional context */
		let content = "";
		if (this.pendingContext) {
			content = `> ${this.pendingContext.replace(/\n/g, "\n> ")}\n\n${text}`;
			this.clearContext();
		} else {
			content = text;
		}

		const userMsg: ChatMessage = {
			role: "user",
			content,
			timestamp: Date.now(),
		};
		s.messages.push(userMsg);
		this.appendMessageEl(userMsg);

		/* Update session title from first user message */
		s.updated = Date.now();
		const nameEl = this.container.querySelector(".chat-panel__session-name");
		if (nameEl)
			nameEl.textContent = sessionTitle(s);

		this.textareaEl.value = "";
		this.setLoading(true);

		/* Create assistant message element for streaming */
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

		const getTextEl = (): HTMLElement => {
			if (curTextEl)
				return curTextEl;
			curBuffer = "";
			curTextEl = document.createElement("div");
			curTextEl.className = "chat-msg__text";
			contentEl.appendChild(curTextEl);
			return curTextEl;
		};

		/* Build full conversation with system prompt */
		const systemMsg: ChatMessage = {
			role: "system",
			content: config.systemPrompt,
			timestamp: 0,
		};
		const conversation = [systemMsg, ...s.messages];

		let lastToolEl: HTMLElement | null = null;

		const callbacks: AgentCallbacks = {
			onContent: (chunk) => {
				const el = getTextEl();
				curBuffer += chunk;
				el.innerHTML = renderMarkdown(curBuffer);
				this.scrollToBottom();
			},
			onToolStart: (name, args) => {
				curTextEl = null;
				const el = document.createElement("div");
				el.className = "chat-msg__tool";
				el.innerHTML = `<details open><summary>🔧 ${this.escapeHtml(name)}</summary><pre>${this.escapeHtml(JSON.stringify(args, null, 2))}</pre></details>`;
				contentEl.appendChild(el);
				lastToolEl = el;
				this.scrollToBottom();
			},
			onToolEnd: (_name, result) => {
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
			},
			onDone: (finalContent) => {
				if (finalContent && finalContent !== curBuffer) {
					const el = getTextEl();
					curBuffer = finalContent;
					el.innerHTML = renderMarkdown(finalContent);
				}
			},
			onError: (err) => {
				if (this.abortCtrl?.signal.aborted)
					return;
				const el = getTextEl();
				el.innerHTML = `<p class="chat-msg__error">Error: ${this.escapeHtml(err.message)}</p>`;
			},
		};

		try {
			const result = await runAgent(
				conversation,
				config,
				this.tools,
				callbacks,
				this.abortCtrl.signal
			);

			/* Update session messages with the full history returned by agent (excluding system) */
			s.messages = result.messages.filter(m => m.role !== "system");
			s.updated = Date.now();
			this.saveStore();
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

	private appendMessageEl(msg: ChatMessage): void {
		const el = document.createElement("div");
		el.className = `chat-msg chat-msg--${msg.role}`;
		
		let contentHtml = "";
		
		if (msg.role === "tool") {
			/* Tool Result */
			contentHtml = `<div class="chat-msg__tool-result">
				<div class="chat-msg__tool-header">🔧 Result${msg.name ? `: ${this.escapeHtml(msg.name)}` : ""}</div>
				<pre style="max-height: 200px; overflow-y: auto;">${this.escapeHtml(msg.content)}</pre>
			</div>`;
		} else {
			/* User or Assistant */
			if (msg.content) {
				contentHtml += renderMarkdown(msg.content);
			}
			
			if (msg.tool_calls && msg.tool_calls.length) {
				for (const tc of msg.tool_calls) {
					contentHtml += `<div class="chat-msg__tool">
						<details>
							<summary>🔧 ${this.escapeHtml(tc.name)}</summary>
							<pre>${this.escapeHtml(JSON.stringify(tc.args, null, 2))}</pre>
						</details>
					</div>`;
				}
			}
		}

		el.innerHTML = `<div class="chat-msg__content">${contentHtml}</div>`;
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

	/* --- Persistence --- */

	private async loadStore(): Promise<void> {
		try {
			await this.plugin.loadData(CHAT_STORAGE);
			const data = this.plugin.data[CHAT_STORAGE];

			if (data && data.sessions) {
				/* New format */
				this.store = data as ChatStore;
			} else if (Array.isArray(data) && data.length) {
				/* Migrate old flat array to new format */
				const s = makeSession();
				s.messages = data;
				if (data.length)
					s.updated = data[data.length - 1].timestamp || s.created;
				this.store = { activeId: s.id, sessions: [s] };
			} else {
				const s = makeSession();
				this.store = { activeId: s.id, sessions: [s] };
			}
		} catch {
			const s = makeSession();
			this.store = { activeId: s.id, sessions: [s] };
		}

		this.renderCurrentSession();
	}

	private saveStore(): void {
		/* Strip system messages before persisting */
		const toSave: ChatStore = {
			activeId: this.store.activeId,
			sessions: this.store.sessions.map(s => ({
				...s,
				messages: s.messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "tool"),
			})),
		};
		this.plugin.saveData(CHAT_STORAGE, toSave);
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
		
		// Look for @ before cursor
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

		// Calculate position
		const rect = this.textareaEl.getBoundingClientRect();
		// Simple positioning above the textarea
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

		// Click handling
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
		
		// Insert SiYuan block ref format: ((id "title"))
		const insertion = `((${item.id} "${item.title}")) `;
		
		this.textareaEl.value = before + insertion + after;
		this.textareaEl.selectionStart = this.textareaEl.selectionEnd = before.length + insertion.length;
		this.textareaEl.focus();
		
		this.hideCompletion();
	}
}
