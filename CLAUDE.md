# SiYuan Agent

思源笔记 AI 助手插件，类 Notion AI 体验。

## 项目概况

- **构建**: Webpack 5 + TypeScript + SCSS, `npm run dev` 开发 / `npm run build` 生产
- **SDK**: `siyuan` npm 包 (v1.1.7), 外部引用不打包
- **LangChain**: 集成 `@langchain/core`, `@langchain/openai`, `@langchain/community` 构建 Agent
- **产物**: `index.js` + `index.css`, 部署在 `{workspace}/data/plugins/siyuan-agent/`
- **思源源码参考**: `/Users/azusa/projects/research/siyuan/` (API 路由、内核实现)

## 架构

```
src/
  index.ts              # 插件入口: onload/onunload, 注册 Dock/Command/Setting/LangSmith Config
  index.scss            # 全部样式, 使用思源 CSS 变量 (--b3-theme-*)
  types.ts              # ChatMessage, AgentConfig (含 LangSmith 配置)
  core/
    agent.ts            # LangChain Agent 循环 (Model.stream + Tool Call Aggregation + Tracer)
    tools.ts            # Tool Definitions (Zod Schema + SiYuan API Fetch)
  ui/\
    chat-panel.ts       # 右侧 Dock 聊天面板 (消息列表 + 输入框 + 流式渲染)
    markdown.ts         # 轻量 Markdown→HTML 渲染器
test/
    test-tools.ts       # 独立工具测试脚本 (Direct HTTP Fetch)
```

## 关键设计决策 (v0.2.0 Refactor)

- **Agent Framework**: 迁移至 LangChain.js, 利用其生态 (Tracer, Tool Binding, Streaming)
- **Tool Definition**: 使用 `zod` 定义工具 Schema, 强类型验证输入
- **Tracing**: 集成 LangSmith (`LangChainTracer`), 可配置 API Key 和 Project 用于调试
- **Streaming Reliability**: 手动处理 `stream` chunks 并使用 `AIMessageChunk.concat()` 聚合, 解决 incomplete JSON args 问题
- **Direct SQL**: 使用 `/api/query/sql` 替代部分 SDK 方法以获得更灵活的数据查询能力

## 已实现功能

### 核心功能
- [x] 右侧 Dock 聊天面板
- [x] 流式输出 + 打字光标动画
- [x] OpenAI 兼容 API 配置 (Settings 面板: URL/Key/Model/Prompt)
- [x] 选中文本 → ⌥⌘L → 作为引用上下文发送到对话框
- [x] Stop 按钮 (AbortController 中断生成)
- [x] 对话历史持久化

### Agent 能力
- [x] LangChain ReAct Loop w/ Tool Calling
- [x] **LangSmith Tracing**: 支持在插件设置中配置 Key/Project, 实时追踪 Agent 思考过程
- [x] **Robust Streaming**: 修复流式输出时 Tool Args 解析错误的问题

### 内置工具 (Tools)
1.  **list_notebooks**:
    *   API: `/api/notebook/lsNotebooks`
    *   功能: 列出所有笔记本 ID/名称/图标/状态
    *   用途: 获取后续查询所需的 notebook ID
2.  **list_documents**:
    *   API: `/api/query/sql` (`SELECT * FROM blocks WHERE type='d'...`)
    *   功能: 获取指定笔记本下的文档列表 (ID, Title, Path, Updated)
    *   参数: `notebook` (必填), `path` (可选过滤)
    *   用途: 查找文档 ID
3.  **get_document**:
    *   API: `/api/export/exportMdContent`
    *   功能: 获取文档完整 Markdown 内容
    *   参数: `id` (文档 block ID)
    *   用途: 读取内容以回答问题

## 问题与修复记录

### 2026-02-11 Tool Args 解析错误
- **现象**: `Received tool input did r...` (JSON 解析失败)
- **原因**: 之前在 stream loop 中手动合并 `tool_calls` args, 但未处理 incomplete JSON chunks
- **修复**: 使用 `AIMessageChunk.concat(chunk)` 自动聚合流式块, LangChain 内部处理 JSON buffer

### 2026-02-11 LangSmith 集成
- **需求**: 可视化 Agent 思考过程, 调试工具调用参数
- **实现**:
    - `src/types.ts`: 添加 `langSmithApiKey` 配置
    - `src/index.ts`: 添加设置 UI
    - `src/core/agent.ts`: 初始化 `LangChainTracer` 并注入到 model/tool calls

## 验证脚本
- `test/test-tools.ts`: 独立测试脚本, 不依赖 SiYuan 插件环境, 直接 fetch 本地 API (localhost:6806)
- 运行: `npx tsx test/test-tools.ts`
- 状态: ✅ 通行 (12/12 tests passed)

## 下一版本 TODO
- [ ] 更完善的错误处理 (当工具调用失败时, 让 Agent 尝试修复参数)
- [ ] 更多工具: `search_fulltext` (全文搜索), `append_block` (写入笔记)
- [ ] 对话历史管理 UI 优化
