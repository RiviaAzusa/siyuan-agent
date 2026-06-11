import { createTool } from "../tool-types";
import { z } from "zod";
import type { ScheduledTaskManager } from "../scheduled-task-manager";
import { TOOL_DESC } from "../../types";
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

	const createDesc = TOOL_DESC.create_scheduled_task;
	const createScheduledTaskTool = createTool({
		name: "create_scheduled_task",
		category: "change",
		description: createDesc.description,
		parameters: z.object({
			title: z.string().min(1).describe(createDesc.params.title),
			prompt: z.string().min(1).describe(createDesc.params.prompt),
			scheduleType: z.enum(["once", "recurring"]).describe(createDesc.params.scheduleType),
			cron: z.string().optional().describe(createDesc.params.cron),
			triggerAt: z.number().optional().describe(createDesc.params.triggerAt),
			timezone: z.string().optional().describe(createDesc.params.timezone),
			enabled: z.boolean().optional().describe(createDesc.params.enabled),
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
		description: TOOL_DESC.list_scheduled_tasks.description,
		parameters: z.object({}),
		async execute() {
			const tasks = requireTaskManager().listTaskEntries().map((entry) => entry.task);
			return JSON.stringify(tasks, null, 2);
		},
	});

	const updateDesc = TOOL_DESC.update_scheduled_task;
	const updateScheduledTaskTool = createTool({
		name: "update_scheduled_task",
		category: "change",
		description: updateDesc.description,
		parameters: z.object({
			taskId: z.string().describe(updateDesc.params.taskId),
			title: z.string().optional().describe(updateDesc.params.title),
			prompt: z.string().optional().describe(updateDesc.params.prompt),
			scheduleType: z.enum(["once", "recurring"]).optional().describe(updateDesc.params.scheduleType),
			cron: z.string().optional().describe(updateDesc.params.cron),
			triggerAt: z.number().optional().describe(updateDesc.params.triggerAt),
			timezone: z.string().optional().describe(updateDesc.params.timezone),
			enabled: z.boolean().optional().describe(updateDesc.params.enabled),
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

	const deleteDesc = TOOL_DESC.delete_scheduled_task;
	const deleteScheduledTaskTool = createTool({
		name: "delete_scheduled_task",
		category: "change",
		description: deleteDesc.description,
		parameters: z.object({
			taskId: z.string().describe(deleteDesc.params.taskId),
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
