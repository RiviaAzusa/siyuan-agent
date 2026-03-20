import { tool, StructuredToolInterface, ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import { fetchPost, openTab } from "siyuan";
import { listDocumentsViaApi } from "./list-documents";
import { recentDocumentsViaApi } from "./recent-documents";

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
	async ({ notebook, path, depth, page, page_size, child_limit, include_summary }) => {
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

const recentDocumentsTool = tool(
	async ({ limit }) => {
		const result = await recentDocumentsViaApi({
			limit,
		}, siyuanFetch);
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

const getDocumentTool = tool(
	async ({ id }, config: ToolRuntime) => {
		const docInfo = await siyuanFetch("/api/query/sql", {
			stmt: `SELECT id, content, hpath FROM blocks WHERE id='${id}' LIMIT 1`,
		});
		const data = await siyuanFetch("/api/export/exportMdContent", { id });
		const hpath = data.hPath || "";
		const content = data.content || "";
		const label = docInfo?.[0]?.content || hpath || id;
		if (config.writer) {
			config.writer(JSON.stringify({
				__tool_type: "document_link",
				id,
				path: hpath,
				label,
				open: false,
			}));
		}
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

const searchFulltextTool = tool(
	async ({ query, page }) => {
		const data = await siyuanFetch("/api/search/fullTextSearchBlock", {
			query,
			page: page || 1,
			pageSize: 10,
			types: { document: true, heading: true, paragraph: true, code: true, list: true, listItem: true, blockquote: true },
			method: 0, // keyword
			orderBy: 0, // relevance
			groupBy: 0, // no grouping
		});
		const blocks = (data.blocks || []).map((b: any) => ({
			id: b.id,
			rootID: b.rootID,
			content: b.content,
			hpath: b.hPath,
			type: b.type,
		}));
		return JSON.stringify({
			blocks,
			matchedBlockCount: data.matchedBlockCount,
			matchedRootCount: data.matchedRootCount,
			pageCount: data.pageCount,
		}, null, 2);
	},
	{
		name: "search_fulltext",
		description: "Full-text search across all notebooks. Returns matching blocks with their content, path, and type. Use this to find specific information in the knowledge base.",
		schema: z.object({
			query: z.string().describe("Search keyword or phrase"),
			page: z.number().optional().describe("Page number, defaults to 1. Each page returns up to 10 results."),
		}),
	}
);

const getDocumentBlocksTool = tool(
	async ({ id }, config: ToolRuntime) => {
		const docInfo = await siyuanFetch("/api/query/sql", {
			stmt: `SELECT id, hpath FROM blocks WHERE id='${id}' LIMIT 1`,
		});
		const data = await siyuanFetch("/api/block/getChildBlocks", { id });
		const blocks = (data || []).map((b: any) => ({
			id: b.id,
			type: b.type,
			subType: b.subType || undefined,
			markdown: b.markdown || b.content || "",
		}));
		if (config.writer) {
			config.writer(JSON.stringify({
				__tool_type: "document_blocks",
				id,
				path: docInfo?.[0]?.hpath || "",
				blockCount: blocks.length,
				open: false,
			}));
		}
		return JSON.stringify(blocks, null, 2);
	},
	{
		name: "get_document_blocks",
		description: "Get all child blocks of a document with their block IDs and markdown content. Use this when you need to edit specific blocks — it returns block IDs needed for edit_blocks. Each block has: id (block ID for editing), type (h=heading, p=paragraph, c=code, l=list, etc.), markdown (block content). For large documents, prefer search_fulltext to locate specific blocks first.",
		schema: z.object({
			id: z.string().describe("Document block ID. Get this from list_documents or search results."),
		}),
	}
);

const editBlocksTool = tool(
	async ({ blocks }, config: ToolRuntime) => {
		const ids = blocks.map((b: { id: string }) => b.id);
		const originals: Record<string, string> = await siyuanFetch("/api/block/getBlockKramdowns", { ids });
		const treeInfos: Record<string, any> = await siyuanFetch("/api/block/getBlockTreeInfos", { ids });

		const results: any[] = [];

		for (const block of blocks) {
			const original = originals[block.id];
			if (original === undefined) {
				results.push({
					id: block.id,
					status: "error",
					error: `Block ${block.id} not found`,
				});
				continue;
			}

			try {
				// Use insertBlock + deleteBlock instead of updateBlock so that
				// multi-block markdown is correctly expanded into multiple blocks.
				// (updateBlock only keeps FirstChild, discarding the rest.)
				//
				// insertBlock with previousID correctly inserts ALL parsed blocks.
				// nextID has a bug in siyuan's doInsert: it only inserts FirstChild.
				// So we must use previousID. When the block has no previous sibling,
				// fall back to prependBlock (insert as first child of parent).
				const info = treeInfos[block.id];
				const previousID: string = info?.previousID ?? "";
				const parentID: string = info?.parentID ?? "";

				if (previousID) {
					await siyuanFetch("/api/block/insertBlock", {
						data: block.content,
						dataType: "markdown",
						previousID,
					});
				} else {
					await siyuanFetch("/api/block/prependBlock", {
						data: block.content,
						dataType: "markdown",
						parentID,
					});
				}
				await siyuanFetch("/api/block/deleteBlock", { id: block.id });
				results.push({
					id: block.id,
					status: "ok",
					original,
					updated: block.content,
				});
			} catch (err: any) {
				results.push({
					id: block.id,
					status: "error",
					error: err.message,
					original,
				});
			}
		}

		if (config.writer) {
			const rootIDs = [...new Set(
				ids
					.map((id) => treeInfos[id]?.rootID)
					.filter((rootID: unknown): rootID is string => typeof rootID === "string" && rootID.length > 0)
			)];
			let path = "";
			if (rootIDs.length > 0) {
				const rootDoc = await siyuanFetch("/api/query/sql", {
					stmt: `SELECT id, hpath FROM blocks WHERE id='${rootIDs[0]}' LIMIT 1`,
				});
				path = rootDoc?.[0]?.hpath || "";
			}
			config.writer(JSON.stringify({
				__tool_type: "edit_blocks",
				documentIDs: rootIDs,
				primaryDocumentID: rootIDs[0],
				path,
				editedCount: results.filter((item) => item.status === "ok").length,
				open: true,
			}));
		}

		return JSON.stringify({ __tool_type: "edit_blocks", results });
	},
	{
		name: "edit_blocks",
		description: "Edit one or more blocks by providing new markdown content. First use get_document_blocks to get block IDs and current content, then call this tool with the modified content. Changes are applied immediately. The tool returns a diff showing what changed for each block, and users can undo from the chat panel. Only modify the blocks that need changes — do not rewrite entire documents. Provide complete plain markdown content (not kramdown).",
		schema: z.object({
			blocks: z.array(z.object({
				id: z.string().describe("Block ID to edit (from get_document_blocks)"),
				content: z.string().min(1).describe("New markdown content for this block"),
			})).describe("Array of blocks to edit"),
		}),
	}
);

const appendBlockTool = tool(
	async ({ parentID, markdown }, config: ToolRuntime) => {
		const data = await siyuanFetch("/api/block/appendBlock", {
			data: markdown,
			dataType: "markdown",
			parentID,
		});
		if (config.writer) {
			const docInfo = await siyuanFetch("/api/query/sql", {
				stmt: `SELECT id, hpath FROM blocks WHERE id='${parentID}' LIMIT 1`,
			});
			const blockIDs = Array.isArray(data)
				? data.map((item: any) => item?.doOperations?.[0]?.id).filter(Boolean)
				: [];
			config.writer(JSON.stringify({
				__tool_type: "append_block",
				parentID,
				path: docInfo?.[0]?.hpath || "",
				blockIDs,
				open: true,
			}));
		}
		return JSON.stringify(data, null, 2);
	},
	{
		name: "append_block",
		description: "Append Markdown content as child blocks to an existing block (usually a document). Use this to add new content to a document.",
		schema: z.object({
			parentID: z.string().describe("The parent block ID to append content to. Usually a document ID from list_documents or search results."),
			markdown: z.string().describe("Markdown content to append"),
		}),
	}
);

/* --- Document management tools --- */

const createDocumentTool = tool(
	async ({ notebook, path, markdown }, config: ToolRuntime) => {
		const id = await siyuanFetch("/api/filetree/createDocWithMd", {
			notebook,
			path,
			markdown: markdown || "",
		});
		// Auto-open the created document
		openTab({ app: (globalThis as any).siyuanApp, doc: { id } });
		// Send structured progress event for rich UI rendering
		if (config.writer) {
			config.writer(JSON.stringify({ __tool_type: "created_document", id, path }));
		}
		return JSON.stringify({ id, notebook, path });
	},
	{
		name: "create_document",
		description: "Create a new document (note) in a notebook with optional Markdown content. The path is the human-readable path (hpath) like '/Folder/My Note'. Returns the new document's ID.",
		schema: z.object({
			notebook: z.string().describe("Notebook ID (from list_notebooks)"),
			path: z.string().describe("Human-readable path for the new document, e.g. '/Daily Notes/2024-01-01' or '/Project/Meeting Notes'"),
			markdown: z.string().optional().describe("Initial Markdown content for the document. Defaults to empty."),
		}),
	}
);

const moveDocumentTool = tool(
	async ({ fromIDs, toID }) => {
		await siyuanFetch("/api/filetree/moveDocsByID", { fromIDs, toID });
		return JSON.stringify({ ok: true, fromIDs, toID });
	},
	{
		name: "move_document",
		description: "Move one or more documents to a different location. toID can be a notebook ID (moves to notebook root) or a document ID (moves inside that document as sub-document).",
		schema: z.object({
			fromIDs: z.array(z.string()).describe("Array of document IDs to move"),
			toID: z.string().describe("Target notebook ID or parent document ID"),
		}),
	}
);

const renameDocumentTool = tool(
	async ({ id, title }) => {
		await siyuanFetch("/api/filetree/renameDocByID", { id, title });
		return JSON.stringify({ ok: true, id, title });
	},
	{
		name: "rename_document",
		description: "Rename a document by changing its title.",
		schema: z.object({
			id: z.string().describe("Document ID to rename"),
			title: z.string().describe("New title for the document"),
		}),
	}
);

// deleteDocumentTool is intentionally NOT in defaultTools (safety) — export for opt-in use
export const deleteDocumentTool = tool(
	async ({ id }) => {
		await siyuanFetch("/api/filetree/removeDocByID", { id });
		return JSON.stringify({ ok: true, id });
	},
	{
		name: "delete_document",
		description: "Permanently delete a document by its ID. This is irreversible.",
		schema: z.object({
			id: z.string().describe("Document ID to delete"),
		}),
	}
);

const searchDocumentsTool = tool(
	async ({ keyword, notebook }) => {
		const stmt = notebook
			? `SELECT id, content, hpath, box, updated FROM blocks WHERE type='d' AND box='${notebook}' AND content LIKE '%${keyword}%' ORDER BY updated DESC LIMIT 50`
			: `SELECT id, content, hpath, box, updated FROM blocks WHERE type='d' AND content LIKE '%${keyword}%' ORDER BY updated DESC LIMIT 50`;
		const data = await siyuanFetch("/api/query/sql", { stmt });
		const docs = (data || []).map((d: any) => ({
			id: d.id,
			title: d.content,
			hpath: d.hpath,
			notebook: d.box,
			updated: d.updated,
		}));
		return JSON.stringify(docs, null, 2);
	},
	{
		name: "search_documents",
		description: "Search for documents (notes) by title keyword. Returns matching document IDs, titles, paths, and notebooks. Use search_fulltext to search inside document content instead.",
		schema: z.object({
			keyword: z.string().describe("Keyword to search in document titles"),
			notebook: z.string().optional().describe("Limit search to a specific notebook ID. Omit to search all notebooks."),
		}),
	}
);

const defaultTools: StructuredToolInterface[] = [
	getWeatherTool,
	listNotebooksTool,
	listDocumentsTool,
	recentDocumentsTool,
	getDocumentTool,
	getDocumentBlocksTool,
	searchFulltextTool,
	appendBlockTool,
	editBlocksTool,
	createDocumentTool,
	moveDocumentTool,
	renameDocumentTool,
	searchDocumentsTool,
	// deleteDocumentTool is intentionally excluded for safety
];

export function getDefaultTools(): StructuredToolInterface[] {
	return defaultTools;
}
