import { tool, ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import { emitActivity } from "./siyuan-api";
import type { ScheduledTaskManager } from "../scheduled-task-manager";

export function createScheduledTaskTools(getTaskManager: () => ScheduledTaskManager | null) {
	const requireTaskManager = (): ScheduledTaskManager => {
		const manager = getTaskManager();
		if (!manager) {
			throw new Error("Scheduled task manager is not ready.");
		}
		return manager;
	};

	const createScheduledTaskTool = tool(
		async ({ title, prompt, scheduleType, cron, triggerAt, timezone, enabled }, runtime: ToolRuntime) => {
			const session = await requireTaskManager().createTask({
				title,
				prompt,
				scheduleType,
				cron,
				triggerAt,
				timezone,
				enabled,
			});
			emitActivity(runtime, {
				category: "change",
				action: "create",
				label: session.task?.title || title,
				meta: "已创建定时任务",
			});
			return JSON.stringify(session.task, null, 2);
		},
		{
			name: "create_scheduled_task",
			description: "Create a scheduled task for future execution. Use this when the user asks for a daily/weekly/one-time reminder, summary, or recurring automation.",
			schema: z.object({
				title: z.string().min(1).describe("Short task title shown in the task board"),
				prompt: z.string().min(1).describe("The prompt that should be sent to the agent when the task runs"),
				scheduleType: z.enum(["once", "recurring"]).describe("Whether the task runs once or repeatedly"),
				cron: z.string().optional().describe("Cron expression for recurring tasks"),
				triggerAt: z.number().optional().describe("Unix timestamp in milliseconds for one-time tasks"),
				timezone: z.string().optional().describe("IANA timezone name, e.g. Asia/Shanghai"),
				enabled: z.boolean().optional().describe("Whether the task should start enabled. Defaults to true."),
			}),
		}
	);

	const listScheduledTasksTool = tool(
		async (_, runtime: ToolRuntime) => {
			const tasks = requireTaskManager().listTaskEntries().map((entry) => entry.task);
			emitActivity(runtime, {
				category: "lookup",
				action: "list",
				label: "定时任务",
				meta: `已列出 ${tasks.length} 个任务`,
			});
			return JSON.stringify(tasks, null, 2);
		},
		{
			name: "list_scheduled_tasks",
			description: "List all scheduled tasks and their current status, next run time, and last run result.",
			schema: z.object({}),
		}
	);

	const updateScheduledTaskTool = tool(
		async ({ taskId, title, prompt, scheduleType, cron, triggerAt, timezone, enabled }, runtime: ToolRuntime) => {
			const session = await requireTaskManager().updateTask(taskId, {
				title,
				prompt,
				scheduleType,
				cron,
				triggerAt,
				timezone,
				enabled,
			});
			emitActivity(runtime, {
				category: "change",
				action: "edit",
				label: session.task?.title || taskId,
				meta: "已更新定时任务",
			});
			return JSON.stringify(session.task, null, 2);
		},
		{
			name: "update_scheduled_task",
			description: "Update an existing scheduled task. Usually list tasks first to confirm the target taskId.",
			schema: z.object({
				taskId: z.string().describe("Scheduled task ID"),
				title: z.string().optional().describe("Updated task title"),
				prompt: z.string().optional().describe("Updated prompt"),
				scheduleType: z.enum(["once", "recurring"]).optional().describe("Updated schedule type"),
				cron: z.string().optional().describe("Updated cron expression for recurring tasks"),
				triggerAt: z.number().optional().describe("Updated one-time execution timestamp in milliseconds"),
				timezone: z.string().optional().describe("Updated IANA timezone name"),
				enabled: z.boolean().optional().describe("Whether the task should remain enabled"),
			}),
		}
	);

	const deleteScheduledTaskTool = tool(
		async ({ taskId }, runtime: ToolRuntime) => {
			await requireTaskManager().deleteTask(taskId);
			emitActivity(runtime, {
				category: "change",
				action: "delete",
				label: taskId,
				meta: "已删除定时任务",
			});
			return JSON.stringify({ ok: true, taskId }, null, 2);
		},
		{
			name: "delete_scheduled_task",
			description: "Delete a scheduled task by its taskId.",
			schema: z.object({
				taskId: z.string().describe("Scheduled task ID"),
			}),
		}
	);

	return {
		createScheduledTaskTool,
		listScheduledTasksTool,
		updateScheduledTaskTool,
		deleteScheduledTaskTool,
	};
}
