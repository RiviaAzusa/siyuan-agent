import { describe, it, expect } from "vitest";
import { context, createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { FakeToolCallingModel } from "langchain";
import { tool, ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  BaseMessage,
} from "@langchain/core/messages";
import * as fs from "fs";
import * as path from "path";

// ─────────────────────── Session Helpers ───────────────────────

/**
 * 将 LangChain JS 序列化的单条消息 dict 还原为 BaseMessage 实例。
 * JS 序列化格式: { lc:1, type:"constructor", id:[...path, ClassName], kwargs:{...} }
 */
function messageFromDict(raw: Record<string, any>): BaseMessage {
  // LangChain JS 序列化格式
  if (raw.lc === 1 && raw.type === "constructor" && Array.isArray(raw.id)) {
    const className = raw.id[raw.id.length - 1] as string;
    const kwargs = raw.kwargs ?? {};
    if (className === "HumanMessage")  return new HumanMessage(kwargs);
    if (className === "AIMessage")     return new AIMessage(kwargs);
    if (className === "AIMessageChunk") return new AIMessage(kwargs); // 当普通对话历史用
    if (className === "SystemMessage") return new SystemMessage(kwargs);
    if (className === "ToolMessage")   return new ToolMessage({ tool_call_id: "", ...kwargs });
    throw new Error(`Unknown LangChain message class: ${className}`);
  }

  // 兜底: Python 风格 { type: "human"|"ai"|... , content, ... }
  const { type, ...rest } = raw;
  if (type === "human")  return new HumanMessage(rest);
  if (type === "ai")     return new AIMessage(rest);
  if (type === "system") return new SystemMessage(rest);
  if (type === "tool")   return new ToolMessage({ tool_call_id: "", ...rest });
  throw new Error(`Unknown message type: ${type}`);
}

/** 反序列化消息列表 */
function messagesFromDict(messages: Record<string, any>[]): BaseMessage[] {
  return messages.map(messageFromDict);
}

/**
 * 合并已保存的 session state 与新的用户输入。
 * 对应 Python 版 _merge_state。
 *
 * @param savedState   从 JSON 文件 load 回来的 object（或 null 表示新会话）
 * @param inputMsgStr  用户新输入的字符串（可选，传入则追加为 HumanMessage）
 * @returns            含有 BaseMessage[] 的 state object，可直接传给 agent.invoke
 */
function mergeState(
  savedState: Record<string, any> | null,
  inputMsgStr?: string
): { messages: BaseMessage[] } {
  let messages: BaseMessage[] = [];

  if (savedState?.messages && Array.isArray(savedState.messages)) {
    messages = messagesFromDict(savedState.messages);
  }

  if (inputMsgStr) {
    messages.push(new HumanMessage({ content: inputMsgStr }));
  }

  return { messages };
}

// ─────────────────────── 准备: Mock Tools ───────────────────────

const getWeatherTool = tool(
  async ({ city }, config: ToolRuntime) => {
    // 模拟天气 API
    const res: string = `The Weather of ${city} is Sunny.`;
    const writer = config.writer;
    if (writer) {
      writer(`Success to get Weather of ${city}`);
    }
    return res;
  },
  {
    name: "get_weather",
    description: "获取城市天气",
    schema: z.object({
      city: z.string().describe("城市名"),
    }),
  },
);


const getUserIdTool = tool(
  async ({ username }, config: ToolRuntime) => {
    // 模拟天气 API
    const res: string = `The userId of ${username} is 199734222.`;
    const writer = config.writer;
    if (writer) {
      writer(`Success to get UserId of ${username}`);
    }
    return res;
  },
  {
    name: "get_userId",
    description: "获取用户Id",
    schema: z.object({
      username: z.string().describe("用户名"),
    }),
  },
);


const model = new ChatOpenAI({
  model: process.env.OPENAI_MODEL!,
  temperature: 0,
  streaming: true,
  apiKey: process.env.OPENAI_API_KEY!,
  configuration: {
    dangerouslyAllowBrowser: true,
    baseURL: process.env.OPENAI_BASE_URL!,
  },
});

const contextSchema = z.object({
  user_name: z.string(),
});

const agent = createAgent({
  model,
  tools: [getWeatherTool, getUserIdTool],
  systemPrompt: "你是好助手，快速回答。",
});

describe("Invoke To LangChain Agent", () => {
  it("用真实模型调用工具", async () => {
    const result = await agent.invoke({
      messages: [{ role: "human", content: "豆丁的id是多少" }],
    });

    // 断点打这里，看真实 API 返回的完整对话
    const lastMsg = result.messages[result.messages.length - 1];
    console.log("AI 回复:", lastMsg.content);


  }, 30000); 
});

describe("Streaming to LangChain Agent", () => {
  it("Streaming to LangChain Agent", async () => {
    const stream = await agent.stream(
      {
        messages: [
          {
            role: "human",
            content: "豆丁的id是多少",
          },
        ],
      },
      {
        context: { user_name: "John Wick" },
        streamMode: ["messages", "values", "custom"],
      },
    );
    for await (const chunk of stream) {
      console.log(chunk);
    }
  }, 30000); // 30s 超时
});

describe("Streaming Agent With LangSmith Tracing", () => {
  it("should trace entire agent run as single trace", async () => {
    const { Client } = await import("langsmith");
    const { LangChainTracer } = await import("@langchain/core/tracers/tracer_langchain");

    const client = new Client({
      apiKey: process.env.LANGSMITH_API_KEY!,
      apiUrl: process.env.LANGSMITH_ENDPOINT!,
    });
    const tracer = new LangChainTracer({
      projectName: process.env.LANGSMITH_PROJECT!,
      client,
    });

    const stream = await agent.stream(
      {
        messages: [
          {
            role: "human",
            content: "武汉天气如何?",
          },
        ],
      },
      {
        streamMode: ["messages", "values", "custom"],
        callbacks: [tracer],
      },
    );
    for await (const chunk of stream) {
      console.log(chunk);
    }
    // 等待 tracer 异步发送完毕
    await new Promise(resolve => setTimeout(resolve, 5000));
  }, 60000);
});



describe("Save & Load Session", () => {
  it("Save & Load Session", async () => {
    const inputState = mergeState(null, "豆丁的id多少");
    const result = await agent.invoke(inputState);

    const content = result.messages[result.messages.length - 1].content;
    console.log(content);

    // ── Save ──────────────────────────────────────────────────────
    const filePath = path.resolve(__dirname, "../tmp/session-result.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(result, null, 2), "utf-8");
    console.log("Saved to:", filePath);

    // ── Load & Restore ────────────────────────────────────────────
    const loaded = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    console.log("Loaded (raw):", loaded);

    // 将 loaded 的 messages 反序列化为 BaseMessage[]，并追加新一轮用户输入
    const restoredState = mergeState(loaded, "你还记得我叫什么吗？");
    console.log("Restored messages:", restoredState.messages);
    const restoredResult = await agent.invoke(restoredState);
    console.log("Restored result:", restoredResult);

  }, 30000);
});


// breaking and restore.
