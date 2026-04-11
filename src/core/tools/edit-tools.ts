import { tool, ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import { openTab } from "siyuan";
import { siyuanFetch, emitActivity, sqlEscape } from "./siyuan-api";

export const editBlocksTool = tool(
	async ({ blocks }, runtime: ToolRuntime) => {
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

		if (runtime.writer) {
			const rootIDs = [...new Set(
				ids
					.map((id) => treeInfos[id]?.rootID)
					.filter((rootID: unknown): rootID is string => typeof rootID === "string" && rootID.length > 0)
			)];
			let path = "";
			if (rootIDs.length > 0) {
				const rootDoc = await siyuanFetch("/api/query/sql", {
					stmt: `SELECT id, hpath FROM blocks WHERE id='${sqlEscape(rootIDs[0])}' LIMIT 1`,
				});
				path = rootDoc?.[0]?.hpath || "";
			}
			emitActivity(runtime, {
				category: "change",
				action: "edit",
				id: rootIDs[0],
				path,
				label: path || rootIDs[0],
				meta: `已编辑 ${results.filter((item) => item.status === "ok").length} 个块`,
				open: true,
			});
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

export const appendBlockTool = tool(
	async ({ parentID, markdown }, runtime: ToolRuntime) => {
		const data = await siyuanFetch("/api/block/appendBlock", {
			data: markdown,
			dataType: "markdown",
			parentID,
		});
		const docInfo = await siyuanFetch("/api/query/sql", {
			stmt: `SELECT id, hpath FROM blocks WHERE id='${sqlEscape(parentID)}' LIMIT 1`,
		});
		const blockIDs = Array.isArray(data)
			? data.map((item: any) => item?.doOperations?.[0]?.id).filter(Boolean)
			: [];
		emitActivity(runtime, {
			category: "change",
			action: "append",
			id: parentID,
			path: docInfo?.[0]?.hpath || "",
			label: docInfo?.[0]?.hpath || parentID,
			meta: `已追加 ${blockIDs.length || 0} 个块`,
			open: true,
		});
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

export const createDocumentTool = tool(
	async ({ notebook, path, markdown }, runtime: ToolRuntime) => {
		const id = await siyuanFetch("/api/filetree/createDocWithMd", {
			notebook,
			path,
			markdown: markdown || "",
		});
		openTab({ app: (globalThis as any).siyuanApp, doc: { id } });
		emitActivity(runtime, {
			category: "change",
			action: "create",
			id,
			path,
			label: path,
			meta: "已创建文档",
			open: true,
		});
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

export const moveDocumentTool = tool(
	async ({ fromIDs, toID }, runtime: ToolRuntime) => {
		await siyuanFetch("/api/filetree/moveDocsByID", { fromIDs, toID });
		emitActivity(runtime, {
			category: "change",
			action: "move",
			id: fromIDs[0],
			label: fromIDs.length > 1 ? `${fromIDs[0]} 等 ${fromIDs.length} 个文档` : fromIDs[0],
			meta: `已移动到 ${toID}`,
		});
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

export const renameDocumentTool = tool(
	async ({ id, title }, runtime: ToolRuntime) => {
		await siyuanFetch("/api/filetree/renameDocByID", { id, title });
		emitActivity(runtime, {
			category: "change",
			action: "rename",
			id,
			label: title,
			meta: "已重命名文档",
			open: true,
		});
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
