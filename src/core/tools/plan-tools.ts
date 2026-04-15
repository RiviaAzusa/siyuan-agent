import { tool, ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import { emitToolEvent } from "./siyuan-api";
import type { TodoList, TodoStatus } from "../../types";

/**
 * `write_todos` tool — creates or replaces the agent's task execution plan.
 *
 * The tool emits a custom event `{ __tool_type: "write_todos", todos }` via
 * `runtime.writer`, which the stream runtime picks up to persist into
 * `AgentState.todos` and the UI can render as a progress checklist.
 */
export const writeTodosTool = tool(
	async ({ goal, todos: items }, runtime: ToolRuntime) => {
		const now = Date.now();
		const todoList: TodoList = {
			goal,
			items: items.map((item) => ({
				content: item.content,
				status: (item.status ?? "pending") as TodoStatus,
			})),
			updatedAt: now,
		};

		// Emit structured event so stream-runtime can persist todos into AgentState
		emitToolEvent(runtime, { __tool_type: "write_todos", todos: todoList });

		const completed = todoList.items.filter((i) => i.status === "completed").length;
		const inProgress = todoList.items.filter((i) => i.status === "in_progress").length;
		const pending = todoList.items.length - completed - inProgress;

		return JSON.stringify({
			status: "ok",
			goal: todoList.goal,
			total: todoList.items.length,
			completed,
			inProgress,
			pending,
		});
	},
	{
		name: "write_todos",
		description:
			"Create or replace the current task execution plan. Use this for multi-step tasks to track progress. Each call replaces the entire plan. Update item statuses as you complete steps.",
		schema: z.object({
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
	},
);
