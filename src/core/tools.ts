import { tool, StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { fetchPost } from "siyuan";

function siyuanFetch(url: string, data: any): Promise<any> {
	return new Promise((resolve, reject) => {
		fetchPost(url, data, (resp: any) => {
			if (resp.code !== 0)
				reject(new Error(resp.msg || `API error code ${resp.code}`));
			else
				resolve(resp.data);
		});
	});
}

/* --- fake tool for testing --- */

const getWeatherTool = tool(
	async ({ city }) => {
		return JSON.stringify({ city, weather: "晴", temperature: "25°C" });
	},
	{
		name: "get_weather",
		description: "Get the weather of a city.",
		schema: z.object({
			city: z.string().describe("City name, e.g. 'Beijing'"),
		}),
	}
);

/* --- SiYuan notebook/document tools --- */

/* --- SiYuan notebook/document tools --- */

const listNotebooksTool = tool(
	async () => {
		const data = await siyuanFetch("/api/notebook/lsNotebooks", {});
		const notebooks = (data.notebooks || []).map((nb: any) => ({
			id: nb.id,
			name: nb.name,
			icon: nb.icon,
			closed: nb.closed,
		}));
		return JSON.stringify(notebooks, null, 2);
	},
	{
		name: "list_notebooks",
		description: "List all notebooks in SiYuan. returns id, name, icon, and closed status for each notebook. Use this to find the notebook ID needed for other tools.",
		schema: z.object({}),
	}
);

const listDocumentsTool = tool(
	async ({ notebook, path }) => {
		const stmt = path
			? `SELECT * FROM blocks WHERE type='d' AND box='${notebook}' AND hpath LIKE '${path}%' ORDER BY updated DESC LIMIT 50`
			: `SELECT * FROM blocks WHERE type='d' AND box='${notebook}' ORDER BY updated DESC LIMIT 50`;
		const data = await siyuanFetch("/api/query/sql", { stmt });
		const docs = (data || []).map((d: any) => ({
			id: d.id,
			title: d.content,
			hpath: d.hpath,
			updated: d.updated,
		}));
		return JSON.stringify(docs, null, 2);
	},
	{
		name: "list_documents",
		description: "List documents in a specific notebook. Returns document id, title, human-readable path (hpath), and last updated time. You must provide a notebook ID. Optionally filter by path prefix to narrow down results.",
		schema: z.object({
			notebook: z.string().describe("The Notebook ID (box ID) to search in. You must get this from list_notebooks first."),
			path: z.string().optional().describe("Optional path prefix to filter documents, e.g. '/Daily Notes'. defaults to root '/'"),
		}),
	}
);

const getDocumentTool = tool(
	async ({ id }) => {
		const data = await siyuanFetch("/api/export/exportMdContent", { id });
		const hpath = data.hPath || "";
		const content = data.content || "";
		return `# ${hpath}\n\n${content}`;
	},
	{
		name: "get_document",
		description: "Get the full Markdown content of a document (block) by its ID. Returns the complete document content including its path.",
		schema: z.object({
			id: z.string().describe("The Document block ID. You usually get this from list_documents or search results."),
		}),
	}
);

const defaultTools: StructuredToolInterface[] = [
	getWeatherTool,
	listNotebooksTool,
	listDocumentsTool,
	getDocumentTool,
];

export function getDefaultTools(): StructuredToolInterface[] {
	return defaultTools;
}
