# SiYuan Agent

思源笔记 AI 助手插件，类 Notion AI 体验。

## 项目概况

- **构建**: Webpack 5 + TypeScript + SCSS, `npm run dev` / `npm run build`
- **SDK**: `siyuan` npm 包 (v1.1.7), 外部引用不打包
- **LangChain**: `@langchain/core` + `@langchain/openai` 构建 Agent
- **产物**: `dist/index.js` + `dist/index.css`
- **思源源码参考**: `/Users/azusa/projects/research/siyuan/`

## 架构

```
src/
  index.ts           # 插件入口: Dock/Command/Setting
  index.scss         # 样式, 使用思源 CSS 变量 (--b3-theme-*)
  types.ts           # ChatMessage, AgentConfig
  core/
    agent.ts         # LangChain Agent 循环 (stream + tool call)
    tools.ts         # Tool Definitions (Zod Schema + SiYuan API)
  ui/
    chat-panel.ts    # Dock 聊天面板 (消息列表 + 输入框 + 流式渲染)
    markdown.ts      # Markdown→HTML 渲染器
test/
    test-tools.ts    # 工具测试: `npx tsx test/test-tools.ts`
```

## 思源插件 API 要点

### Command 回调类型 (ICommand)
- `callback`: 通用回调, 仅在其余回调都不存在时触发
- `editorCallback(protyle: IProtyle)`: 焦点在编辑器时触发, 传入 protyle 对象
- `globalCallback`: 焦点不在应用内时触发
- `fileTreeCallback(file)` / `dockCallback(element)`: 对应焦点场景
- **注意**: 全局 keydown 中, 如果 command 定义了任一非 callback 回调, callback 不会被触发

### 编辑器 Keydown 拦截 (protyle/wysiwyg/keydown.ts)
- 跨块选择 (range 跨越不同 block 元素) 时, 编辑器会 `stopPropagation()` + `return`, **只放行 ⌘C**
- 因此 `editorCallback` 在跨块选择场景下不会被调用
- 块级选择通过 `.protyle-wysiwyg--select` CSS 类标记整个块元素

### 获取选中文本的正确方式
```typescript
editorCallback: (protyle) => {
    // 1. 文本级选区: 通过 window.getSelection() + 验证在 wysiwyg 内
    // 2. 块级选区 fallback: querySelectorAll(".protyle-wysiwyg--select")
}
```
右键菜单通过 `open-menu-content` 事件的 `e.detail.range` 获取选中文本。

## 设计决策

- 流式输出使用 `AIMessageChunk.concat()` 聚合, 避免 incomplete JSON args
- LangSmith tracing 可选, 通过 Settings 配置
- 使用 `/api/query/sql` 做灵活查询

## 内置工具

| Tool | API | 用途 |
|------|-----|------|
| list_notebooks | `/api/notebook/lsNotebooks` | 列出笔记本 |
| list_documents | `/api/query/sql` | 获取文档列表 |
| get_document | `/api/export/exportMdContent` | 读取文档内容 |

## TODO

- [ ] 工具调用失败时让 Agent 尝试修复参数
- [ ] 更多工具: `search_fulltext`, `append_block`
- [ ] 对话历史管理 UI 优化
