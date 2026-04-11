import { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { createSubAgentTool } from "../sub-agent";
import type { AgentConfig } from "../../types";
import type { ScheduledTaskManager } from "../scheduled-task-manager";

import { listNotebooksTool, listDocumentsTool, recentDocumentsTool } from "./notebook-tools";
import { getDocumentTool, getDocumentBlocksTool, getDocumentOutlineTool, readBlockTool, searchFulltextTool, searchDocumentsTool } from "./document-tools";
import { editBlocksTool, appendBlockTool, createDocumentTool, moveDocumentTool, renameDocumentTool, deleteDocumentTool } from "./edit-tools";
import { searchTodosTool, toggleTodoTool, getTodoStatsTool } from "./todo-tools";
import { createScheduledTaskTools } from "./scheduled-tools";

export { deleteDocumentTool } from "./edit-tools";
export { siyuanFetch, emitToolEvent, emitActivity, sqlEscape } from "./siyuan-api";

export function getLookupTools(): StructuredToolInterface[] {
	return [
		listNotebooksTool,
		listDocumentsTool,
		recentDocumentsTool,
		getDocumentTool,
		getDocumentBlocksTool,
		getDocumentOutlineTool,
		readBlockTool,
		searchFulltextTool,
		searchDocumentsTool,
		searchTodosTool,
		getTodoStatsTool,
	];
}

function createExploreNotesTool(getAgentConfig: () => AgentConfig | Promise<AgentConfig>): StructuredToolInterface {
	return createSubAgentTool({
		name: "explore_notes",
		description: "当任务需要跨多篇笔记做探索、筛选、梳理或归纳时，优先调用此工具。不要先自己手动展开多轮 search_fulltext、get_document 或 get_document_blocks；这个探索子智能体会自行搜索、读取并返回简洁结论。仅用于查找/总结，不用于写入。",
		schema: z.object({
			query: z.string().describe("要在笔记库中探索的问题或目标"),
		}),
		toolset: getLookupTools,
		systemPrompt: [
			"你是一个专门用于探索思源笔记的子智能体。",
			"你的目标是为父级智能体收集足够回答问题的结论，而不是转储大量原文。",
			"只使用可读取的 lookup 类工具，自主完成搜索、筛选和按需阅读。",
			"优先搜索和最小必要读取，避免无意义展开过多文档。",
			"输出简洁中文摘要，尽量保留文档标题、文档 ID、路径和关键发现。",
			"不要生成 UI 指令，不要暴露工具过程，不要解释自己是子智能体。",
		].join("\n"),
		getAgentConfig,
		recursionLimit: 12,
	});
}

export function getDefaultTools(
	getAgentConfig: () => AgentConfig | Promise<AgentConfig>,
	getTaskManager: () => ScheduledTaskManager | null = () => null,
): StructuredToolInterface[] {
	const scheduledTaskTools = createScheduledTaskTools(getTaskManager);
	const defaultTools: StructuredToolInterface[] = [
	listNotebooksTool,
	listDocumentsTool,
	recentDocumentsTool,
	getDocumentTool,
	getDocumentBlocksTool,
	getDocumentOutlineTool,
	readBlockTool,
	searchFulltextTool,
	createExploreNotesTool(getAgentConfig),
	appendBlockTool,
	editBlocksTool,
	createDocumentTool,
	moveDocumentTool,
	renameDocumentTool,
	searchDocumentsTool,
	searchTodosTool,
	toggleTodoTool,
	getTodoStatsTool,
	scheduledTaskTools.createScheduledTaskTool,
	scheduledTaskTools.listScheduledTasksTool,
	scheduledTaskTools.updateScheduledTaskTool,
	scheduledTaskTools.deleteScheduledTaskTool,
	// deleteDocumentTool is intentionally excluded for safety
	];
	return defaultTools;
}
