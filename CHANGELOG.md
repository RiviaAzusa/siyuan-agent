# Changelog

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
