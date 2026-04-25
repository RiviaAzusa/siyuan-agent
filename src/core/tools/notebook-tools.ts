import { tool, ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import { siyuanFetch, emitActivity } from "./siyuan-api";
import { listDocumentsViaApi } from "../list-documents";
import { recentDocumentsViaApi } from "../recent-documents";
import { defaultTranslator, type Translator } from "../../i18n";

export function createListNotebooksTool(i18n: Translator = defaultTranslator) {
return tool(
	async (_, runtime: ToolRuntime) => {
		const data = await siyuanFetch("/api/notebook/lsNotebooks", {});
		const notebooks = (data.notebooks || []).map((nb: any) => ({
			id: nb.id,
			name: nb.name,
			icon: nb.icon,
			closed: nb.closed,
		}));
		emitActivity(runtime, {
			category: "lookup",
			action: "list",
			label: i18n.t("tool.listNotebooks.label"),
			meta: i18n.t("tool.listNotebooks.meta", { count: notebooks.length }),
		});
		return JSON.stringify(notebooks, null, 2);
	},
	{
		name: "list_notebooks",
		description: "List all notebooks in SiYuan. returns id, name, icon, and closed status for each notebook. Use this to find the notebook ID needed for other tools.",
		schema: z.object({}),
	}
);
}

export function createListDocumentsTool(i18n: Translator = defaultTranslator) {
return tool(
	async ({ notebook, path, depth, page, page_size, child_limit, include_summary }, runtime: ToolRuntime) => {
		const result = await listDocumentsViaApi({
			notebook,
			path,
			depth,
			page,
			page_size,
			child_limit,
			include_summary,
		}, siyuanFetch);
		emitActivity(runtime, {
			category: "lookup",
			action: "list",
			path: result.path,
			label: result.path,
			meta: i18n.t("tool.listDocuments.meta", { count: result.items.length }),
		});
		return JSON.stringify(result, null, 2);
	},
	{
		name: "list_documents",
		description: "List documents in a specific notebook as a paginated tree. The path parameter uses the human-readable hpath, while the tool resolves SiYuan filetree paths internally. Returns pagination metadata plus items with id, title, hpath, updated, hasChildren, childCount, optional children, and optional summary.",
		schema: z.object({
			notebook: z.string().describe("The Notebook ID (box ID) to search in. You must get this from list_notebooks first."),
			path: z.string().optional().describe("Optional human-readable path (hpath) to list under, e.g. '/Daily Notes'. Defaults to root '/'."),
			depth: z.number().int().min(0).max(5).optional().describe("Tree expansion depth. 0 returns only the current level, 1 includes one level of children. Defaults to 0."),
			page: z.number().int().min(1).optional().describe("Page number for the current level. Defaults to 1."),
			page_size: z.number().int().min(1).max(50).optional().describe("Number of items per page at the current level. Defaults to 20, max 50."),
			child_limit: z.number().int().min(0).max(20).optional().describe("Maximum number of direct child documents to include for each expanded node. Defaults to 5, max 20."),
			include_summary: z.boolean().optional().describe("Whether to include a lightweight summary for each returned document. Defaults to true."),
		}),
	}
);
}

export function createRecentDocumentsTool(i18n: Translator = defaultTranslator) {
return tool(
	async ({ limit }, runtime: ToolRuntime) => {
		const result = await recentDocumentsViaApi({
			limit,
		}, siyuanFetch);
		emitActivity(runtime, {
			category: "lookup",
			action: "list",
			label: i18n.t("tool.recentDocuments.label"),
			meta: i18n.t("tool.recentDocuments.meta", { count: result.items.length }),
		});
		return JSON.stringify(result, null, 2);
	},
	{
		name: "recent_documents",
		description: "List the most recently modified documents with brief summaries.",
		schema: z.object({
			limit: z.number().int().min(1).max(20).optional().describe("Number of documents to return. Defaults to 10."),
		}),
	}
);
}

export const listNotebooksTool = createListNotebooksTool();
export const listDocumentsTool = createListDocumentsTool();
export const recentDocumentsTool = createRecentDocumentsTool();
