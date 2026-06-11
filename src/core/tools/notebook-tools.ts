import { createTool } from "../tool-types";
import { z } from "zod";
import { siyuanFetch } from "./siyuan-api";
import { listDocumentsViaApi } from "../list-documents";
import { recentDocumentsViaApi } from "../recent-documents";
import { TOOL_DESC } from "../../types";
import { defaultTranslator, type Translator } from "../../i18n";

export function createListNotebooksTool(i18n: Translator = defaultTranslator) {
	const desc = TOOL_DESC.list_notebooks;
	return createTool({
		name: "list_notebooks",
		description: desc.description,
		parameters: z.object({}),
		async execute() {
			const data = await siyuanFetch("/api/notebook/lsNotebooks", {});
			const notebooks = (data.notebooks || []).map((nb: any) => ({
				id: nb.id,
				name: nb.name,
				icon: nb.icon,
				closed: nb.closed,
			}));
			return JSON.stringify(notebooks, null, 2);
		},
	});
}

export function createListDocumentsTool(i18n: Translator = defaultTranslator) {
	const desc = TOOL_DESC.list_documents;
	return createTool({
		name: "list_documents",
		description: desc.description,
		parameters: z.object({
			notebook: z.string().describe(desc.params.notebook),
			path: z.string().optional().describe(desc.params.path),
			depth: z.number().int().min(0).max(5).optional().describe(desc.params.depth),
			page: z.number().int().min(1).optional().describe(desc.params.page),
			page_size: z.number().int().min(1).max(50).optional().describe(desc.params.page_size),
			child_limit: z.number().int().min(0).max(20).optional().describe(desc.params.child_limit),
			include_summary: z.boolean().optional().describe(desc.params.include_summary),
		}),
		async execute({ notebook, path, depth, page, page_size, child_limit, include_summary }) {
			const result = await listDocumentsViaApi({
				notebook,
				path,
				depth,
				page,
				page_size,
				child_limit,
				include_summary,
			}, siyuanFetch);
			return JSON.stringify(result, null, 2);
		},
	});
}

export function createRecentDocumentsTool(i18n: Translator = defaultTranslator) {
	const desc = TOOL_DESC.recent_documents;
	return createTool({
		name: "recent_documents",
		description: desc.description,
		parameters: z.object({
			limit: z.number().int().min(1).max(20).optional().describe(desc.params.limit),
		}),
		async execute({ limit }) {
			const result = await recentDocumentsViaApi({
				limit,
			}, siyuanFetch);
			return JSON.stringify(result, null, 2);
		},
	});
}

export const listNotebooksTool = createListNotebooksTool();
export const listDocumentsTool = createListDocumentsTool();
export const recentDocumentsTool = createRecentDocumentsTool();
