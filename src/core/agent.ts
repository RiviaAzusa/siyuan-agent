import { ChatOpenAI } from "@langchain/openai";
import {
	HumanMessage,
	AIMessage,
	SystemMessage,
	ToolMessage,
	type BaseMessage,
	AIMessageChunk,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { Client } from "langsmith";
import { AgentConfig, ChatMessage } from "../types";

export interface AgentCallbacks {
	onContent?: (text: string) => void;
	onToolStart?: (name: string, args: Record<string, any>) => void;
	onToolEnd?: (name: string, result: string) => void;
	onDone?: (finalContent: string) => void;
	onError?: (err: Error) => void;
}

export interface AgentResult {
	messages: ChatMessage[];
	finalContent: string;
}

function toBaseMessages(messages: ChatMessage[]): BaseMessage[] {
	return messages.map(m => {
		switch (m.role) {
			case "system": 
				return new SystemMessage(m.content);
			case "user": 
				return new HumanMessage(m.content);
			case "assistant": 
				return new AIMessage({
					content: m.content,
					tool_calls: m.tool_calls as any, 
				});
			case "tool":
				return new ToolMessage({
					content: m.content,
					tool_call_id: m.tool_call_id!,
					name: m.name,
				});
			default:
				return new HumanMessage(m.content);
		}
	});
}

function toChatMessages(messages: BaseMessage[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const m of messages) {
		const type = m.getType();
		if (type === "system" || type === "human" || type === "ai" || type === "tool") {
			const role = type === "human" ? "user" : 
			             type === "ai" ? "assistant" : 
						 type === "tool" ? "tool" : "system";
			
			const msg: ChatMessage = {
				role,
				content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
				timestamp: Date.now(),
			};
			
			if (type === "ai") {
				const aiMsg = m as AIMessage;
				if (aiMsg.tool_calls && aiMsg.tool_calls.length) {
					msg.tool_calls = aiMsg.tool_calls.map(tc => ({
						id: tc.id || "",
						name: tc.name,
						args: tc.args
					}));
				}
			}
			
			if (type === "tool") {
				const toolMsg = m as ToolMessage;
				msg.tool_call_id = toolMsg.tool_call_id;
				msg.name = toolMsg.name;
			}

			out.push(msg);
		}
	}
	return out;
}

export async function runAgent(
	messages: ChatMessage[],
	config: AgentConfig,
	tools: StructuredToolInterface[],
	callbacks?: AgentCallbacks,
	signal?: AbortSignal
): Promise<AgentResult> {
	const model = new ChatOpenAI({
		model: config.model,
		temperature: 0,
		streaming: true,
		apiKey: config.apiKey,
		configuration: {
			dangerouslyAllowBrowser: true,
			baseURL: config.apiBaseURL,
		},
	});

	/* --- LangSmith: create a parent chain run so the entire agent loop is one trace --- */
	let parentRunManager: any = null;
	if (config.langSmithEnabled && config.langSmithApiKey) {
		const client = new Client({
			apiKey: config.langSmithApiKey,
			apiUrl: config.langSmithEndpoint || "https://api.smith.langchain.com",
		});
		const tracer = new LangChainTracer({
			projectName: config.langSmithProject || "SiYuan-Agent",
			client,
		});
		const cm = new CallbackManager();
		cm.addHandler(tracer);
		parentRunManager = await cm.handleChainStart(
			{ id: ["SiYuan-Agent"], name: "SiYuan-Agent" } as any,
			{ input: messages[messages.length - 1]?.content || "" },
		);
	}

	const childCallbacks = parentRunManager
		? parentRunManager.getChild()
		: undefined;

	const modelWithTools = tools.length > 0 ? model.bindTools(tools) : model;
	const conversation: BaseMessage[] = toBaseMessages(messages);
	const toolMap = new Map(tools.map(t => [t.name, t]));

	let rounds = 0;
	let finalContent = "";

	try {
		while (rounds < config.maxToolRounds) {
			rounds++;

			const streamOpts: any = { signal };
			if (childCallbacks) streamOpts.callbacks = childCallbacks;
			const stream = await modelWithTools.stream(conversation, streamOpts);

			let gathered: AIMessageChunk | null = null;

			for await (const chunk of stream) {
				gathered = gathered ? gathered.concat(chunk) : chunk;

				if (chunk.content && typeof chunk.content === "string") {
					callbacks?.onContent?.(chunk.content);
				}
			}

			if (!gathered) break;

			const fullContent = typeof gathered.content === "string" ? gathered.content : "";
			const toolCalls = gathered.tool_calls || [];

			conversation.push(new AIMessage({
				content: fullContent,
				tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
			}));

			if (toolCalls.length === 0) {
				finalContent = fullContent;
				break;
			}

			for (const tc of toolCalls) {
				callbacks?.onToolStart?.(tc.name, tc.args as Record<string, any>);

				const target = toolMap.get(tc.name);
				let result: string;
				if (!target) {
					result = JSON.stringify({
						error: `Unknown tool: ${tc.name}`,
						available_tools: Array.from(toolMap.keys()),
					});
				} else {
					try {
						const invokeOpts: any = {};
						if (childCallbacks) invokeOpts.callbacks = childCallbacks;
						const out = await target.invoke(tc.args, invokeOpts);
						result = typeof out === "string" ? out : JSON.stringify(out);
					} catch (err) {
						result = JSON.stringify({
							error: String(err),
							tool: tc.name,
							hint: "Check parameters and try again with corrected values.",
						});
					}
				}

				callbacks?.onToolEnd?.(tc.name, result);
				conversation.push(new ToolMessage({
					content: result,
					tool_call_id: tc.id!,
				}));
			}
		}

		callbacks?.onDone?.(finalContent);

		if (parentRunManager) {
			await parentRunManager.handleChainEnd({ output: finalContent });
		}
	} catch (err) {
		if (parentRunManager) {
			await parentRunManager.handleChainError(err);
		}
		throw err;
	}

	return { messages: toChatMessages(conversation), finalContent };
}
