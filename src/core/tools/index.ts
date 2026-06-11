import type { Tool } from "@ai-sdk/provider-utils";
import { z } from "zod";
import { createSubAgentTool } from "../sub-agent";
import type { AgentConfig, ToolPermissionMode } from "../../types";
import type { ScheduledTaskManager } from "../scheduled-task-manager";
import { TOOL_DESC, EXPLORE_SUBAGENT_PROMPT } from "../../types";
import { defaultTranslator, type Translator } from "../../i18n";

import { createListNotebooksTool, createListDocumentsTool, createRecentDocumentsTool } from "./notebook-tools";
import { createGetDocumentTool, createGetDocumentBlocksTool, createGetDocumentOutlineTool, createReadBlockTool, createSearchFulltextTool, createSearchDocumentsTool } from "./document-tools";
import { createEditBlocksTool, createAppendBlockTool, createCreateDocumentTool, createMoveDocumentTool, createRenameDocumentTool, createDeleteDocumentTool } from "./edit-tools";
import { writeTodosTool } from "./plan-tools";
import { createScheduledTaskTools } from "./scheduled-tools";

export { deleteDocumentTool } from "./edit-tools";
export { siyuanFetch, sqlEscape } from "./siyuan-api";

export type SiyuanTool = Tool<any, string>;

export function getLookupTools(): SiyuanTool[] {
	return createLookupTools(defaultTranslator);
}

function createLookupTools(i18n: Translator): SiyuanTool[] {
	return [
		createListNotebooksTool(i18n),
		createListDocumentsTool(i18n),
		createRecentDocumentsTool(i18n),
		createGetDocumentTool(i18n),
		createGetDocumentBlocksTool(i18n),
		createGetDocumentOutlineTool(i18n),
		createReadBlockTool(i18n),
		createSearchFulltextTool(i18n),
		createSearchDocumentsTool(i18n),
	];
}

function createExploreNotesTool(
	getAgentConfig: () => AgentConfig | Promise<AgentConfig>,
): SiyuanTool {
	const desc = TOOL_DESC.explore_notes;
	return createSubAgentTool({
		name: "explore_notes",
		description: desc.description,
		schema: z.object({
			query: z.string().describe(desc.params.query),
		}),
		toolset: () => createLookupTools(defaultTranslator),
		systemPrompt: EXPLORE_SUBAGENT_PROMPT,
		getAgentConfig,
		recursionLimit: 12,
	});
}

const DELETE_TOOLS = new Set(["delete_document", "delete_scheduled_task"]);

function resolveToolPermissionMode(getAgentConfig: () => AgentConfig | Promise<AgentConfig>): ToolPermissionMode {
	try {
		const config = getAgentConfig();
		if (config && typeof (config as Promise<AgentConfig>).then !== "function") {
			return config.toolPermissionMode === "autoApprove" ? "autoApprove" : "requestApproval";
		}
	} catch {
		/* Use default. */
	}
	return "requestApproval";
}

function needsApprovalForTool(mode: ToolPermissionMode, toolName: string): boolean {
	return mode === "requestApproval" || DELETE_TOOLS.has(toolName);
}

export function getDefaultTools(
	getAgentConfig: () => AgentConfig | Promise<AgentConfig>,
	getTaskManager: () => ScheduledTaskManager | null = () => null,
	i18n: Translator = defaultTranslator,
): SiyuanTool[] {
	const permissionMode = resolveToolPermissionMode(getAgentConfig);
	const changeApproval = (toolName: string) => needsApprovalForTool(permissionMode, toolName);
	const scheduledTaskTools = createScheduledTaskTools(getTaskManager, i18n, {
		needsApproval: {
			create: changeApproval("create_scheduled_task"),
			update: changeApproval("update_scheduled_task"),
			delete: changeApproval("delete_scheduled_task"),
		},
	});
	const defaultTools: SiyuanTool[] = [
		createListNotebooksTool(i18n),
		createListDocumentsTool(i18n),
		createRecentDocumentsTool(i18n),
		createGetDocumentTool(i18n),
		createGetDocumentBlocksTool(i18n),
		createGetDocumentOutlineTool(i18n),
		createReadBlockTool(i18n),
		createSearchFulltextTool(i18n),
		createExploreNotesTool(getAgentConfig),
		createAppendBlockTool(i18n, { needsApproval: changeApproval("append_block") }),
		createEditBlocksTool(i18n, { needsApproval: changeApproval("edit_blocks") }),
		createCreateDocumentTool(i18n, { needsApproval: changeApproval("create_document") }),
		createMoveDocumentTool(i18n, { needsApproval: changeApproval("move_document") }),
		createRenameDocumentTool(i18n, { needsApproval: changeApproval("rename_document") }),
		createDeleteDocumentTool({ needsApproval: changeApproval("delete_document") }),
		createSearchDocumentsTool(i18n),
		writeTodosTool,
		scheduledTaskTools.createScheduledTaskTool,
		scheduledTaskTools.listScheduledTasksTool,
		scheduledTaskTools.updateScheduledTaskTool,
		scheduledTaskTools.deleteScheduledTaskTool,
	];
	return defaultTools;
}
