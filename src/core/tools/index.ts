import type { Tool } from "@ai-sdk/provider-utils";
import { z } from "zod";
import { createSubAgentTool } from "../sub-agent";
import type { AgentConfig } from "../../types";
import type { ScheduledTaskManager } from "../scheduled-task-manager";
import { TOOL_DESC, EXPLORE_SUBAGENT_PROMPT } from "../../types";
import { defaultTranslator, type Translator } from "../../i18n";

import { createListNotebooksTool, createListDocumentsTool, createRecentDocumentsTool } from "./notebook-tools";
import { createGetDocumentTool, createGetDocumentBlocksTool, createGetDocumentOutlineTool, createReadBlockTool, createSearchFulltextTool, createSearchDocumentsTool } from "./document-tools";
import { createEditBlocksTool, createAppendBlockTool, createCreateDocumentTool, createMoveDocumentTool, createRenameDocumentTool } from "./edit-tools";
import { writeTodosTool } from "./plan-tools";
import { createScheduledTaskTools } from "./scheduled-tools";
import { callErrorTool } from "./debug-tools";

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

export function getDefaultTools(
	getAgentConfig: () => AgentConfig | Promise<AgentConfig>,
	getTaskManager: () => ScheduledTaskManager | null = () => null,
	i18n: Translator = defaultTranslator,
): SiyuanTool[] {
	const scheduledTaskTools = createScheduledTaskTools(getTaskManager, i18n);
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
		createAppendBlockTool(i18n),
		createEditBlocksTool(i18n),
		createCreateDocumentTool(i18n),
		createMoveDocumentTool(i18n),
		createRenameDocumentTool(i18n),
		createSearchDocumentsTool(i18n),
		writeTodosTool,
		scheduledTaskTools.createScheduledTaskTool,
		scheduledTaskTools.listScheduledTasksTool,
		scheduledTaskTools.updateScheduledTaskTool,
		scheduledTaskTools.deleteScheduledTaskTool,
		callErrorTool,
		// deleteDocumentTool is intentionally excluded for safety
	];
	return defaultTools;
}
