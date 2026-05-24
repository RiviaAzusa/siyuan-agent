import { createTool } from "../tool-types";
import { z } from "zod";
import type { TodoList, TodoStatus } from "../../types";

/**
 * `write_todos` tool — creates or replaces the agent's task execution plan.
 *
 * The tool updates AgentState.todos through the runtime context and returns
 * a normal ToolResult that remains part of the message history.
 */
export const writeTodosTool = createTool({
	name: "write_todos",
	description:
		"Create or replace the current task execution plan. Use this for multi-step tasks to track progress. Each call replaces the entire plan. Update item statuses as you complete steps.",
	parameters: z.object({
		goal: z.string().describe("Overall goal of the plan"),
		todos: z.array(
			z.object({
				content: z.string().describe("Description of this step"),
				status: z
					.enum(["pending", "in_progress", "completed"])
					.default("pending")
					.describe("Current status of this step"),
			}),
		).describe("List of plan items"),
	}),
	async execute({ goal, todos: items }, options) {
		const now = Date.now();
		const todoList: TodoList = {
			goal,
			items: items.map((item) => ({
				content: item.content,
				status: (item.status ?? "pending") as TodoStatus,
			})),
			updatedAt: now,
		};

		options.experimental_context?.setTodos?.(todoList);

		const completed = todoList.items.filter((i) => i.status === "completed").length;
		const inProgress = todoList.items.filter((i) => i.status === "in_progress").length;
		const pending = todoList.items.length - completed - inProgress;

		return JSON.stringify({
			status: "ok",
			goal: todoList.goal,
			todos: todoList,
			total: todoList.items.length,
			completed,
			inProgress,
			pending,
		});
	},
});
