import { createTool } from "../tool-types";
import { z } from "zod";
import type { ScheduledTaskManager } from "../scheduled-task-manager";
import { defaultTranslator, type Translator } from "../../i18n";

export function createScheduledTaskTools(
	getTaskManager: () => ScheduledTaskManager | null,
	i18n: Translator = defaultTranslator,
) {
	const requireTaskManager = (): ScheduledTaskManager => {
		const manager = getTaskManager();
		if (!manager) {
			throw new Error(i18n.t("scheduled.error.managerNotReady"));
		}
		return manager;
	};

	const createScheduledTaskTool = createTool({
		name: "create_scheduled_task",
		category: "change",
		description: "Create a scheduled task for future execution. Use this when the user asks for a daily/weekly/one-time reminder, summary, or recurring automation.",
		parameters: z.object({
			title: z.string().min(1).describe("Short task title shown in the task board"),
			prompt: z.string().min(1).describe("The prompt that should be sent to the agent when the task runs"),
			scheduleType: z.enum(["once", "recurring"]).describe("Whether the task runs once or repeatedly"),
			cron: z.string().optional().describe("Cron expression for recurring tasks"),
			triggerAt: z.number().optional().describe("Unix timestamp in milliseconds for one-time tasks"),
			timezone: z.string().optional().describe("IANA timezone name, e.g. Asia/Shanghai"),
			enabled: z.boolean().optional().describe("Whether the task should start enabled. Defaults to true."),
		}),
		async execute({ title, prompt, scheduleType, cron, triggerAt, timezone, enabled }) {
			const session = await requireTaskManager().createTask({
				title,
				prompt,
				scheduleType,
				cron,
				triggerAt,
				timezone,
				enabled,
			});
			return JSON.stringify(session.task, null, 2);
		},
	});

	const listScheduledTasksTool = createTool({
		name: "list_scheduled_tasks",
		description: "List all scheduled tasks and their current status, next run time, and last run result.",
		parameters: z.object({}),
		async execute() {
			const tasks = requireTaskManager().listTaskEntries().map((entry) => entry.task);
			return JSON.stringify(tasks, null, 2);
		},
	});

	const updateScheduledTaskTool = createTool({
		name: "update_scheduled_task",
		category: "change",
		description: "Update an existing scheduled task. Usually list tasks first to confirm the target taskId.",
		parameters: z.object({
			taskId: z.string().describe("Scheduled task ID"),
			title: z.string().optional().describe("Updated task title"),
			prompt: z.string().optional().describe("Updated prompt"),
			scheduleType: z.enum(["once", "recurring"]).optional().describe("Updated schedule type"),
			cron: z.string().optional().describe("Updated cron expression for recurring tasks"),
			triggerAt: z.number().optional().describe("Updated one-time execution timestamp in milliseconds"),
			timezone: z.string().optional().describe("Updated IANA timezone name"),
			enabled: z.boolean().optional().describe("Whether the task should remain enabled"),
		}),
		async execute({ taskId, title, prompt, scheduleType, cron, triggerAt, timezone, enabled }) {
			const session = await requireTaskManager().updateTask(taskId, {
				title,
				prompt,
				scheduleType,
				cron,
				triggerAt,
				timezone,
				enabled,
			});
			return JSON.stringify(session.task, null, 2);
		},
	});

	const deleteScheduledTaskTool = createTool({
		name: "delete_scheduled_task",
		category: "change",
		description: "Delete a scheduled task by its taskId.",
		parameters: z.object({
			taskId: z.string().describe("Scheduled task ID"),
		}),
		async execute({ taskId }) {
			await requireTaskManager().deleteTask(taskId);
			return JSON.stringify({ ok: true, taskId }, null, 2);
		},
	});

	return {
		createScheduledTaskTool,
		listScheduledTasksTool,
		updateScheduledTaskTool,
		deleteScheduledTaskTool,
	};
}
