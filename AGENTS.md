# AGENTS Notes

- 使用 `uv` 管理 Python 环境；需要环境变量时使用 `uv run --env-file .env ...`。
- 桌面端 `AI Agent` 使用顶部栏按钮切换右侧/下侧 custom tab，不占用 dock；顶栏图标右键提供“打开到右侧 / 打开到下侧 / 设置”。
- 聊天面板最近会话列表保持克制、紧凑；展开时默认显示 3 条，并在面板内继续展开更多，会话标题与日期同列展示，顶部会话栏仅保留标题与展开箭头，避免大气泡/大卡片。
- 文档树相关工具优先使用 SiYuan 原生 `filetree` API，避免直接 SQL 枚举文档。
- `recent_documents` 仅允许用受限 SQL 查询最近文档 ID，再逐篇读取文档内容构建摘要。
- 只记录 SiYuan 本体事实的说明放在 `.ai/siyuan_facts.md`。
