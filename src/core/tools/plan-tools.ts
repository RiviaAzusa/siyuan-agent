import { createTool } from "../tool-types";
import { z } from "zod";
import type { TodoList, TodoStatus } from "../../types";
import { TOOL_DESC } from "../../types";

/**
 * `write_todos` tool — creates or replaces the agent's task execution plan.
 *
 * The tool updates AgentState.todos through the runtime context and returns
 * a normal ToolResult that remains part of the message history.
 */
const desc = TOOL_DESC.write_todos;
export const writeTodosTool = createTool({
	name: "write_todos",
	description: desc.description,
	parameters: z.object({
		goal: z.string().describe(desc.params.goal),
		todos: z.array(
			z.object({
				content: z.string().describe(desc.params["todos[].content"]),
				status: z
					.enum(["pending", "in_progress", "completed"])
					.default("pending")
					.describe(desc.params["todos[].status"]),
			}),
		).describe(desc.params.todos),
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
