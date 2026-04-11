/**
 * Tasks view delegate – extracted from ChatPanel for maintainability.
 */
import { showMessage } from "siyuan";
import type { ScheduledTaskMeta, ToolUIEvent, UiMessage } from "../types";
import type { ScheduledTaskManager } from "../core/scheduled-task-manager";
import { escapeHtml, normalizeMessagesForDisplay } from "./chat-helpers";
import { groupTaskRuns, type TaskRunGroup } from "./task-run-group";

/* ── Context interface ───────────────────────────────────────────────── */

export interface TasksViewContext {
	tasksSummaryEl: HTMLElement;
	taskListEl: HTMLElement;
	taskDetailEl: HTMLElement;
	taskManager: ScheduledTaskManager;
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

	constructor(ctx: TasksViewContext) {
		this.ctx = ctx;
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
		<span>标题</span>
		<input class="b3-text-field" name="title" value="${escapeHtml(task?.title || "")}" required />
	</label>
	<label class="task-editor__field">
		<span>Prompt</span>
		<textarea class="b3-text-field" name="prompt" rows="6" required>${escapeHtml(task?.prompt || "")}</textarea>
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
		<input class="b3-text-field" name="cron" value="${escapeHtml(task?.cron || "")}" placeholder="0 18 * * *" />
	</label>
	<label class="task-editor__field">
		<span>触发时间</span>
		<input class="b3-text-field" name="triggerAt" value="${task?.triggerAt ? new Date(task.triggerAt).toISOString().slice(0, 16) : ""}" type="datetime-local" />
	</label>
	<label class="task-editor__field">
		<span>时区</span>
		<input class="b3-text-field" name="timezone" value="${escapeHtml(task?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)}" />
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
<span class="chat-panel__tasks-stats">${entries.length} 个任务${runningCount ? ` / ${runningCount} 执行中` : ""}${errorCount ? ` / ${errorCount} 失败` : ""}</span>
<button class="chat-panel__task-create b3-button" type="button">新建任务</button>`;
		tasksSummaryEl.querySelector(".chat-panel__task-create")?.addEventListener("click", () => {
			void this.openTaskEditor();
		});

		if (!entries.length) {
			taskListEl.innerHTML = "<div class=\"chat-session-list__empty\">暂无定时任务</div>";
			taskDetailEl.innerHTML = "<div class=\"chat-session-list__empty\">从这里创建你的第一个定时任务</div>";
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
			taskDetailEl.innerHTML = "<div class=\"chat-session-list__empty\">请选择一个定时任务</div>";
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
			<span class="task-detail__next-run">下次执行：${escapeHtml(nextRunText)}</span>
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
		<span>调度：${escapeHtml(this.formatTaskSchedule(task))}</span>
		<span>时区：${escapeHtml(task.timezone)}</span>
		<span>累计 ${task.runCount} 次</span>
		${task.lastRunAt ? `<span>上次：${escapeHtml(this.formatDateTime(task.lastRunAt))}</span>` : ""}
	</div>
	<details class="task-detail__prompt-section">
		<summary class="task-detail__section-title">任务指令</summary>
		<pre class="task-detail__prompt-body">${escapeHtml(task.prompt)}</pre>
	</details>
	<div class="task-detail__history">
		<div class="task-detail__section-title">执行历史</div>
		${historyHtml}
	</div>
</div>`;

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
			return "<div class=\"chat-session-list__empty\">暂无执行记录</div>";
		}
		const reversed = [...groups].reverse();
		return reversed.map((group, idx) => {
			const isLatest = idx === 0;
			const statusClass = group.status === "error" ? "task-run-card--error" : group.status === "success" ? "task-run-card--success" : "";
			const statusLabel = group.status === "error" ? "失败" : group.status === "success" ? "成功" : "";
			const timeLabel = group.runAt || "未知时间";

			const host = document.createElement("div");
			if (group.messagesUi.length > 0) {
				this.ctx.renderConversationMessagesUi(group.messagesUi, host);
			} else {
				this.ctx.renderConversationMessages(group.messages, group.toolUIEvents, host);
			}
			const bodyHtml = host.innerHTML || "<div class=\"chat-session-list__empty\">无内容</div>";

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
}
