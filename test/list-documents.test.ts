import { describe, expect, it } from "vitest";
import {
	extractDocumentSummary,
	listDocumentsViaApi,
	type SiyuanApiFetcher,
	unixSecondsToSiyuanTimestamp,
} from "../src/core/list-documents";

function createFetcher(handlers: Record<string, (data: any) => any>) {
	const calls: Array<{ url: string; data: any }> = [];

	const fetcher: SiyuanApiFetcher = async (url, data) => {
		calls.push({ url, data });
		const handler = handlers[url];
		if (!handler) {
			throw new Error(`Unhandled API: ${url}`);
		}
		return handler(data);
	};

	return { fetcher, calls };
}

describe("extractDocumentSummary", () => {
	it("prefers h1 headings, then h2 headings, then body lines", () => {
		expect(extractDocumentSummary("# Alpha\n\n# Beta\n\nText")).toBe("Alpha / Beta");
		expect(extractDocumentSummary("## Context\n\n## Todo")).toBe("Context / Todo");
		expect(extractDocumentSummary("First line\n\n- second line")).toBe("First line / second line");
	});
});

describe("listDocumentsViaApi", () => {
	it("returns paginated root results with summaries", async () => {
		const { fetcher } = createFetcher({
			"/api/filetree/listDocsByPath": (data) => {
				expect(data.notebook).toBe("nb1");
				expect(data.path).toBe("/");
				expect(data.maxListCount).toBe(0);
				return {
					files: [
						{ id: "doc1", name: "Alpha.sy", path: "/doc1.sy", mtime: 1710000000, subFileCount: 1 },
						{ id: "doc2", name: "Beta.sy", path: "/doc2.sy", mtime: 1710000600, subFileCount: 0 },
						{ id: "doc3", name: "Gamma.sy", path: "/doc3.sy", mtime: 1710001200, subFileCount: 0 },
					],
				};
			},
			"/api/filetree/getHPathByID": ({ id }) => ({
				doc1: "/Alpha",
				doc2: "/Beta",
				doc3: "/Gamma",
			}[id]),
			"/api/export/exportMdContent": ({ id }) => ({
				doc1: { content: "# Overview\n\n# Plan" },
				doc2: { content: "## Context\n\n## Todo" },
				doc3: { content: "First paragraph\n\nSecond paragraph" },
			}[id]),
		});

		const result = await listDocumentsViaApi({ notebook: "nb1", page_size: 2 }, fetcher);

		expect(result).toMatchObject({
			notebook: "nb1",
			path: "/",
			page: 1,
			pageSize: 2,
			depth: 0,
			total: 3,
			hasMore: true,
			truncated: true,
			pathMatchCount: 1,
		});
		expect(result.items).toHaveLength(2);
		expect(result.items[0]).toMatchObject({
			id: "doc1",
			title: "Alpha",
			hpath: "/Alpha",
			summary: "Overview / Plan",
			hasChildren: true,
			childCount: 1,
			updated: unixSecondsToSiyuanTimestamp(1710000000),
		});
		expect(result.items[1]).toMatchObject({
			id: "doc2",
			title: "Beta",
			hpath: "/Beta",
			summary: "Context / Todo",
			hasChildren: false,
			childCount: 0,
			updated: unixSecondsToSiyuanTimestamp(1710000600),
		});
	});

	it("resolves hpath to filetree path and expands one child level", async () => {
		const { fetcher } = createFetcher({
			"/api/filetree/getIDsByHPath": ({ path, notebook }) => {
				expect(path).toBe("/AgentTest/测试归档");
				expect(notebook).toBe("nb1");
				return ["folder1"];
			},
			"/api/filetree/getPathByID": ({ id }) => {
				expect(id).toBe("folder1");
				return { notebook: "nb1", path: "/root/folder1.sy" };
			},
			"/api/filetree/listDocsByPath": ({ path, maxListCount }) => {
				if ("/root/folder1" === path) {
					expect(maxListCount).toBe(0);
					return {
						files: [
							{ id: "doc-child-parent", name: "Parent.sy", path: "/root/folder1/doc-child-parent.sy", mtime: 1711000000, subFileCount: 2 },
						],
					};
				}
				if ("/root/folder1/doc-child-parent" === path) {
					expect(maxListCount).toBe(1);
					return {
						files: [
							{ id: "doc-child-1", name: "Child 1.sy", path: "/root/folder1/doc-child-parent/doc-child-1.sy", mtime: 1711000100, subFileCount: 0 },
						],
					};
				}
				throw new Error(`Unexpected path ${path}`);
			},
			"/api/filetree/getHPathByID": ({ id }) => ({
				"doc-child-parent": "/AgentTest/测试归档/Parent",
				"doc-child-1": "/AgentTest/测试归档/Parent/Child 1",
			}[id]),
			"/api/export/exportMdContent": ({ id }) => ({
				"doc-child-parent": { content: "# Parent heading" },
				"doc-child-1": { content: "## Child heading" },
			}[id]),
		});

		const result = await listDocumentsViaApi({
			notebook: "nb1",
			path: "/AgentTest/测试归档",
			depth: 1,
			child_limit: 1,
		}, fetcher);

		expect(result.total).toBe(1);
		expect(result.hasMore).toBe(false);
		expect(result.truncated).toBe(true);
		expect(result.items[0]).toMatchObject({
			id: "doc-child-parent",
			hpath: "/AgentTest/测试归档/Parent",
			summary: "Parent heading",
			hasChildren: true,
			childCount: 2,
		});
		expect(result.items[0].children).toEqual([
			expect.objectContaining({
				id: "doc-child-1",
				hpath: "/AgentTest/测试归档/Parent/Child 1",
				summary: "Child heading",
			}),
		]);
	});

	it("skips summary requests when include_summary is false", async () => {
		const { fetcher, calls } = createFetcher({
			"/api/filetree/listDocsByPath": () => ({
				files: [
					{ id: "doc1", name: "Alpha.sy", path: "/doc1.sy", mtime: 1710000000, subFileCount: 0 },
				],
			}),
			"/api/filetree/getHPathByID": () => "/Alpha",
		});

		const result = await listDocumentsViaApi({
			notebook: "nb1",
			include_summary: false,
		}, fetcher);

		expect(result.items[0].summary).toBeUndefined();
		expect(calls.some((call) => "/api/export/exportMdContent" === call.url)).toBe(false);
	});

	it("returns stable empty results for missing hpath and merges duplicate path matches", async () => {
		const missing = createFetcher({
			"/api/filetree/getIDsByHPath": () => [],
		});

		const missingResult = await listDocumentsViaApi({
			notebook: "nb1",
			path: "/does/not/exist",
		}, missing.fetcher);

		expect(missingResult).toMatchObject({
			total: 0,
			hasMore: false,
			items: [],
			truncated: false,
			pathMatchCount: 0,
		});

		const duplicate = createFetcher({
			"/api/filetree/getIDsByHPath": () => ["dup1", "dup2"],
			"/api/filetree/getPathByID": ({ id }) => ({
				notebook: "nb1",
				path: "dup1" === id ? "/root/dup1.sy" : "/root/dup2.sy",
			}),
			"/api/filetree/listDocsByPath": ({ path }) => ({
				files: "/root/dup1" === path
					? [
						{ id: "docA", name: "Shared.sy", path: "/root/dup1/docA.sy", mtime: 1712000000, subFileCount: 0 },
						{ id: "docB", name: "Only1.sy", path: "/root/dup1/docB.sy", mtime: 1712000100, subFileCount: 0 },
					]
					: [
						{ id: "docA", name: "Shared.sy", path: "/root/dup2/docA.sy", mtime: 1712000000, subFileCount: 0 },
						{ id: "docC", name: "Only2.sy", path: "/root/dup2/docC.sy", mtime: 1712000200, subFileCount: 0 },
					],
			}),
			"/api/filetree/getHPathByID": ({ id }) => `/${id}`,
			"/api/export/exportMdContent": ({ id }) => ({ content: `# ${id}` }),
		});

		const duplicateResult = await listDocumentsViaApi({
			notebook: "nb1",
			path: "/dup",
		}, duplicate.fetcher);

		expect(duplicateResult.pathMatchCount).toBe(2);
		expect(duplicateResult.truncated).toBe(true);
		expect(duplicateResult.total).toBe(3);
		expect(duplicateResult.items.map((item) => item.id)).toEqual(["docA", "docB", "docC"]);
	});
});
