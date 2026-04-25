/**
 * Tasks view delegate – extracted from ChatPanel for maintainability.
 */
import { showMessage } from "siyuan";
import type { ScheduledTaskMeta, ToolUIEvent, UiMessage } from "../types";
import type { ScheduledTaskManager } from "../core/scheduled-task-manager";
import { escapeHtml, normalizeMessagesForDisplay } from "./chat-helpers";
import { groupTaskRuns, type TaskRunGroup } from "./task-run-group";
import { defaultTranslator, type Translator } from "../i18n";

/* ── Context interface ───────────────────────────────────────────────── */

export interface TasksViewContext {
	tasksSummaryEl: HTMLElement;
	taskListEl: HTMLElement;
	taskDetailEl: HTMLElement;
	taskManager: ScheduledTaskManager;
	i18n?: Translator;
	/** Render a set of conversation messages into the given container. */
	renderConversationMessages: (messages: any[], toolUIEvents: ToolUIEvent[], targetEl: HTMLElement) => void;
	/** Render UiMessage-based conversation into the given container. */
	renderConversationMessagesUi: (messagesUi: UiMessage[], targetEl: HTMLElement) => void;
}

/* ── TasksView class ─────────────────────────────────────────────────── */

export class TasksView {
	private ctx: TasksViewContext;
	selectedTaskId: string | null = null;
	private rendering = false;
	private i18n: Translator;

	constructor(ctx: TasksViewContext) {
		this.ctx = ctx;
		this.i18n = ctx.i18n || defaultTranslator;
	}

	private t(key: string, params?: Record<string, string | number | boolean | null | undefined>, fallback?: string): string {
		return this.i18n.t(key, params, fallback);
	}

	async render(): Promise<void> {
		if (this.rendering) return;
		this.rendering = true;
		try {
			await this.renderInner();
		} finally {
			this.rendering = false;
		}
	}

	async openTaskEditor(task?: ScheduledTaskMeta): Promise<void> {
		const isEditing = Boolean(task);
		const scheduleType = task?.scheduleType || "recurring";
		this.ctx.taskDetailEl.innerHTML = `
<form class="task-editor">
	<label class="task-editor__field">
		<span>${escapeHtml(this.t("tasks.editor.title"))}</span>
		<input class="b3-text-field" name="title" value="${escapeHtml(task?.title || "")}" required />
	</label>
	<label class="task-editor__field">
		<span>${escapeHtml(this.t("tasks.editor.prompt"))}</span>
		<textarea class="b3-text-field" name="prompt" rows="6" required>${escapeHtml(task?.prompt || "")}</textarea>
	</label>
	<label class="task-editor__field">
		<span>${escapeHtml(this.t("tasks.editor.type"))}</span>
		<select class="b3-select" name="scheduleType">
			<option value="recurring"${scheduleType === "recurring" ? " selected" : ""}>${escapeHtml(this.t("tasks.editor.recurring"))}</option>
			<option value="once"${scheduleType === "once" ? " selected" : ""}>${escapeHtml(this.t("tasks.editor.once"))}</option>
		</select>
	</label>
	<label class="task-editor__field">
		<span>Cron</span>
		<input class="b3-text-field" name="cron" value="${escapeHtml(task?.cron || "")}" placeholder="0 18 * * *" />
	</label>
	<label class="task-editor__field">
		<span>${escapeHtml(this.t("tasks.editor.triggerAt"))}</span>
		<input class="b3-text-field" name="triggerAt" value="${task?.triggerAt ? new Date(task.triggerAt).toISOString().slice(0, 16) : ""}" type="datetime-local" />
	</label>
	<label class="task-editor__field">
		<span>${escapeHtml(this.t("tasks.editor.timezone"))}</span>
		<input class="b3-text-field" name="timezone" value="${escapeHtml(task?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)}" />
	</label>
	<label class="task-editor__checkbox">
		<input type="checkbox" name="enabled"${task?.enabled !== false ? " checked" : ""} />
		<span>${escapeHtml(this.t("tasks.editor.enabled"))}</span>
	</label>
	<div class="task-editor__actions">
		<button class="b3-button" type="submit">${escapeHtml(isEditing ? this.t("common.save") : this.t("common.create"))}</button>
		<button class="b3-button b3-button--text" type="button" data-action="cancel">${escapeHtml(this.t("common.cancel"))}</button>
	</div>
</form>`;
		const form = this.ctx.taskDetailEl.querySelector<HTMLFormElement>(".task-editor");
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
				void this.ctx.taskManager.updateTask(task.id, payload).then(() => {
					this.selectedTaskId = task.id;
					return this.render();
				}).catch((error) => showMessage(String(error)));
				return;
			}
			void this.ctx.taskManager.createTask(payload).then((session) => {
				this.selectedTaskId = session.id;
				return this.render();
			}).catch((error) => showMessage(String(error)));
		});
		this.ctx.taskDetailEl.querySelector<HTMLElement>("[data-action='cancel']")?.addEventListener("click", () => {
			void this.render();
		});
	}

	/* ── Private ─────────────────────────────────────────────────────── */

	private async renderInner(): Promise<void> {
		const { tasksSummaryEl, taskListEl, taskDetailEl, taskManager } = this.ctx;
		const entries = taskManager.listTaskEntries();
		const runningCount = entries.filter((entry) => entry.task?.lastRunStatus === "running").length;
		const errorCount = entries.filter((entry) => entry.task?.lastRunStatus === "error").length;
		tasksSummaryEl.innerHTML = `
<span class="chat-panel__tasks-stats">${escapeHtml(this.t("tasks.summary.count", { count: entries.length }))}${runningCount ? escapeHtml(this.t("tasks.summary.running", { count: runningCount })) : ""}${errorCount ? escapeHtml(this.t("tasks.summary.errors", { count: errorCount })) : ""}</span>
<button class="chat-panel__task-create b3-button" type="button">${escapeHtml(this.t("tasks.create"))}</button>`;
		tasksSummaryEl.querySelector(".chat-panel__task-create")?.addEventListener("click", () => {
			void this.openTaskEditor();
		});

		if (!entries.length) {
			taskListEl.innerHTML = `<div class="chat-session-list__empty">${escapeHtml(this.t("tasks.empty.list"))}</div>`;
			taskDetailEl.innerHTML = `<div class="chat-session-list__empty">${escapeHtml(this.t("tasks.empty.detail"))}</div>`;
			this.selectedTaskId = null;
			return;
		}

		if (!this.selectedTaskId || !entries.some((entry) => entry.id === this.selectedTaskId)) {
			this.selectedTaskId = entries[0].id;
		}

		taskListEl.innerHTML = entries.map((entry) => {
			const task = entry.task!;
			const statusLabel = this.taskStatusText(task);
			const scheduleLabel = this.formatTaskSchedule(task);
			return `<button class="task-list-item${entry.id === this.selectedTaskId ? " task-list-item--active" : ""}" type="button" data-task-id="${entry.id}">
				<div class="task-list-item__title">${escapeHtml(task.title)}</div>
				<div class="task-list-item__meta">${escapeHtml(statusLabel)} · ${escapeHtml(scheduleLabel)}</div>
			</button>`;
		}).join("");
		taskListEl.querySelectorAll<HTMLElement>("[data-task-id]").forEach((item) => {
			item.addEventListener("click", () => {
				this.selectedTaskId = item.dataset.taskId || null;
				void this.render();
			});
		});

		const selected = this.selectedTaskId ? await taskManager.getTaskSession(this.selectedTaskId) : null;
		if (!selected?.task) {
			taskDetailEl.innerHTML = `<div class="chat-session-list__empty">${escapeHtml(this.t("tasks.empty.select"))}</div>`;
			return;
		}

		const task = selected.task;

		/* Execution history: split into run groups */
		const messages = normalizeMessagesForDisplay(selected.state?.messages || []);
		const toolUIEvents = Array.isArray(selected.state?.toolUIEvents) ? selected.state.toolUIEvents as ToolUIEvent[] : [];
		const messagesUi = Array.isArray(selected.state?.messagesUi) ? selected.state.messagesUi as UiMessage[] : [];
		const runGroups = groupTaskRuns(messages, toolUIEvents, messagesUi);
		const historyHtml = this.renderRunGroupsHtml(runGroups);

		/* Build detail view */
		const nextRunText = task.nextRunAt ? this.formatDateTime(task.nextRunAt) : "—";
		const lastErrorHtml = task.lastRunError
			? `<div class="task-detail__error">⚠ ${escapeHtml(task.lastRunError)}</div>`
			: "";

		taskDetailEl.innerHTML = `
<div class="task-detail">
	<div class="task-detail__header">
		<div class="task-detail__title-area">
			<h3>${escapeHtml(task.title)}</h3>
			<span class="task-detail__badge task-detail__badge--${task.lastRunStatus}">${escapeHtml(this.taskStatusText(task))}</span>
			<span class="task-detail__next-run">${escapeHtml(this.t("tasks.nextRun", { time: nextRunText }))}</span>
		</div>
		<div class="task-detail__actions">
			<span class="task-detail__action-btn block__icon block__icon--show b3-tooltips b3-tooltips__sw" aria-label="${escapeHtml(this.t("tasks.runNow"))}" data-action="run-now">
				<svg style="width:16px;height:16px"><use xlink:href="#iconPlay"></use></svg>
			</span>
			<span class="task-detail__action-btn block__icon block__icon--show b3-tooltips b3-tooltips__sw" aria-label="${escapeHtml(task.enabled ? this.t("common.disable") : this.t("common.enable"))}" data-action="toggle">
				<svg style="width:16px;height:16px"><use xlink:href="${task.enabled ? "#iconPause" : "#iconPlay"}"></use></svg>
			</span>
			<span class="task-detail__action-btn block__icon block__icon--show b3-tooltips b3-tooltips__sw" aria-label="${escapeHtml(this.t("common.edit"))}" data-action="edit">
				<svg style="width:16px;height:16px"><use xlink:href="#iconEdit"></use></svg>
			</span>
			<span class="task-detail__action-btn block__icon block__icon--show b3-tooltips b3-tooltips__sw" aria-label="${escapeHtml(this.t("common.delete"))}" data-action="delete">
				<svg style="width:16px;height:16px"><use xlink:href="#iconTrashcan"></use></svg>
			</span>
		</div>
	</div>
	${lastErrorHtml}
	<div class="task-detail__meta-row">
		<span>${escapeHtml(this.t("tasks.schedule", { schedule: this.formatTaskSchedule(task) }))}</span>
		<span>${escapeHtml(this.t("tasks.timezone", { timezone: task.timezone }))}</span>
		<span>${escapeHtml(this.t("tasks.runCount", { count: task.runCount }))}</span>
		${task.lastRunAt ? `<span>${escapeHtml(this.t("tasks.lastRun", { time: this.formatDateTime(task.lastRunAt) }))}</span>` : ""}
	</div>
	<details class="task-detail__prompt-section">
		<summary class="task-detail__section-title">${escapeHtml(this.t("tasks.promptTitle"))}</summary>
		<pre class="task-detail__prompt-body">${escapeHtml(task.prompt)}</pre>
	</details>
	<div class="task-detail__history">
		<div class="task-detail__section-title">${escapeHtml(this.t("tasks.historyTitle"))}</div>
		${historyHtml}
	</div>
</div>`;

		taskDetailEl.querySelector<HTMLElement>("[data-action='run-now']")?.addEventListener("click", () => {
			void taskManager.runTaskNow(task.id).then(() => this.render()).catch((error) => showMessage(String(error)));
		});
		taskDetailEl.querySelector<HTMLElement>("[data-action='toggle']")?.addEventListener("click", () => {
			void taskManager.setTaskEnabled(task.id, !task.enabled).catch((error) => showMessage(String(error)));
		});
		taskDetailEl.querySelector<HTMLElement>("[data-action='edit']")?.addEventListener("click", () => {
			void this.openTaskEditor(task);
		});
		taskDetailEl.querySelector<HTMLElement>("[data-action='delete']")?.addEventListener("click", () => {
			void taskManager.deleteTask(task.id).catch((error) => showMessage(String(error)));
		});
	}

	private renderRunGroupsHtml(groups: TaskRunGroup[]): string {
		if (!groups.length) {
			return `<div class="chat-session-list__empty">${escapeHtml(this.t("tasks.history.empty"))}</div>`;
		}
		const reversed = [...groups].reverse();
		return reversed.map((group, idx) => {
			const isLatest = idx === 0;
			const statusClass = group.status === "error" ? "task-run-card--error" : group.status === "success" ? "task-run-card--success" : "";
			const statusLabel = group.status === "error" ? this.t("tasks.history.status.error") : group.status === "success" ? this.t("tasks.history.status.success") : "";
			const timeLabel = group.runAt || this.t("common.unknownTime");

			const host = document.createElement("div");
			if (group.messagesUi.length > 0) {
				this.ctx.renderConversationMessagesUi(group.messagesUi, host);
			} else {
				this.ctx.renderConversationMessages(group.messages, group.toolUIEvents, host);
			}
			const bodyHtml = host.innerHTML || `<div class="chat-session-list__empty">${escapeHtml(this.t("common.noContent"))}</div>`;

			return `<details class="task-run-card ${statusClass}" ${isLatest ? "open" : ""}>
				<summary class="task-run-card__header">
					<span class="task-run-card__time">${escapeHtml(timeLabel)}</span>
					${statusLabel ? `<span class="task-run-card__status">${escapeHtml(statusLabel)}</span>` : ""}
				</summary>
				<div class="task-run-card__body">${bodyHtml}</div>
			</details>`;
		}).join("");
	}

	private formatDateTime(timestamp?: number): string {
		if (!timestamp) return "—";
		return new Date(timestamp).toLocaleString();
	}

	private formatTaskSchedule(task: ScheduledTaskMeta): string {
		if (task.scheduleType === "once") {
			return this.t("tasks.schedule.once", { time: this.formatDateTime(task.triggerAt) });
		}
		return this.t("tasks.schedule.recurring", { cron: task.cron || this.t("tasks.schedule.noCron") });
	}

	private taskStatusText(task: ScheduledTaskMeta): string {
		switch (task.lastRunStatus) {
			case "running": return this.t("tasks.status.running");
			case "success": return this.t("tasks.status.success");
			case "error": return this.t("tasks.status.error");
			default: return task.enabled ? this.t("tasks.status.idle") : this.t("tasks.status.disabled");
		}
	}
}
