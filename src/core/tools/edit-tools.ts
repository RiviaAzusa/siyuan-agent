import { createTool } from "../tool-types";
import { z } from "zod";
import { openTab } from "siyuan";
import { siyuanFetch } from "./siyuan-api";
import { TOOL_DESC } from "../../types";
import { defaultTranslator, type Translator } from "../../i18n";
import { stripSiyuanBlockAttrs } from "../siyuan-markdown";

function extractOperationBlockIds(data: any): string[] {
	if (!Array.isArray(data)) return [];
	const ids: string[] = [];
	for (const item of data) {
		const operations = Array.isArray(item?.doOperations) ? item.doOperations : [];
		for (const operation of operations) {
			if (typeof operation?.id === "string" && operation.id) {
				ids.push(operation.id);
			}
		}
	}
	return ids;
}

function isConservativeSingleMarkdownBlock(markdown: string): boolean {
	const trimmed = markdown.trim();
	if (!trimmed) return false;
	if (trimmed.includes("\n\n")) return false;
	if (/^```|^~~~/.test(trimmed)) return false;
	return true;
}

function getRootDocId(info: any): string | undefined {
	if (typeof info?.rootID === "string" && info.rootID) return info.rootID;
	if (typeof info?.root_id === "string" && info.root_id) return info.root_id;
	return undefined;
}

function resolveRootDocId(blockId: string, treeInfos: Record<string, any>): string | undefined {
	return getRootDocId(treeInfos[blockId]);
}

function displayOriginal(original: string | undefined): string | undefined {
	return typeof original === "string" ? stripSiyuanBlockAttrs(original) : original;
}

export function createEditBlocksTool(i18n: Translator = defaultTranslator) {
	const desc = TOOL_DESC.edit_blocks;
	return createTool({
		name: "edit_blocks",
		category: "change",
		description: desc.description,
		parameters: z.object({
			blocks: z.array(z.object({
				id: z.string().describe(desc.params["blocks[].id"]),
				content: z.string().min(1).describe(desc.params["blocks[].content"]),
			})).describe(desc.params.blocks),
		}),
		async execute({ blocks }) {
			const ids = blocks.map((b: { id: string }) => b.id);
			const originals: Record<string, string> = await siyuanFetch("/api/block/getBlockKramdowns", { ids });
			const treeInfos: Record<string, any> = await siyuanFetch("/api/block/getBlockTreeInfos", { ids });
			const results: any[] = [];
			const existingRootDocIds = [...new Set(blocks
				.filter((block: { id: string }) => originals[block.id] !== undefined)
				.map((block: { id: string }) => resolveRootDocId(block.id, treeInfos))
				.filter((id: string | undefined): id is string => id !== undefined))];
			if (existingRootDocIds.length > 1) {
				return JSON.stringify({
					__tool_type: "edit_blocks",
					results: blocks.map((block: { id: string }) => ({
						oldId: block.id,
						rootDocId: resolveRootDocId(block.id, treeInfos),
						status: "error",
						error: `edit_blocks cannot edit blocks across multiple documents in one call. Split this into separate calls per document. Root document IDs: ${existingRootDocIds.join(", ")}`,
						original: displayOriginal(originals[block.id]),
					})),
				});
			}
			const editableBlocks = blocks.filter((block: { id: string; content: string }) => originals[block.id] !== undefined);
			const canBatchUpdate = editableBlocks.length === blocks.length
				&& blocks.length > 1
				&& editableBlocks.every((block: { content: string }) => isConservativeSingleMarkdownBlock(block.content));

			if (canBatchUpdate) {
				try {
					await siyuanFetch("/api/block/batchUpdateBlock", {
						blocks: blocks.map((block: { id: string; content: string }) => ({
							id: block.id,
							data: block.content,
							dataType: "markdown",
						})),
					});
					return JSON.stringify({
						__tool_type: "edit_blocks",
						results: blocks.map((block: { id: string; content: string }) => ({
							oldId: block.id,
							newIds: [block.id],
							rootDocId: resolveRootDocId(block.id, treeInfos),
							status: "ok",
							original: displayOriginal(originals[block.id]),
							updated: block.content,
						})),
					});
				} catch (err: any) {
					return JSON.stringify({
						__tool_type: "edit_blocks",
						results: blocks.map((block: { id: string; content: string }) => ({
							oldId: block.id,
							rootDocId: resolveRootDocId(block.id, treeInfos),
							status: "error",
							error: err.message,
							original: displayOriginal(originals[block.id]),
						})),
					});
				}
			}

			for (const block of blocks) {
				const original = originals[block.id];
				const info = treeInfos[block.id];
				const rootDocId: string | undefined = resolveRootDocId(block.id, treeInfos);
				if (original === undefined) {
					results.push({
						oldId: block.id,
						rootDocId,
						status: "error",
						error: i18n.t("tool.error.blockNotFound", { id: block.id }),
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
					const previousID: string = info?.previousID ?? "";
					const parentID: string = info?.parentID ?? "";
					let insertResult: any;

					if (previousID) {
						insertResult = await siyuanFetch("/api/block/insertBlock", {
							data: block.content,
							dataType: "markdown",
							previousID,
						});
					} else {
						insertResult = await siyuanFetch("/api/block/prependBlock", {
							data: block.content,
							dataType: "markdown",
							parentID,
						});
					}
					const newIds = extractOperationBlockIds(insertResult);
					await siyuanFetch("/api/block/deleteBlock", { id: block.id });
					results.push({
						oldId: block.id,
						newIds,
						rootDocId,
						status: "ok",
						original: displayOriginal(original),
						updated: block.content,
					});
				} catch (err: any) {
					results.push({
						oldId: block.id,
						rootDocId,
						status: "error",
						error: err.message,
						original: displayOriginal(original),
					});
				}
			}

			return JSON.stringify({ __tool_type: "edit_blocks", results });
		},
	});
}

export function createAppendBlockTool(i18n: Translator = defaultTranslator) {
	const desc = TOOL_DESC.append_block;
	return createTool({
		name: "append_block",
		category: "change",
		description: desc.description,
		parameters: z.object({
			parentID: z.string().describe(desc.params.parentID),
			markdown: z.string().describe(desc.params.markdown),
		}),
		async execute({ parentID, markdown }) {
			const data = await siyuanFetch("/api/block/appendBlock", {
				data: markdown,
				dataType: "markdown",
				parentID,
			});
			return JSON.stringify(data, null, 2);
		},
	});
}

export function createCreateDocumentTool(i18n: Translator = defaultTranslator) {
	const desc = TOOL_DESC.create_document;
	return createTool({
		name: "create_document",
		category: "change",
		description: desc.description,
		parameters: z.object({
			notebook: z.string().describe(desc.params.notebook),
			path: z.string().describe(desc.params.path),
			markdown: z.string().optional().describe(desc.params.markdown),
		}),
		async execute({ notebook, path, markdown }) {
			const id = await siyuanFetch("/api/filetree/createDocWithMd", {
				notebook,
				path,
				markdown: markdown || "",
			});
			openTab({ app: (globalThis as any).siyuanApp, doc: { id } });
			return JSON.stringify({ id, notebook, path });
		},
	});
}

export function createMoveDocumentTool(i18n: Translator = defaultTranslator) {
	const desc = TOOL_DESC.move_document;
	return createTool({
		name: "move_document",
		category: "change",
		description: desc.description,
		parameters: z.object({
			fromIDs: z.array(z.string()).describe(desc.params.fromIDs),
			toID: z.string().describe(desc.params.toID),
		}),
		async execute({ fromIDs, toID }) {
			await siyuanFetch("/api/filetree/moveDocsByID", { fromIDs, toID });
			return JSON.stringify({ ok: true, fromIDs, toID });
		},
	});
}

export function createRenameDocumentTool(i18n: Translator = defaultTranslator) {
	const desc = TOOL_DESC.rename_document;
	return createTool({
		name: "rename_document",
		category: "change",
		description: desc.description,
		parameters: z.object({
			id: z.string().describe(desc.params.id),
			title: z.string().describe(desc.params.title),
		}),
		async execute({ id, title }) {
			await siyuanFetch("/api/filetree/renameDocByID", { id, title });
			return JSON.stringify({ ok: true, id, title });
		},
	});
}

// deleteDocumentTool is intentionally NOT in defaultTools (safety) — export for opt-in use
export const deleteDocumentTool = createTool({
	name: "delete_document",
	category: "change",
	description: TOOL_DESC.delete_document.description,
	parameters: z.object({
		id: z.string().describe(TOOL_DESC.delete_document.params.id),
	}),
	async execute({ id }) {
		await siyuanFetch("/api/filetree/removeDocByID", { id });
		return JSON.stringify({ ok: true, id });
	},
});

export const editBlocksTool = createEditBlocksTool();
export const appendBlockTool = createAppendBlockTool();
export const createDocumentTool = createCreateDocumentTool();
export const moveDocumentTool = createMoveDocumentTool();
export const renameDocumentTool = createRenameDocumentTool();
