# Changelog

## 0.1.5

- Added block highlight effect when editing blocks.
- Fixed simultaneous block editing flicker issue.
- Enhanced error handling for tool results and improved message display logic.
- Refactored edit_blocks tool logic and enhanced output handling.
- Disabled cross-document block editing to prevent errors.
- Removed unused LangSmith tracing code.
- Updated font color and icon.

中文：

- 编辑块时增加块高亮效果。
- 修复同时编辑多个块时的闪烁问题。
- 增强工具结果的错误处理，优化消息展示逻辑。
- 重构 edit_blocks 工具逻辑，优化输出处理。
- 禁用跨文档块编辑以防止错误。
- 移除未使用的 LangSmith 追踪代码。
- 更新字体颜色和图标。

## 0.1.4

- Added basic support for Chinese models based on the Anthropic protocol.
- Optimized chat UI: agent processing steps are now auto-collapsed.
- Migrated the underlying system from LangChain to Vercel AI SDK and optimized code architecture.

中文：

- 增加中国模型的基本支持，基于 Anthropic 协议。
- 优化对话 UI，Agent 处理过程将自动折叠。
- 系统底层从 LangChain 迁移到 Vercel AI SDK，并优化代码架构。

## 0.1.3

- Improved the welcome screen.
- Improved `/init`.
- Improved user onboarding.

中文：

- 优化欢迎页。
- 优化 `/init` 功能。
- 优化用户引导。

## 0.1.2

- Added built-in model provider support for DeepSeek.
- Improved the model settings UI.
- Added per-chat reasoning effort selection for supported models.
- Added a "Run now" action for scheduled tasks.
- Upgraded Node packages to address [issue #1](https://github.com/RiviaAzusa/siyuan-agent/issues/1), where running a scheduled task immediately could freeze the SiYuan Electron window.

中文：

- 增加 DeepSeek 模型供应商内置支持。
- 优化模型设置界面 UI。
- 对话支持选择思考深度。
- 定时任务增加“立即执行”功能。
- 升级 Node packages 以修复 [issue #1](https://github.com/RiviaAzusa/siyuan-agent/issues/1)：点击定时任务“立即执行”后 SiYuan Electron 窗口可能卡死。

## 0.1.1

- Added a unified settings interface for model services, default models, knowledge base defaults, and tracing options.
- Added English UI support across plugin labels, chat messages, settings, tools, and built-in prompts.
- Optimized chat state handling, settings view caching, and lazy loading for scheduled tasks.

中文：

- 增加统一设置界面，集中管理模型服务、默认模型、知识库默认项和追踪选项。
- 增加英文界面支持，覆盖插件文案、聊天消息、设置页、工具展示和内置提示词。
- 优化 chat-state、设置界面缓存和定时任务懒加载。

## 0.1.0

- First public release.
- Added the chat panel with streaming responses and grouped tool activity.
- Added notebook and document tools for search, reading, creation, append, edit, move, and rename.
- Added `/init` to build a reusable guide document from the current knowledge base.
- Added scheduled task support for recurring prompts and reminders.
