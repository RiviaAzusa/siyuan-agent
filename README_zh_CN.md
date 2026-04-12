[English](https://github.com/RiviaAzusa/siyuan-agent/blob/main/README.md)

# SiYuan Agent

面向思源笔记的 AI Agent 插件。你可以直接在思源里提问、检索笔记、读取文档、改写内容，并把重复性工作交给定时任务。

## 功能示例

<img src="https://github.com/RiviaAzusa/siyuan-agent/blob/main/samples/sample1.png?raw=1" alt="SiYuan Agent 功能示例" width="50%" />

## 它能做什么

- 在思源顶部栏打开聊天面板，并切换到右侧或下侧区域，不占用传统 dock。
- 使用 OpenAI 兼容模型进行对话，支持自定义 `API Base URL`、`API Key` 和模型名。
- 在回答过程中调用真实工具，完成笔记检索、文档读取、内容追加、块级编辑、移动和重命名。
- 将工具行为按“正文 / 查找 / 更改”分层展示，查找类操作默认更克制，更改类操作更醒目。
- 维护紧凑的最近会话列表，默认展示 3 条，并可在面板内继续展开查看更多历史。
- 把编辑器中选中的内容直接送入对话上下文，减少复制粘贴。
- 通过 `/init` 探索你的笔记库，生成一份长期可复用的用户指南文档。
- 创建和管理定时任务，用于日报、周报、提醒、周期性整理等重复流程。
- 可选接入 LangSmith，便于调试调用链和评估效果。

## 适合的使用场景

- “帮我基于最近修改的文档整理今天的工作进展。”
- “搜索和这个项目相关的笔记，整理成会议纪要。”
- “把这段草稿追加到某篇文档末尾，再顺手改一下标题。”
- “每周五下班前自动生成一份本周总结。”

## 内置工具

### 笔记与文档

- `list_notebooks`
- `list_documents`
- `recent_documents`
- `search_fulltext`
- `get_document`
- `get_document_blocks`
- `create_document`
- `append_block`
- `edit_blocks`
- `move_document`
- `rename_document`

### 定时任务

- `create_scheduled_task`
- `list_scheduled_tasks`
- `update_scheduled_task`
- `delete_scheduled_task`

## 安装

### 从思源集市安装

在思源社区集市中搜索 `SiYuan Agent`，安装并启用即可。

### 手动安装

1. 从 Release 下载 `package.zip`。
2. 解压到思源工作空间下的 `data/plugins/siyuan-agent/`。
3. 重启思源并启用插件。

## 配置说明

启用插件后，在设置页补充以下内容：

- `API Base URL`：例如 `https://api.openai.com/v1`
- `API Key`
- `Model`：例如 `gpt-4o`、`gpt-4.1` 或其他兼容模型
- `Custom Instructions`：可选，用于补充固定行为偏好
- `Guide Document`：可选但推荐，作为长期用户指南文档
- `Default Notebook`：可选，作为写入任务默认目标笔记本
- `LangSmith Tracing`：可选，用于调试与追踪

## 快速开始

1. 从顶部栏打开聊天面板。
2. 直接提问，或使用 `Option + Command + L` 把当前选中文本发给 Agent。
3. 让 Agent 在思源中搜索、总结、创建或编辑文档。
4. 首次使用建议执行 `/init`，帮助 Agent 了解你的笔记结构和写作习惯。
5. 需要固定频率执行的任务时，创建对应的定时任务。

## 注意事项

- 你需要自行提供可用的模型服务和 API Key。
- 写入类操作会直接作用于真实思源内容，重要文档建议自行复核。
- 插件优先调用真实工具，而不是编造“看起来合理”的结果。
- 当前默认不暴露删除文档能力，以降低误操作风险。

## 开发

```bash
npm install
npm run build
npm run test
```

项目地址：[RiviaAzusa/siyuan-agent](https://github.com/RiviaAzusa/siyuan-agent)

## 许可证

MIT
