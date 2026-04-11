import { tool, ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import { siyuanFetch, emitActivity, sqlEscape } from "./siyuan-api";

export const searchTodosTool = tool(
	async ({ status, keyword, notebook, limit }, runtime: ToolRuntime) => {
		const conditions: string[] = ["type='i'", "subtype='t'"];
		if (status === "done") {
			conditions.push("markdown LIKE '%[x]%'");
		} else if (status === "todo") {
			conditions.push("markdown LIKE '%[ ]%'");
		}
		if (keyword) {
			conditions.push(`content LIKE '%${sqlEscape(keyword)}%'`);
		}
		if (notebook) {
			conditions.push(`box='${sqlEscape(notebook)}'`);
		}
		const maxItems = Math.min(limit || 50, 100);
		const stmt = `SELECT id, root_id, parent_id, box, content, markdown, hpath, updated FROM blocks WHERE ${conditions.join(" AND ")} ORDER BY updated DESC LIMIT ${maxItems}`;
		const data = await siyuanFetch("/api/query/sql", { stmt });
		const items = (data || []).map((row: any) => ({
			id: row.id,
			rootDocId: row.root_id,
			content: row.content,
			done: /\[x\]/i.test(row.markdown),
			hpath: row.hpath,
			notebook: row.box,
			updated: row.updated,
		}));
		emitActivity(runtime, {
			category: "lookup",
			action: "search",
			label: keyword || (status === "done" ? "已完成任务" : status === "todo" ? "待办任务" : "所有任务"),
			meta: `找到 ${items.length} 条任务`,
		});
		return JSON.stringify(items, null, 2);
	},
	{
		name: "search_todos",
		description: "Search for task list items (checkboxes) across all notes. Can filter by completion status, keyword, and notebook. Returns todo items with their block IDs, content, completion status, and document path.",
		schema: z.object({
			status: z.enum(["all", "todo", "done"]).default("all").describe("Filter by completion: 'todo' for unchecked, 'done' for checked, 'all' for both"),
			keyword: z.string().optional().describe("Optional keyword to filter task content"),
			notebook: z.string().optional().describe("Optional notebook ID to limit search scope"),
			limit: z.number().optional().describe("Max items to return (default 50, max 100)"),
		}),
	}
);

export const toggleTodoTool = tool(
	async ({ ids }, runtime: ToolRuntime) => {
		const originals: Record<string, string> = await siyuanFetch("/api/block/getBlockKramdowns", { ids });
		const results: any[] = [];

		for (const id of ids) {
			const original = originals[id];
			if (original === undefined) {
				results.push({ id, status: "error", error: `Block ${id} not found` });
				continue;
			}
			try {
				let newMarkdown: string;
				let newDone: boolean;
				if (/\[x\]/i.test(original)) {
					newMarkdown = original.replace(/\[x\]/i, "[ ]");
					newDone = false;
				} else if (/\[ \]/.test(original)) {
					newMarkdown = original.replace("[ ]", "[x]");
					newDone = true;
				} else {
					results.push({ id, status: "error", error: "Block is not a task list item" });
					continue;
				}
				await siyuanFetch("/api/block/updateBlock", {
					id,
					data: newMarkdown,
					dataType: "markdown",
				});
				results.push({ id, status: "ok", done: newDone, content: newMarkdown });
			} catch (err: any) {
				results.push({ id, status: "error", error: err.message });
			}
		}
		const toggled = results.filter(r => r.status === "ok").length;
		emitActivity(runtime, {
			category: "change",
			action: "edit",
			label: `切换 ${toggled} 条任务状态`,
			meta: results.map(r => r.done ? "✅" : "⬜").join(""),
		});
		return JSON.stringify(results, null, 2);
	},
	{
		name: "toggle_todo",
		description: "Toggle the completion status of one or more task list items (check/uncheck checkboxes). Provide the block IDs of the task list items to toggle.",
		schema: z.object({
			ids: z.array(z.string()).min(1).describe("Array of task list item block IDs to toggle"),
		}),
	}
);

export const getTodoStatsTool = tool(
	async ({ notebook, rootDocId }, runtime: ToolRuntime) => {
		const baseConditions = ["type='i'", "subtype='t'"];
		if (notebook) baseConditions.push(`box='${sqlEscape(notebook)}'`);
		if (rootDocId) baseConditions.push(`root_id='${sqlEscape(rootDocId)}'`);
		const where = baseConditions.join(" AND ");

		const [totalRows, doneRows] = await Promise.all([
			siyuanFetch("/api/query/sql", {
				stmt: `SELECT COUNT(*) as cnt FROM blocks WHERE ${where}`,
			}),
			siyuanFetch("/api/query/sql", {
				stmt: `SELECT COUNT(*) as cnt FROM blocks WHERE ${where} AND markdown LIKE '%[x]%'`,
			}),
		]);
		const total = totalRows?.[0]?.cnt ?? 0;
		const done = doneRows?.[0]?.cnt ?? 0;
		const todo = total - done;
		const pct = total > 0 ? Math.round((done / total) * 100) : 0;
		const stats = { total, done, todo, completionPercent: pct };
		emitActivity(runtime, {
			category: "lookup",
			action: "search",
			label: "任务统计",
			meta: `${done}/${total} (${pct}%)`,
		});
		return JSON.stringify(stats, null, 2);
	},
	{
		name: "get_todo_stats",
		description: "Get task completion statistics — total count, done count, pending count, and completion percentage. Can be scoped to a notebook or specific document.",
		schema: z.object({
			notebook: z.string().optional().describe("Optional notebook ID to scope stats"),
			rootDocId: z.string().optional().describe("Optional document ID to get stats for a single document"),
		}),
	}
);
