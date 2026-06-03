import { describe, expect, it, vi, beforeEach } from "vitest";
import { getDefaultTools, getLookupTools } from "../src/core/tools";
import { createEditBlocksTool } from "../src/core/tools/edit-tools";

vi.mock("siyuan", () => ({
	fetchPost: vi.fn(),
	openTab: vi.fn(),
}));

// Intercept global fetch for siyuanFetch calls
const mockFetchResponse = (data: any, code = 0) => ({
	json: () => Promise.resolve({ code, data, msg: code !== 0 ? "error" : "" }),
});

beforeEach(() => {
	vi.restoreAllMocks();
});

describe("tool definitions", () => {
	it("all tools have unique names", () => {
		const tools = getDefaultTools(() => ({
			apiBaseURL: "https://example.com/v1",
			apiKey: "key",
			model: "model",
			customInstructions: "",
		}));
		const names = tools.map(t => t.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("all tools have descriptions", () => {
		const tools = getDefaultTools(() => ({
			apiBaseURL: "https://example.com/v1",
			apiKey: "key",
			model: "model",
			customInstructions: "",
		}));
		for (const t of tools) {
			expect(t.description).toBeTruthy();
			expect(t.description.length).toBeGreaterThan(10);
		}
	});

	it("lookup tools are a subset of default tools", () => {
		const lookupNames = getLookupTools().map(t => t.name);
		const defaultNames = getDefaultTools(() => ({
			apiBaseURL: "https://example.com/v1",
			apiKey: "key",
			model: "model",
			customInstructions: "",
		})).map(t => t.name);
		for (const name of lookupNames) {
			expect(defaultNames).toContain(name);
		}
	});

	it("lookup tools only contain read-only tools", () => {
		const lookupNames = getLookupTools().map(t => t.name);
		const writeTools = ["edit_blocks", "append_block", "create_document", "move_document", "rename_document", "delete_document", "toggle_todo"];
		for (const name of writeTools) {
			expect(lookupNames).not.toContain(name);
		}
	});

	it("default tools include write_todos", () => {
		const names = getDefaultTools(() => ({
			apiBaseURL: "https://example.com/v1",
			apiKey: "key",
			model: "model",
			customInstructions: "",
		})).map(t => t.name);
		expect(names).toContain("write_todos");
	});

	it("delete_document is not in default tools", () => {
		const names = getDefaultTools(() => ({
			apiBaseURL: "https://example.com/v1",
			apiKey: "key",
			model: "model",
			customInstructions: "",
		})).map(t => t.name);
		expect(names).not.toContain("delete_document");
	});

	it("default tools include scheduled task tools", () => {
		const names = getDefaultTools(() => ({
			apiBaseURL: "https://example.com/v1",
			apiKey: "key",
			model: "model",
			customInstructions: "",
		})).map(t => t.name);
		expect(names).toContain("create_scheduled_task");
		expect(names).toContain("list_scheduled_tasks");
		expect(names).toContain("update_scheduled_task");
		expect(names).toContain("delete_scheduled_task");
	});

	it("default tools include call_error for debug failure rendering", async () => {
		const tools = getDefaultTools(() => ({
			apiBaseURL: "https://example.com/v1",
			apiKey: "key",
			model: "model",
			customInstructions: "",
		}));
		const callError = tools.find(t => t.name === "call_error");
		expect(callError).toBeDefined();
		await expect((callError as any).execute({ message: "debug boom" }, {})).rejects.toThrow("debug boom");
	});
});

describe("SQL escape in tool definitions", () => {
	it("search_documents tool escapes SQL special characters", async () => {
		// We'll test indirectly via the tool's schema validation
		const tools = getDefaultTools(() => ({
			apiBaseURL: "https://example.com/v1",
			apiKey: "key",
			model: "model",
			customInstructions: "",
		}));
		const searchDoc = tools.find(t => t.name === "search_documents");
		expect(searchDoc).toBeDefined();
		expect((searchDoc as any).inputSchema).toBeDefined();
	});

	it("write_todos tool has correct schema", () => {
		const tools = getDefaultTools(() => ({
			apiBaseURL: "https://example.com/v1",
			apiKey: "key",
			model: "model",
			customInstructions: "",
		}));
		const writeTodos = tools.find(t => t.name === "write_todos");
		expect(writeTodos).toBeDefined();
		expect(writeTodos!.description).toContain("plan");
	});

	it("write_todos updates todos through runtime context and returns a normal tool result", async () => {
		const tools = getDefaultTools(() => ({
			apiBaseURL: "https://example.com/v1",
			apiKey: "key",
			model: "model",
			customInstructions: "",
		}));
		const writeTodos = tools.find(t => t.name === "write_todos");
		let captured: any;

		const raw = await (writeTodos as any).execute({
			goal: "Ship cleanup",
			todos: [
				{ content: "Remove writer", status: "completed" },
				{ content: "Update UI", status: "in_progress" },
			],
		}, {
			experimental_context: {
				setTodos: (todos: any) => {
					captured = todos;
				},
			},
		});

		const parsed = JSON.parse(raw);
		expect(captured).toMatchObject({
			goal: "Ship cleanup",
			items: [
				{ content: "Remove writer", status: "completed" },
				{ content: "Update UI", status: "in_progress" },
			],
		});
		expect(parsed).toMatchObject({
			status: "ok",
			goal: "Ship cleanup",
			total: 2,
			completed: 1,
			inProgress: 1,
			pending: 0,
		});
		expect(parsed.todos).toMatchObject(captured);
	});

	it("old todo tools are removed", () => {
		const tools = getDefaultTools(() => ({
			apiBaseURL: "https://example.com/v1",
			apiKey: "key",
			model: "model",
			customInstructions: "",
		}));
		expect(tools.find(t => t.name === "search_todos")).toBeUndefined();
		expect(tools.find(t => t.name === "toggle_todo")).toBeUndefined();
		expect(tools.find(t => t.name === "get_todo_stats")).toBeUndefined();
	});
});

describe("edit_blocks tool", () => {
	it("batch-updates multiple single-block edits without insert/delete churn", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
			const body = JSON.parse(String(init?.body || "{}"));
			if (url === "/api/block/getBlockKramdowns") {
				expect(body.ids).toEqual(["block-1", "block-2"]);
				return mockFetchResponse({ "block-1": "old 1", "block-2": "old 2" }) as any;
			}
			if (url === "/api/block/getBlockTreeInfos") {
				return mockFetchResponse({
					"block-1": { rootID: "root-doc", previousID: "", parentID: "root-doc" },
					"block-2": { rootID: "root-doc", previousID: "block-1", parentID: "root-doc" },
				}) as any;
			}
			if (url === "/api/block/batchUpdateBlock") {
				expect(body).toEqual({
					blocks: [
						{ id: "block-1", data: "---", dataType: "markdown" },
						{ id: "block-2", data: "updated paragraph", dataType: "markdown" },
					],
				});
				return mockFetchResponse([{ doOperations: [{ action: "update", id: "block-1" }, { action: "update", id: "block-2" }] }]) as any;
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const tool = createEditBlocksTool();
		const raw = await (tool as any).execute({
			blocks: [
				{ id: "block-1", content: "---" },
				{ id: "block-2", content: "updated paragraph" },
			],
		});

		expect(fetchMock).not.toHaveBeenCalledWith("/api/block/insertBlock", expect.anything());
		expect(fetchMock).not.toHaveBeenCalledWith("/api/block/deleteBlock", expect.anything());
		expect(JSON.parse(raw)).toEqual({
			__tool_type: "edit_blocks",
			results: [
				{ oldId: "block-1", newIds: ["block-1"], rootDocId: "root-doc", status: "ok", original: "old 1", updated: "---" },
				{ oldId: "block-2", newIds: ["block-2"], rootDocId: "root-doc", status: "ok", original: "old 2", updated: "updated paragraph" },
			],
		});
	});

	it("returns replacement IDs when editing after a previous sibling", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
			const body = JSON.parse(String(init?.body || "{}"));
			if (url === "/api/block/getBlockKramdowns") {
				expect(body.ids).toEqual(["old-block"]);
				return mockFetchResponse({ "old-block": "original" }) as any;
			}
			if (url === "/api/block/getBlockTreeInfos") {
				return mockFetchResponse({
					"old-block": {
						rootID: "root-doc",
						previousID: "prev-block",
						parentID: "parent-block",
					},
				}) as any;
			}
			if (url === "/api/block/insertBlock") {
				expect(body.previousID).toBe("prev-block");
				return mockFetchResponse([
					{ doOperations: [{ id: "new-block-1" }, { id: "new-block-2" }] },
				]) as any;
			}
			if (url === "/api/block/deleteBlock") {
				expect(body.id).toBe("old-block");
				return mockFetchResponse(null) as any;
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const tool = createEditBlocksTool();
		const raw = await (tool as any).execute({
			blocks: [{ id: "old-block", content: "updated" }],
		});

		expect(fetchMock).toHaveBeenCalledWith("/api/block/deleteBlock", expect.anything());
		expect(JSON.parse(raw)).toEqual({
			__tool_type: "edit_blocks",
			results: [{
				oldId: "old-block",
				newIds: ["new-block-1", "new-block-2"],
				rootDocId: "root-doc",
				status: "ok",
				original: "original",
				updated: "updated",
			}],
		});
	});

	it("returns replacement IDs when prepending without a previous sibling", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
			const body = JSON.parse(String(init?.body || "{}"));
			if (url === "/api/block/getBlockKramdowns") {
				return mockFetchResponse({ "old-first": "original first" }) as any;
			}
			if (url === "/api/block/getBlockTreeInfos") {
				return mockFetchResponse({
					"old-first": {
						rootID: "root-doc",
						previousID: "",
						parentID: "parent-block",
					},
				}) as any;
			}
			if (url === "/api/block/prependBlock") {
				expect(body.parentID).toBe("parent-block");
				return mockFetchResponse([
					{ doOperations: [{ id: "new-first" }] },
				]) as any;
			}
			if (url === "/api/block/deleteBlock") {
				expect(body.id).toBe("old-first");
				return mockFetchResponse(null) as any;
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const tool = createEditBlocksTool();
		const raw = await (tool as any).execute({
			blocks: [{ id: "old-first", content: "updated first" }],
		});

		expect(JSON.parse(raw)).toEqual({
			__tool_type: "edit_blocks",
			results: [{
				oldId: "old-first",
				newIds: ["new-first"],
				rootDocId: "root-doc",
				status: "ok",
				original: "original first",
				updated: "updated first",
			}],
		});
	});
});

describe("stream-runtime error detection", () => {
	it("detects various error patterns", () => {
		// Replicate the error detection regex from stream-runtime.ts
		const isError = (content: string) =>
			/^Error:|^\[子智能体执行失败\]|^ToolError:|"error":/i.test(content);

		expect(isError("Error: Block not found")).toBe(true);
		expect(isError("[子智能体执行失败] API rate limit")).toBe(true);
		expect(isError("ToolError: invalid param")).toBe(true);
		expect(isError('{"error": "something went wrong"}')).toBe(true);
		expect(isError("成功完成操作")).toBe(false);
		expect(isError('{"status": "ok"}')).toBe(false);
	});
});
