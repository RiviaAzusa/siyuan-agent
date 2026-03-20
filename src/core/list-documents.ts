export type SiyuanApiFetcher = (url: string, data: unknown) => Promise<any>;

export interface ListDocumentsInput {
	notebook: string;
	path?: string;
	depth?: number;
	page?: number;
	page_size?: number;
	child_limit?: number;
	include_summary?: boolean;
}

export interface ListDocumentsItem {
	id: string;
	title: string;
	hpath: string;
	updated: string;
	summary?: string;
	hasChildren: boolean;
	childCount: number;
	children?: ListDocumentsItem[];
}

export interface ListDocumentsResult {
	notebook: string;
	path: string;
	page: number;
	pageSize: number;
	depth: number;
	total: number;
	hasMore: boolean;
	items: ListDocumentsItem[];
	truncated: boolean;
	pathMatchCount: number;
}

interface SiyuanDocFile {
	id: string;
	name: string;
	path: string;
	mtime: number;
	subFileCount: number;
}

interface PathResolution {
	resolvedPaths: string[];
	pathMatchCount: number;
}

interface BuildNodeOptions {
	notebook: string;
	depth: number;
	childLimit: number;
	includeSummary: boolean;
	fetcher: SiyuanApiFetcher;
	parentHPath: string;
}

interface BuiltNode {
	item: ListDocumentsItem;
	truncated: boolean;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const DEFAULT_CHILD_LIMIT = 5;
const MAX_CHILD_LIMIT = 20;
const DEFAULT_DEPTH = 0;
const MAX_DEPTH = 5;
const SUMMARY_MAX_LENGTH = 120;
const REQUEST_CONCURRENCY = 4;

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.floor(value as number)));
}

export function normalizeHPath(path?: string): string {
	const trimmed = path?.trim();
	if (!trimmed || "/" === trimmed) {
		return "/";
	}

	let normalized = trimmed;
	if (!normalized.startsWith("/")) {
		normalized = `/${normalized}`;
	}
	normalized = normalized.replace(/\/{2,}/g, "/");
	if (normalized.length > 1) {
		normalized = normalized.replace(/\/+$/, "");
	}
	return normalized || "/";
}

function stripDocSuffix(name: string): string {
	return name.endsWith(".sy") ? name.slice(0, -3) : name;
}

function toChildrenPath(filePath: string): string {
	if (!filePath) {
		return "/";
	}
	const trimmed = filePath.trim();
	if (!trimmed) {
		return "/";
	}
	return trimmed.endsWith(".sy") ? trimmed.slice(0, -3) : trimmed;
}

function joinHPath(parentHPath: string, title: string): string {
	if (!title) {
		return normalizeHPath(parentHPath);
	}
	const normalizedParent = normalizeHPath(parentHPath);
	return "/" === normalizedParent ? `/${title}` : `${normalizedParent}/${title}`;
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

export function unixSecondsToSiyuanTimestamp(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) {
		return "";
	}

	const date = new Date(seconds * 1000);
	if (Number.isNaN(date.getTime())) {
		return "";
	}

	return [
		date.getFullYear(),
		pad2(date.getMonth() + 1),
		pad2(date.getDate()),
		pad2(date.getHours()),
		pad2(date.getMinutes()),
		pad2(date.getSeconds()),
	].join("");
}

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function cleanSummaryText(text: string): string {
	return text
		.replace(/!\[[^\]]*]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/[*_`~]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function collectHeadingTexts(markdown: string, level: number): string[] {
	const lines = markdown.split(/\r?\n/);
	const pattern = new RegExp(`^${"#".repeat(level)}\\s+(.+?)\\s*$`);
	const headings: string[] = [];
	let inFence = false;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			continue;
		}

		const match = line.match(pattern);
		if (!match) {
			continue;
		}

		const cleaned = cleanSummaryText(match[1]);
		if (cleaned) {
			headings.push(cleaned);
		}
	}

	return [...new Set(headings)];
}

function collectFallbackLines(markdown: string): string[] {
	const lines = markdown.split(/\r?\n/);
	const summaries: string[] = [];
	let inFence = false;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (inFence || !line || /^#{1,6}\s+/.test(line)) {
			continue;
		}

		const cleaned = cleanSummaryText(line.replace(/^([-*+]|\d+\.)\s+/, ""));
		if (!cleaned) {
			continue;
		}

		summaries.push(cleaned);
		if (summaries.length >= 3) {
			break;
		}
	}

	return summaries;
}

export function extractDocumentSummary(markdown: string, maxLength = SUMMARY_MAX_LENGTH): string | undefined {
	const h1Headings = collectHeadingTexts(markdown, 1);
	if (h1Headings.length > 0) {
		return truncateText(h1Headings.join(" / "), maxLength);
	}

	const h2Headings = collectHeadingTexts(markdown, 2);
	if (h2Headings.length > 0) {
		return truncateText(h2Headings.join(" / "), maxLength);
	}

	const fallbackLines = collectFallbackLines(markdown);
	if (fallbackLines.length > 0) {
		return truncateText(fallbackLines.join(" / "), maxLength);
	}

	return undefined;
}

async function mapWithConcurrency<T, U>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
	if (0 === items.length) {
		return [];
	}

	const results: U[] = new Array(items.length);
	let cursor = 0;

	const run = async () => {
		while (cursor < items.length) {
			const currentIndex = cursor++;
			results[currentIndex] = await worker(items[currentIndex], currentIndex);
		}
	};

	const workers = Array.from(
		{ length: Math.min(Math.max(1, limit), items.length) },
		() => run(),
	);

	await Promise.all(workers);
	return results;
}

async function resolveListPaths(
	notebook: string,
	hpath: string,
	fetcher: SiyuanApiFetcher,
): Promise<PathResolution> {
	if ("/" === hpath) {
		return { resolvedPaths: ["/"], pathMatchCount: 1 };
	}

	const ids = await fetcher("/api/filetree/getIDsByHPath", {
		notebook,
		path: hpath,
	});

	if (!Array.isArray(ids) || 0 === ids.length) {
		return { resolvedPaths: [], pathMatchCount: 0 };
	}

	const resolved = await mapWithConcurrency(
		ids.filter((id): id is string => "string" === typeof id && id.length > 0),
		REQUEST_CONCURRENCY,
		async (id) => {
			try {
				const data = await fetcher("/api/filetree/getPathByID", { id });
				if ("string" !== typeof data?.path) {
					return null;
				}
				return toChildrenPath(data.path);
			} catch {
				return null;
			}
		},
	);

	const dedupedPaths = [...new Set(resolved.filter((item): item is string => !!item))];
	return {
		resolvedPaths: dedupedPaths,
		pathMatchCount: ids.length,
	};
}

async function fetchFilesByPath(
	notebook: string,
	path: string,
	maxListCount: number,
	fetcher: SiyuanApiFetcher,
): Promise<SiyuanDocFile[]> {
	const data = await fetcher("/api/filetree/listDocsByPath", {
		notebook,
		path,
		maxListCount,
		ignoreMaxListHint: true,
	});

	if (!Array.isArray(data?.files)) {
		return [];
	}

	return data.files
		.filter((file: any): file is SiyuanDocFile => "string" === typeof file?.id && "string" === typeof file?.name && "string" === typeof file?.path)
		.map((file) => ({
			id: file.id,
			name: file.name,
			path: file.path,
			mtime: Number(file.mtime) || 0,
			subFileCount: Number(file.subFileCount) || 0,
		}));
}

async function fetchDocumentHPath(
	id: string,
	fetcher: SiyuanApiFetcher,
	fallbackParentHPath: string,
	title: string,
): Promise<string> {
	try {
		const hpath = await fetcher("/api/filetree/getHPathByID", { id });
		if ("string" === typeof hpath && hpath.length > 0) {
			return hpath;
		}
	} catch {
		// Fallback below.
	}
	return joinHPath(fallbackParentHPath, title);
}

async function fetchDocumentSummary(
	id: string,
	fetcher: SiyuanApiFetcher,
): Promise<string | undefined> {
	try {
		const data = await fetcher("/api/export/exportMdContent", { id });
		const content = "string" === typeof data?.content ? data.content : "";
		if (!content) {
			return undefined;
		}
		return extractDocumentSummary(content);
	} catch {
		return undefined;
	}
}

function dedupeFiles(files: SiyuanDocFile[]): SiyuanDocFile[] {
	const deduped = new Map<string, SiyuanDocFile>();
	for (const file of files) {
		if (!deduped.has(file.id)) {
			deduped.set(file.id, file);
		}
	}
	return [...deduped.values()];
}

async function buildDocumentNode(
	file: SiyuanDocFile,
	options: BuildNodeOptions,
): Promise<BuiltNode> {
	const title = stripDocSuffix(file.name);
	const hasChildren = file.subFileCount > 0;
	const updated = unixSecondsToSiyuanTimestamp(file.mtime);

	const [hpath, summary] = await Promise.all([
		fetchDocumentHPath(file.id, options.fetcher, options.parentHPath, title),
		options.includeSummary ? fetchDocumentSummary(file.id, options.fetcher) : Promise.resolve(undefined),
	]);

	let children: ListDocumentsItem[] | undefined;
	let truncated = false;

	if (options.depth > 0) {
		if (hasChildren && options.childLimit > 0) {
			const childFiles = await fetchFilesByPath(
				options.notebook,
				toChildrenPath(file.path),
				options.childLimit,
				options.fetcher,
			);
			const childNodes = await mapWithConcurrency(
				childFiles,
				REQUEST_CONCURRENCY,
				async (childFile) => buildDocumentNode(childFile, {
					...options,
					depth: options.depth - 1,
					parentHPath: hpath,
				}),
			);
			children = childNodes.map((node) => node.item);
			truncated = file.subFileCount > childFiles.length || childNodes.some((node) => node.truncated);
		} else if (hasChildren) {
			children = [];
			truncated = true;
		}
	}

	const item: ListDocumentsItem = {
		id: file.id,
		title,
		hpath,
		updated,
		hasChildren,
		childCount: file.subFileCount,
	};

	if (summary) {
		item.summary = summary;
	}
	if (children) {
		item.children = children;
	}

	return { item, truncated };
}

export async function listDocumentsViaApi(
	input: ListDocumentsInput,
	fetcher: SiyuanApiFetcher,
): Promise<ListDocumentsResult> {
	const normalizedPath = normalizeHPath(input.path);
	const depth = clampInteger(input.depth, DEFAULT_DEPTH, 0, MAX_DEPTH);
	const page = clampInteger(input.page, DEFAULT_PAGE, 1, Number.MAX_SAFE_INTEGER);
	const pageSize = clampInteger(input.page_size, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
	const childLimit = clampInteger(input.child_limit, DEFAULT_CHILD_LIMIT, 0, MAX_CHILD_LIMIT);
	const includeSummary = false !== input.include_summary;

	const { resolvedPaths, pathMatchCount } = await resolveListPaths(input.notebook, normalizedPath, fetcher);
	if (0 === resolvedPaths.length) {
		return {
			notebook: input.notebook,
			path: normalizedPath,
			page,
			pageSize,
			depth,
			total: 0,
			hasMore: false,
			items: [],
			truncated: false,
			pathMatchCount,
		};
	}

	const docLists = await Promise.all(
		resolvedPaths.map((resolvedPath) => fetchFilesByPath(input.notebook, resolvedPath, 0, fetcher)),
	);
	const allFiles = dedupeFiles(docLists.flat());
	const total = allFiles.length;
	const startIndex = (page - 1) * pageSize;
	const pagedFiles = allFiles.slice(startIndex, startIndex + pageSize);
	const hasMore = startIndex + pageSize < total;

	const builtItems = await mapWithConcurrency(
		pagedFiles,
		REQUEST_CONCURRENCY,
		async (file) => buildDocumentNode(file, {
			notebook: input.notebook,
			depth,
			childLimit,
			includeSummary,
			fetcher,
			parentHPath: normalizedPath,
		}),
	);

	return {
		notebook: input.notebook,
		path: normalizedPath,
		page,
		pageSize,
		depth,
		total,
		hasMore,
		items: builtItems.map((item) => item.item),
		truncated: hasMore || pathMatchCount > 1 || builtItems.some((item) => item.truncated),
		pathMatchCount,
	};
}
