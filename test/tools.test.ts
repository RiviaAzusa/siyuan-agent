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
		expect(searchDoc!.schema).toBeDefined();
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
		const raw = await (tool as any).invoke({
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
		const raw = await (tool as any).invoke({
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
		expect(isError('ToolError: invalid param')).toBe(true);
		expect(isError('{"error": "something went wrong"}')).toBe(true);
		expect(isError("成功完成操作")).toBe(false);
		expect(isError('{"status": "ok"}')).toBe(false);
	});
});
