import { describe, expect, it } from "vitest";
import { recentDocumentsViaApi } from "../src/core/recent-documents";
import type { SiyuanApiFetcher } from "../src/core/list-documents";

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

describe("recentDocumentsViaApi", () => {
	it("queries only recent document ids, then builds summaries from document content", async () => {
		const { fetcher } = createFetcher({
			"/api/query/sql": ({ stmt }) => {
				expect(stmt).toBe("SELECT id FROM blocks WHERE type = 'd' ORDER BY updated DESC LIMIT 10");
				return [
					{ id: "doc2" },
					{ id: "doc1" },
				];
			},
			"/api/export/exportMdContent": ({ id }) => ({
				doc1: { hPath: "/Alpha", content: "# Overview\n\n# Plan" },
				doc2: { hPath: "/Projects/Beta", content: "## Context\n\n## Todo" },
			}[id]),
		});

		const result = await recentDocumentsViaApi({}, fetcher);

		expect(result).toEqual({
			limit: 10,
			total: 2,
			items: [
				{
					id: "doc2",
					title: "Beta",
					hpath: "/Projects/Beta",
					summary: "Context / Todo",
				},
				{
					id: "doc1",
					title: "Alpha",
					hpath: "/Alpha",
					summary: "Overview / Plan",
				},
			],
		});
	});

	it("clamps the requested limit and tolerates empty hpath/content", async () => {
		const { fetcher } = createFetcher({
			"/api/query/sql": ({ stmt }) => {
				expect(stmt).toBe("SELECT id FROM blocks WHERE type = 'd' ORDER BY updated DESC LIMIT 20");
				return [{ id: "doc1" }];
			},
			"/api/export/exportMdContent": () => ({ hPath: "", content: "" }),
		});

		const result = await recentDocumentsViaApi({ limit: 999 }, fetcher);

		expect(result).toEqual({
			limit: 20,
			total: 1,
			items: [
				{
					id: "doc1",
					title: "doc1",
					hpath: "",
				},
			],
		});
	});

	it("ignores malformed SQL rows", async () => {
		const { fetcher, calls } = createFetcher({
			"/api/query/sql": () => [
				{ id: "doc1" },
				{ nope: true },
				null,
			],
			"/api/export/exportMdContent": () => ({ hPath: "/Alpha", content: "First line" }),
		});

		const result = await recentDocumentsViaApi({ limit: 1 }, fetcher);

		expect(result.total).toBe(1);
		expect(result.items[0]).toEqual({
			id: "doc1",
			title: "Alpha",
			hpath: "/Alpha",
			summary: "First line",
		});
		expect(calls.filter((call) => "/api/export/exportMdContent" === call.url)).toHaveLength(1);
	});
});
