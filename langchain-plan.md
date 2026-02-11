Plan: Migrate Agent to LangChain.js
Context
当前插件的 agent 是手写的 ReAct loop（llm.ts 手动 fetch SSE + agent.ts 手动 tool call 循环）。为了支持更多高级特性（多模型、消息兜底、MCP 等），需要切换到 LangChain.js。参考项目 /Users/azusa/projects/research/langchainjs-test/ 已验证 LangChain.js 在浏览器环境可用。

变更范围
1. 安装依赖
npm install langchain @langchain/core
npm install @langchain/openai
2. 修改 src/types.ts
删除 StreamDelta, StreamToolCall, StreamChoice, StreamChunk 等 SSE 类型（LangChain 内部处理）
删除 ToolCall 接口（用 LangChain 的 AIMessage["tool_calls"]）
保留 ChatMessage，但调整：去掉 tool_calls 和 tool_call_id 字段（这些由 LangChain BaseMessage 承载）
保留 AgentConfig, DEFAULT_CONFIG, DEFAULT_SYSTEM_PROMPT
删除 ToolDef（用 LangChain tool() 替代）
3. 删除 src/core/llm.ts
整个文件删除。ChatOpenAI + .stream() 完全替代了手写的 fetch + SSE 解析。

4. 重写 src/core/tools.ts
用 tool() from @langchain/core/tools + z.object schema 定义每个工具
siyuanFetch helper 保留（调 SiYuan API 不变）
3 个工具改写为 LangChain tool：
search_blocks → tool(async ({sql}) => ..., { name, description, schema: z.object({sql: z.string()}) })
get_block_content → 同理
insert_block → 同理
ToolRegistry 类简化：内部存 LangChain StructuredToolInterface[]，提供 list() 返回 tool 数组
删除 toOpenAIFormat()（不再需要，model.bindTools(tools) 直接吃 LangChain tool）
execute() 不再需要（agent loop 直接调 tool.invoke()）
5. 重写 src/core/agent.ts
参照 test 项目的模式，核心逻辑：


import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage, SystemMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";

export async function runAgent(messages, config, tools, callbacks?, signal?) {
  const model = new ChatOpenAI({
    modelName: config.model,
    temperature: 0,
    streaming: true,
    openAIApiKey: config.apiKey,
    configuration: {
      dangerouslyAllowBrowser: true,
      baseURL: config.apiBaseURL,
    },
  });

  const modelWithTools = model.bindTools(tools);

  // 将 ChatMessage[] 转换为 LangChain BaseMessage[]
  const conversation: BaseMessage[] = convertMessages(messages);

  let rounds = 0;
  while (rounds < config.maxToolRounds) {
    rounds++;
    const stream = await modelWithTools.stream(conversation, { signal });

    let fullContent = "";
    let toolCalls = [];

    for await (const chunk of stream) {
      // 文本 streaming
      if (chunk.content && typeof chunk.content === "string") {
        fullContent += chunk.content;
        callbacks?.onContent?.(chunk.content);
      }
      // tool call 合并
      if (chunk.tool_calls?.length > 0) { /* merge by id */ }
    }

    conversation.push(new AIMessage({ content: fullContent, tool_calls: ... }));

    if (toolCalls.length === 0) break;

    // 执行 tools
    for (const tc of toolCalls) {
      callbacks?.onToolStart?.(tc.name, tc.args);
      const result = await targetTool.invoke(tc.args);
      callbacks?.onToolEnd?.(tc.name, result);
      conversation.push(new ToolMessage({ content: result, tool_call_id: tc.id }));
    }
  }

  callbacks?.onDone?.(finalContent);
  return { messages: convertBack(conversation), finalContent };
}
关键点：

model.stream(messages, { signal }) 支持 AbortSignal
tool call chunk 合并逻辑同 test 项目（按 tc.id merge）
AgentCallbacks 接口保持不变（onContent/onToolStart/onToolEnd/onDone/onError）
返回值格式保持兼容 AgentResult
6. 修改 src/ui/chat-panel.ts
改 import：从 "../core/agent" 导入新的 runAgent
send() 中的调用签名变化：传 toolRegistry.list()（LangChain tool 数组）而非 toolRegistry 对象
其余 DOM 逻辑、streaming callback、abort 机制 不变
7. 修改 src/index.ts
createDefaultRegistry() 返回值类型可能变化，确保兼容
其余无变化
8. 构建配置调整
webpack.config.js:

esbuild-loader target 从 es6 改为 es2020（LangChain 用 async iterator, optional chaining 等）
tsconfig.json:

target 从 es6 改为 es2020
module 从 commonjs 改为 es2020 或 esnext（LangChain 包是 ESM）
添加 moduleResolution: "bundler" 或 "node16"（解析 LangChain 的 package.json exports）
添加 lib: ["ES2020", "DOM", "DOM.Iterable"]
文件变更清单
文件	操作
package.json	添加 dependencies: @langchain/core, @langchain/openai, zod
tsconfig.json	更新 target/module/moduleResolution/lib
webpack.config.js	esbuild target → es2020
src/types.ts	删除 Stream*/ToolCall/ToolDef 类型，简化 ChatMessage
src/core/llm.ts	删除
src/core/tools.ts	用 LangChain tool() 重写，简化 ToolRegistry
src/core/agent.ts	用 ChatOpenAI + stream() 重写 ReAct loop
src/ui/chat-panel.ts	调整 import 和 runAgent 调用签名
src/index.ts	小幅适配（如有需要）
验证步骤
npm install — 依赖安装成功
npm run dev — webpack 编译无错误
在思源中加载插件，打开 Dock 面板
配置 API（任意 OpenAI 兼容端点），发送消息
验证：流式输出正常、tool calling 正常（搜索/获取块/插入块）、Stop 按钮能中断