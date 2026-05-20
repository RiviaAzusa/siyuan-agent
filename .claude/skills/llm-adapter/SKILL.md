---
name: llm-adapter
description: Add a new LLM provider to siyuan-agent - create ChatXxx class extending ChatOpenAI, reasoning support, modelKwargs mapping
---

# LLM Provider Adapter

为 siyuan-agent 添加新的 LLM 供应商适配。

## 架构

```
src/llms/
  reasoning.ts       # 共享: injectReasoningContent, DEEPSEEK_PROFILES, ModelProfile
  deepseek.ts        # ChatDeepSeek extends ChatOpenAI
  <provider>.ts      # 新供应商: ChatXxx extends ChatOpenAI
src/core/
  chat-model.ts      # 编排层: createChatModel() 按 providerType 分发
```

## 新增供应商步骤

### 1. 创建 `src/llms/<provider>.ts`

```ts
import { ChatOpenAI } from "@langchain/openai";
import type { ReasoningEffort } from "../types";

export class ChatXxx extends ChatOpenAI {
    // (a) kwargs 映射 — 将统一的 ReasoningEffort 翻译为供应商 API 参数
    static getModelKwargs(effort: ReasoningEffort = "default"): Record<string, any> {
        if (effort === "off") return { /* 关闭思考的参数 */ };
        if (effort === "high") return { /* 高深度思考的参数 */ };
        return {};
    }

    constructor(fields: ChatXxxInput = {}) {
        super({
            ...fields,
            apiKey: fields.apiKey || process.env.XXX_API_KEY,
            configuration: {
                baseURL: "https://api.xxx.com",
                dangerouslyAllowBrowser: true,
                ...fields.configuration,
            },
        });
        // (b) 如需 reasoning 提取/回传，patch completions
        this.patchCompletions();
    }

    // (c) 如模型返回 reasoning_content 字段，patch 响应转换
    private patchCompletions() { /* 参考 deepseek.ts */ }

    // (d) 如模型用 <think> 标签包裹思考内容，override 流式处理
    override async *_streamResponseChunks(...) { /* 参考 deepseek.ts */ }
}
```

### 2. 注册到 `src/types/model-config.ts`

在 `ModelProviderType` 联合类型中添加新值:

```ts
export type ModelProviderType = "openai-compatible" | "deepseek" | "xxx";
```

更新 `inferProviderType()` 的启发式判断。

### 3. 接入 `src/core/chat-model.ts`

在 `createChatModel` 中添加分支:

```ts
if (config.providerType === "xxx") {
    return new ChatXxx({
        ...commonFields,
        modelKwargs: ChatXxx.getModelKwargs(options.reasoningEffort),
    });
}
```

## 统一用户设置: ReasoningEffort

用户只需设置一个枚举值，每个供应商自行翻译:

| ReasoningEffort | 含义 | DeepSeek 映射 |
|---|---|---|
| `"default"` | 供应商默认 | `{}` |
| `"off"` | 关闭思考 | `{ thinking: { type: "disabled" } }` |
| `"low"` | 低深度思考 | `{ reasoning_effort: "high", thinking: { type: "enabled" } }` |
| `"high"` | 高深度思考 | `{ reasoning_effort: "max", thinking: { type: "enabled" } }` |

## Reasoning 数据流

```
响应侧: API delta.reasoning_content → patch → additional_kwargs.reasoning_content → stream-runtime.ts → UI
请求侧: additional_kwargs.reasoning_content → injectReasoningContent → API request messages (回传上下文)
```

关键: `convertMessagesToCompletionsMessageParams` 不处理 `reasoning_content`，必须在 `completionWithRetry` 中注入。

## 关键文件

- `src/llms/deepseek.ts` — 完整参考实现
- `src/llms/reasoning.ts` — 共享工具函数
- `src/core/chat-model.ts` — 编排层
- `src/types/model-config.ts` — 类型定义
- `src/core/stream-runtime.ts` — reasoning 渲染消费端

## Task

$ARGUMENTS
