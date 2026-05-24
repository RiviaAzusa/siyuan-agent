import { tool } from "@ai-sdk/provider-utils";
import type { Tool, ToolExecutionOptions } from "@ai-sdk/provider-utils";
import type { z } from "zod";
import type { TodoList } from "../types";

// Context passed to tools via experimental_context
export interface ToolContext {
    setTodos?: (todos: TodoList) => void;
}

// Extended options with our custom context
export interface SiyuanToolOptions extends ToolExecutionOptions {
    experimental_context?: ToolContext;
}

// Our tool execute function signature
export type SiyuanToolExecute<INPUT> = (
    args: INPUT,
    options: SiyuanToolOptions,
) => Promise<string> | string;

// Config for creating a tool
export interface SiyuanToolConfig<INPUT> {
    name?: string;
    description: string;
    parameters: z.ZodType<INPUT>;
    execute: SiyuanToolExecute<INPUT>;
}

// Create a tool compatible with AI SDK's tool system
export function createTool<INPUT>(config: SiyuanToolConfig<INPUT>): Tool<INPUT, string> & { name?: string } {
    const t = tool({
        description: config.description,
        inputSchema: config.parameters,
        execute: async (input, options) => {
            return config.execute(input, options as SiyuanToolOptions);
        },
    });
    if (config.name) {
        (t as any).name = config.name;
    }
    return t as Tool<INPUT, string> & { name?: string };
}
