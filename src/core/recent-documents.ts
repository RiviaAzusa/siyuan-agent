import { extractDocumentSummary, type SiyuanApiFetcher } from "./list-documents";

export interface RecentDocumentsInput {
	limit?: number;
}

export interface RecentDocumentsItem {
	id: string;
	title: string;
	hpath: string;
	summary?: string;
}

export interface RecentDocumentsResult {
	limit: number;
	total: number;
	items: RecentDocumentsItem[];
}

interface RecentDocumentIdRow {
	id: string;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.floor(value as number)));
}

function isRecentDocumentIdRow(value: any): value is RecentDocumentIdRow {
	return "string" === typeof value?.id && value.id.length > 0;
}

function buildRecentDocumentsSql(limit: number): string {
	return [
		"SELECT id",
		"FROM blocks",
		"WHERE type = 'd'",
		"ORDER BY updated DESC",
		`LIMIT ${limit}`,
	].join(" ");
}

function getTitleFromHPath(hpath: string, fallbackId: string): string {
	const trimmed = hpath.trim();
	if (!trimmed) {
		return fallbackId;
	}

	const segments = trimmed.split("/").filter(Boolean);
	return segments[segments.length - 1] || fallbackId;
}

async function fetchRecentDocumentItem(
	id: string,
	fetcher: SiyuanApiFetcher,
): Promise<RecentDocumentsItem> {
	const data = await fetcher("/api/export/exportMdContent", { id });
	const hpath = "string" === typeof data?.hPath ? data.hPath : "";
	const content = "string" === typeof data?.content ? data.content : "";
	const item: RecentDocumentsItem = {
		id,
		title: getTitleFromHPath(hpath, id),
		hpath,
	};

	const summary = extractDocumentSummary(content);
	if (summary) {
		item.summary = summary;
	}

	return item;
}

export async function recentDocumentsViaApi(
	input: RecentDocumentsInput,
	fetcher: SiyuanApiFetcher,
): Promise<RecentDocumentsResult> {
	const limit = clampInteger(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
	const stmt = buildRecentDocumentsSql(limit);
	const data = await fetcher("/api/query/sql", { stmt });
	const rows = Array.isArray(data) ? data.filter(isRecentDocumentIdRow) : [];
	const items = await Promise.all(rows.map((row) => fetchRecentDocumentItem(row.id, fetcher)));

	return {
		limit,
		total: items.length,
		items,
	};
}
