[English](https://github.com/RiviaAzusa/siyuan-agent/blob/main/README.md)

# SiYuan Agent

专为思源笔记打造的 AI Agent 插件。

它可以在理解笔记内容和个人写作习惯的基础上，协助你完成检索、撰写、编辑、文档管理与周期性任务。

<img src="https://github.com/RiviaAzusa/siyuan-agent/blob/main/samples/sample1.png?raw=1" alt="SiYuan Agent 功能示例" width="100%" />

## 快速开始

> [!IMPORTANT]
> 请先在设置页配置 `API Key` 与 `API Base URL`。

1. 从思源顶部栏打开 `SiYuan Agent`。
2. 首次使用建议输入 `/init`，让 Agent 了解你的文档结构和写作风格。
3. 直接提问，或让它检索、总结、创建、追加、编辑和移动文档。
4. 创建定时任务，例如"每天早上9点总结我昨天干了什么，并写到今天的日记里。"

## 功能&特性

- 界面克制，可融入不同思源主题。
- 参考了多个成熟 Agent 产品的交互与工作流设计：
  - 融合多种检索工具和探索智能体，像检索代码库一样检索笔记上下文。
  - 后台自动压缩上下文，长任务通过 Todo 管理过程。
- 定时任务：支持将定期重复任务交给Agent完成。

## 未来计划

- 工具权限管理
- 编辑记录可视化与回退
- 暴露ACP协议
- ... (暂定, 欢迎提Issue)

## 技术栈

- [LangChain](https://js.langchain.com/)：Agent、工具调用与流式运行
- [SiYuan Plugin API](https://github.com/siyuan-note/siyuan)：思源插件集成与文档操作
- TypeScript
- Webpack
- Sass
- Vitest

## 安装

### 从思源集市安装

在思源社区集市中搜索 `SiYuan Agent`，安装并启用即可。

### 手动安装

1. 从 Release 下载 `package.zip`。
2. 解压到思源工作空间下的 `data/plugins/siyuan-agent/`。
3. 重启思源并启用插件。

## 配置

启用插件后，在设置页填写：

- `API Base URL`
- `API Key`
- `Provider`
- `Model`

可选配置：

- `Custom Instructions`
- `Guide Document`
- `Default Notebook`
- `LangSmith Tracing`

## 开发

```bash
npm install
npm run build
npm run test
```

## 反馈

有功能想法、Bug 反馈或改进建议，欢迎提交 [Issue](https://github.com/RiviaAzusa/siyuan-agent/issues) 或 Pull Request。

## License

MIT
