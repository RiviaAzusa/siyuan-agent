import { tool, ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import { siyuanFetch, emitActivity, sqlEscape } from "./siyuan-api";

export const getDocumentTool = tool(
	async ({ id }, runtime: ToolRuntime) => {
		const docInfo = await siyuanFetch("/api/query/sql", {
			stmt: `SELECT id, content, hpath FROM blocks WHERE id='${sqlEscape(id)}' LIMIT 1`,
		});
		const data = await siyuanFetch("/api/export/exportMdContent", { id });
		const hpath = data.hPath || "";
		const content = data.content || "";
		const label = docInfo?.[0]?.content || hpath || id;
		emitActivity(runtime, {
			category: "lookup",
			action: "read",
			id,
			path: hpath,
			label,
			meta: "已读取文档",
			open: true,
		});
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

export const getDocumentBlocksTool = tool(
	async ({ id }, runtime: ToolRuntime) => {
		const docInfo = await siyuanFetch("/api/query/sql", {
			stmt: `SELECT id, hpath FROM blocks WHERE id='${sqlEscape(id)}' LIMIT 1`,
		});
		const data = await siyuanFetch("/api/block/getChildBlocks", { id });
		const blocks = (data || []).map((b: any) => ({
			id: b.id,
			type: b.type,
			subType: b.subType || undefined,
			markdown: b.markdown || b.content || "",
		}));
		emitActivity(runtime, {
			category: "lookup",
			action: "read",
			id,
			path: docInfo?.[0]?.hpath || "",
			label: docInfo?.[0]?.hpath || id,
			meta: `已读取 ${blocks.length} 个块`,
			open: true,
		});
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

export const getDocumentOutlineTool = tool(
	async ({ id }, runtime: ToolRuntime) => {
		const stmt = `SELECT id, content, subtype, sort FROM blocks WHERE root_id='${sqlEscape(id)}' AND type='h' ORDER BY sort ASC LIMIT 200`;
		const data = await siyuanFetch("/api/query/sql", { stmt });
		const headings = (data || []).map((row: any) => ({
			id: row.id,
			title: row.content,
			level: parseInt(row.subtype?.replace("h", "") || "1", 10),
		}));
		emitActivity(runtime, {
			category: "lookup",
			action: "read",
			id,
			label: `文档大纲 (${headings.length} 个标题)`,
		});
		return JSON.stringify(headings, null, 2);
	},
	{
		name: "get_document_outline",
		description: "Get the heading outline (table of contents) of a document. Returns all headings with their IDs, titles, and levels. Useful for understanding document structure before reading or editing specific sections.",
		schema: z.object({
			id: z.string().describe("Document ID to get outline for"),
		}),
	}
);

export const readBlockTool = tool(
	async ({ id }, runtime: ToolRuntime) => {
		const kramdowns: Record<string, string> = await siyuanFetch("/api/block/getBlockKramdowns", { ids: [id] });
		const content = kramdowns?.[id];
		if (!content) {
			return JSON.stringify({ error: `Block ${id} not found` });
		}
		const blockInfo = await siyuanFetch("/api/query/sql", {
			stmt: `SELECT id, type, subtype, root_id, parent_id, content, hpath FROM blocks WHERE id='${sqlEscape(id)}' LIMIT 1`,
		});
		const info = blockInfo?.[0] || {};
		emitActivity(runtime, {
			category: "lookup",
			action: "read",
			id,
			label: info.content?.slice(0, 50) || id,
		});
		return JSON.stringify({
			id,
			type: info.type,
			subType: info.subtype,
			rootDocId: info.root_id,
			hpath: info.hpath,
			kramdown: content,
		}, null, 2);
	},
	{
		name: "read_block",
		description: "Read a single block's content by ID. Returns the block's kramdown content, type, and location. Useful for reading specific blocks found via search or after getting an outline.",
		schema: z.object({
			id: z.string().describe("Block ID to read"),
		}),
	}
);

export const searchFulltextTool = tool(
	async ({ query, page }, runtime: ToolRuntime) => {
		const data = await siyuanFetch("/api/search/fullTextSearchBlock", {
			query,
			page: page || 1,
			pageSize: 10,
			types: { document: true, heading: true, paragraph: true, code: true, list: true, listItem: true, blockquote: true },
			method: 0,
			orderBy: 0,
			groupBy: 0,
		});
		const blocks = (data.blocks || []).map((b: any) => ({
			id: b.id,
			rootID: b.rootID,
			content: b.content,
			hpath: b.hPath,
			type: b.type,
		}));
		emitActivity(runtime, {
			category: "lookup",
			action: "search",
			label: query,
			meta: `命中 ${data.matchedBlockCount || blocks.length || 0} 个块`,
		});
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

export const searchDocumentsTool = tool(
	async ({ keyword, notebook }, runtime: ToolRuntime) => {
		const safeKeyword = sqlEscape(keyword);
		const stmt = notebook
			? `SELECT id, content, hpath, box, updated FROM blocks WHERE type='d' AND box='${sqlEscape(notebook)}' AND content LIKE '%${safeKeyword}%' ORDER BY updated DESC LIMIT 50`
			: `SELECT id, content, hpath, box, updated FROM blocks WHERE type='d' AND content LIKE '%${safeKeyword}%' ORDER BY updated DESC LIMIT 50`;
		const data = await siyuanFetch("/api/query/sql", { stmt });
		const docs = (data || []).map((d: any) => ({
			id: d.id,
			title: d.content,
			hpath: d.hpath,
			notebook: d.box,
			updated: d.updated,
		}));
		emitActivity(runtime, {
			category: "lookup",
			action: "search",
			label: keyword,
			meta: `命中 ${docs.length} 篇文档`,
		});
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
