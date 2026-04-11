/**
 * Autocomplete delegate for the chat panel composer.
 * Handles @-mention document lookup and slash command completion.
 */

import { SLASH_COMMANDS } from "../types";
import { escapeHtml } from "./chat-helpers";

export class Autocomplete {
	private textareaEl: HTMLTextAreaElement;
	private completionEl: HTMLElement | null = null;
	private completionIdx = 0;
	private completionList: { id: string; title: string }[] = [];
	private completionRange: { start: number; end: number } | null = null;

	constructor(textareaEl: HTMLTextAreaElement) {
		this.textareaEl = textareaEl;
	}

	get isActive(): boolean {
		return this.completionEl !== null && !this.completionEl.classList.contains("fn__none");
	}

	async handleInput(e: Event): Promise<void> {
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
				this.show();
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
				this.show();
			} else {
				this.hide();
			}
		} else {
			this.hide();
		}
	}

	handleKey(e: KeyboardEvent): void {
		switch (e.key) {
			case "ArrowUp":
				e.preventDefault();
				this.completionIdx = (this.completionIdx - 1 + this.completionList.length) % this.completionList.length;
				this.render();
				break;
			case "ArrowDown":
				e.preventDefault();
				this.completionIdx = (this.completionIdx + 1) % this.completionList.length;
				this.render();
				break;
			case "Enter":
			case "Tab":
				e.preventDefault();
				this.insertCompletion();
				break;
			case "Escape":
				e.preventDefault();
				this.hide();
				break;
		}
	}

	hide(): void {
		if (this.completionEl) {
			this.completionEl.classList.add("fn__none");
			this.completionEl.remove();
			this.completionEl = null;
		}
		this.completionList = [];
		this.completionRange = null;
	}

	private async queryDocs(keyword: string): Promise<{ id: string; title: string }[]> {
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

	private show(): void {
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
		this.render();
	}

	private render(): void {
		if (!this.completionEl) return;

		this.completionEl.innerHTML = this.completionList.map((item, idx) => `
			<div class="b3-menu__item${idx === this.completionIdx ? " b3-menu__item--current" : ""}" data-idx="${idx}">
				<span class="b3-menu__label">${escapeHtml(item.title)}</span>
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

		this.hide();
	}
}
