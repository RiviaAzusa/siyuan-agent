import { createTool } from "../tool-types";
import { z } from "zod";
import { siyuanFetch, sqlEscape } from "./siyuan-api";
import { TOOL_DESC } from "../../types";
import { defaultTranslator, type Translator } from "../../i18n";

export function createGetDocumentTool(i18n: Translator = defaultTranslator) {
	const desc = TOOL_DESC.get_document;
	return createTool({
		name: "get_document",
		description: desc.description,
		parameters: z.object({
			id: z.string().describe(desc.params.id),
		}),
		async execute({ id }) {
			const data = await siyuanFetch("/api/export/exportMdContent", { id });
			const hpath = data.hPath || "";
			const content = data.content || "";
			return `# ${hpath}\n\n${content}`;
		},
	});
}

export function createGetDocumentBlocksTool(i18n: Translator = defaultTranslator) {
	const desc = TOOL_DESC.get_document_blocks;
	return createTool({
		name: "get_document_blocks",
		description: desc.description,
		parameters: z.object({
			id: z.string().describe(desc.params.id),
		}),
		async execute({ id }) {
			const data = await siyuanFetch("/api/block/getChildBlocks", { id });
			const blocks = (data || []).map((b: any) => ({
				id: b.id,
				type: b.type,
				subType: b.subType || undefined,
				markdown: b.markdown || b.content || "",
			}));
			return JSON.stringify(blocks, null, 2);
		},
	});
}

export function createGetDocumentOutlineTool(i18n: Translator = defaultTranslator) {
	const desc = TOOL_DESC.get_document_outline;
	return createTool({
		name: "get_document_outline",
		description: desc.description,
		parameters: z.object({
			id: z.string().describe(desc.params.id),
		}),
		async execute({ id }) {
			const stmt = `SELECT id, content, subtype, sort FROM blocks WHERE root_id='${sqlEscape(id)}' AND type='h' ORDER BY sort ASC LIMIT 200`;
			const data = await siyuanFetch("/api/query/sql", { stmt });
			const headings = (data || []).map((row: any) => ({
				id: row.id,
				title: row.content,
				level: parseInt(row.subtype?.replace("h", "") || "1", 10),
			}));
			return JSON.stringify(headings, null, 2);
		},
	});
}

export function createReadBlockTool(i18n: Translator = defaultTranslator) {
	const desc = TOOL_DESC.read_block;
	return createTool({
		name: "read_block",
		description: desc.description,
		parameters: z.object({
			id: z.string().describe(desc.params.id),
		}),
		async execute({ id }) {
			const kramdowns: Record<string, string> = await siyuanFetch("/api/block/getBlockKramdowns", { ids: [id] });
			const content = kramdowns?.[id];
			if (!content) {
				return JSON.stringify({ error: i18n.t("tool.error.blockNotFound", { id }) });
			}
			const blockInfo = await siyuanFetch("/api/query/sql", {
				stmt: `SELECT id, type, subtype, root_id, parent_id, content, hpath FROM blocks WHERE id='${sqlEscape(id)}' LIMIT 1`,
			});
			const info = blockInfo?.[0] || {};
			return JSON.stringify({
				id,
				type: info.type,
				subType: info.subtype,
				rootDocId: info.root_id,
				hpath: info.hpath,
				kramdown: content,
			}, null, 2);
		},
	});
}

export function createSearchFulltextTool(i18n: Translator = defaultTranslator) {
	const desc = TOOL_DESC.search_fulltext;
	return createTool({
		name: "search_fulltext",
		description: desc.description,
		parameters: z.object({
			query: z.string().describe(desc.params.query),
			page: z.number().optional().describe(desc.params.page),
		}),
		async execute({ query, page }) {
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
			return JSON.stringify({
				blocks,
				matchedBlockCount: data.matchedBlockCount,
				matchedRootCount: data.matchedRootCount,
				pageCount: data.pageCount,
			}, null, 2);
		},
	});
}

export function createSearchDocumentsTool(i18n: Translator = defaultTranslator) {
	const desc = TOOL_DESC.search_documents;
	return createTool({
		name: "search_documents",
		description: desc.description,
		parameters: z.object({
			keyword: z.string().describe(desc.params.keyword),
			notebook: z.string().optional().describe(desc.params.notebook),
		}),
		async execute({ keyword, notebook }) {
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
			return JSON.stringify(docs, null, 2);
		},
	});
}

export const getDocumentTool = createGetDocumentTool();
export const getDocumentBlocksTool = createGetDocumentBlocksTool();
export const getDocumentOutlineTool = createGetDocumentOutlineTool();
export const readBlockTool = createReadBlockTool();
export const searchFulltextTool = createSearchFulltextTool();
export const searchDocumentsTool = createSearchDocumentsTool();
