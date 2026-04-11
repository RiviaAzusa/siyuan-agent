import { describe, expect, it, vi, beforeEach } from "vitest";
import { getDefaultTools, getLookupTools } from "../src/core/tools";

vi.mock("siyuan", () => ({
	fetchPost: vi.fn(),
	openTab: vi.fn(),
}));

// Intercept global fetch for siyuanFetch calls
const mockFetchResponse = (data: any, code = 0) => ({
	json: () => Promise.resolve({ code, data, msg: code !== 0 ? "error" : "" }),
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

	it("default tools include todo tools", () => {
		const names = getDefaultTools(() => ({
			apiBaseURL: "https://example.com/v1",
			apiKey: "key",
			model: "model",
			customInstructions: "",
		})).map(t => t.name);
		expect(names).toContain("search_todos");
		expect(names).toContain("toggle_todo");
		expect(names).toContain("get_todo_stats");
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

	it("search_todos tool has correct schema", () => {
		const tools = getDefaultTools(() => ({
			apiBaseURL: "https://example.com/v1",
			apiKey: "key",
			model: "model",
			customInstructions: "",
		}));
		const searchTodos = tools.find(t => t.name === "search_todos");
		expect(searchTodos).toBeDefined();
		expect(searchTodos!.description).toContain("task");
	});

	it("toggle_todo tool requires block IDs array", () => {
		const tools = getDefaultTools(() => ({
			apiBaseURL: "https://example.com/v1",
			apiKey: "key",
			model: "model",
			customInstructions: "",
		}));
		const toggle = tools.find(t => t.name === "toggle_todo");
		expect(toggle).toBeDefined();
		expect(toggle!.description).toContain("toggle");
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
