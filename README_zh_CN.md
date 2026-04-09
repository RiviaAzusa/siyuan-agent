[English](./README.md)

# SiYuan Agent

思源笔记AI-Agent插件(Beta)


![SiYuan Agent 预览](./preview.png)

## 功能概览
1. 对话界面UI
- 顶栏按钮打开聊天面板，右键可选择“打开到右侧 / 打开到下侧”。
- 支持流式输出，并把工具行为按“查找 / 更改”分组展示。
- 会话列表紧凑展示，同时提供独立的定时任务视图。
- 支持自定义 `API Base URL`、`API Key` 和模型名。
- 支持把编辑器选中文本直接发送到对话上下文。
- 支持在思源内部搜索、读取、创建、追加、编辑、移动、重命名文档。
- 内置 `/init` 命令，可帮助 Agent 建立你的笔记库使用指南。
- 可选接入 LangSmith 追踪，便于排查调用链。

## 内置工具

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
- `create_scheduled_task`
- `list_scheduled_tasks`
- `update_scheduled_task`
- `delete_scheduled_task`

## 安装

### 从集市安装

在思源社区集市中搜索 `SiYuan Agent`，安装并启用即可。

### 手动安装

1. 从 Release 下载 `package.zip`
2. 解压到思源工作空间下的 `data/plugins/siyuan-agent/`
3. 重启思源并启用插件

## 配置项

启用后，在插件设置中填写：

- `API Base URL`：例如 `https://api.openai.com/v1`
- `API Key`
- `Model`：例如 `gpt-4o`、`gpt-4.1` 或其他兼容模型
- `Custom Instructions`：可选，补充固定行为偏好
- `Guide Document`：可选但推荐，作为长期用户指南
- `Default Notebook`：可选，写入类任务的默认目标笔记本
- `LangSmith Tracing`：可选，用于调试和追踪

## 推荐使用方式

1. 从顶栏打开聊天面板。
2. 直接提问，或使用 `Option + Command + L` 把当前选中文本发送给 AI。
3. 让 Agent 在思源里搜索、总结、创建或编辑文档。
4. 第一次使用时执行 `/init`，帮助 Agent 了解你的笔记结构和写作习惯。
5. 需要周期性总结、提醒或固定流程时，直接创建定时任务。

## 注意事项

- 需要你自行提供可用的模型服务和 API Key。
- 写入类操作会直接作用于真实思源内容，重要文档建议自行复核。
- 插件会优先调用真实工具，而不是凭空生成笔记内容。
- 默认不开放删除文档能力，以降低误操作风险。

## 开发

```bash
npm install
npm run build
npm run test
```

项目地址：[RiviaAzusa/siyuan-agent](https://github.com/RiviaAzusa/siyuan-agent)

## 许可证

MIT



## 主包留言

主包本职工作是开发，会用Siyuan记录工作情况，所以本插件的功能基本都源于日常使用偷懒。
1. 建议首先使用`/init`(参考Claude Code), 让Agent了解仓库基本路径，你的写作风格。
2. ...主包用的比较多的是 "帮我写周报","帮我写月报";
3. CRON功能开发中, 目的是定期生成每日总结, 将日记归档之类。

---
为什么叫这个名字... 因为翻遍了社区的插件，感觉都没这个好用。
（虽然缺MCP，缺Skill，缺Sub-Agent，缺模型列表 ... ...  但先分享给大家吧。