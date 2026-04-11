# SiYuan Agent Improvement Log

## Session: 2026-04-10 13:54 – ~17:54

### Phase 1: Codebase Audit & Bug Fixes
- **13:54**: Started codebase exploration. Read all core files, types, UI, tools, tests.
- **14:00**: Baseline: 35 tests pass, build succeeds (4 webpack warnings about bundle size).
- **Identified bugs**:
  1. 400 error: "function.arguments must be in JSON format" — some models (code models) don't handle empty args `{}` well. Need to ensure tool schemas with empty objects have proper JSON.
  2. Tool result UI shows both `""` and the actual JSON — empty string tool result should be filtered.
  3. `get_weather` test tool is still in production tools list.

### Phase 2: Multi-Model Management System
- Implement `ModelConfig` interface with provider/model/baseURL/apiKey
- Model registry stored in plugin settings
- Per-conversation model selection via session metadata
- Sub-agent uses configurable "cheap model" setting
- Settings UI for model management

### Phase 3: Bug Fixes
- Fix empty tool result display
- Fix 400 error for models that reject empty function arguments
- SQL injection in search tools (sanitize inputs)

### Phase 4: Better Prompts
- Improve system prompt structure and clarity
- Add date/time awareness
- Better tool selection guidance

### Phase 5: Test Coverage
- Add tests for tools (unit level with mocked fetch)
- Add tests for compaction
- Add tests for UI message builder edge cases
- Add tests for model config management

### Phase 6: UI Polish
- Model selector in chat panel
- Improve tool result display
- Fix visual bugs

---

## Work Log

### 14:05 — Starting Phase 2: Multi-Model Management

Added to `types.ts`:
- `ModelConfig` interface with id/name/provider/model/apiBaseURL/apiKey/maxTokens/temperature
- `MODEL_PROVIDER_PRESETS` (OpenAI, DeepSeek, Anthropic, SiliconFlow, Custom)
- `resolveModelConfig()` / `resolveSubAgentModelConfig()` / `genModelId()`
- Extended `AgentConfig` with models/defaultModelId/subAgentModelId
- Extended `SessionData` with per-conversation modelId

### ~14:10 — System Prompt Improvements (Phase 4)

- Restructured BUILTIN_SYSTEM_PROMPT with clear sections (时间/工具/流程/注意事项)
- Added `{{CURRENT_DATETIME}}` placeholder with `buildSystemPrompt()` function
- Date-aware prompt: includes year/month/day/weekday/time

### ~14:12 — Agent Core Updates

Updated `agent.ts`:
- Uses `resolveModelConfig()` to get model settings
- Uses `buildSystemPrompt()` for date-aware prompts
- Added `modelOverride` parameter for per-conversation model switching

Updated `sub-agent.ts`:
- Uses `resolveSubAgentModelConfig()` for cheaper sub-agent model
- Passes model override to makeAgent

Updated `chat-panel.ts`:
- Per-session model override via `resolveModelConfig(config, sessionModelId)`
- Added model selector UI (`<select>`) in bottom bar
- `refreshModelSelector()` updates options from config
- Session switch refreshes model selector
- Improved `appendToolResultToElement` to skip empty results
- Enhanced `showStreamError` with friendly messages for common API errors (400/401/429/quota)

### ~14:13 — Bug Fixes (Phase 3)

1. **Empty tool result display**: Added empty/whitespace check in `appendToolResultToElement`
2. **SQL injection**: Sanitized keyword/notebook in `searchDocumentsTool` with `replace(/'/g, "''")`
3. **Weather tool removed**: Deleted `getWeatherTool` definition and removed from `getDefaultTools`
4. **400 error**: Added friendly error messages for "function.arguments" JSON errors with model switching advice

### ~14:14 — Settings UI: Model Management

Added to `index.ts`:
- Full model list UI with add/edit/delete in settings
- Model editor dialog (provider presets, name, model, API URL, key, temperature)
- Default model selector dropdown
- Sub-agent model selector dropdown
- Model configs saved/loaded in confirmCallback/open

Added CSS in `index.scss`:
- `.agent-model-list` styles (item cards, actions)
- `.agent-model-editor-overlay` / `.agent-model-editor` (modal dialog)
- `.chat-model-selector` (compact in-chat selector)

### ~14:15 — Tests

- `test/model-config.test.ts`: 12 tests for resolveModelConfig, resolveSubAgentModelConfig, genModelId, buildSystemPrompt
- `test/compaction.test.ts`: 10 tests for shouldCompact, compactMessages
- Updated `test/sub-agent-tool.test.ts` for new model override parameter
- **Total: 57 tests passing (up from 35)**

### ~14:20 — SQL Injection Fixes (All SQL Interpolation Points)

Created `sqlEscape()` helper function in `tools.ts`:
- Applied to ALL SQL string interpolation points (6 locations across tools)
- Fixed: `getDocumentBlocksTool`, `editBlocksTool`, `searchDocumentsTool`, `searchTodosTool`, `getTodoStatsTool`
- Also fixed `index.ts` guide doc search SQL

### ~14:30 — Todo Tools

Added 3 new task management tools:
- `search_todos`: Search task list items by status/keyword/notebook via SQL
- `toggle_todo`: Toggle checkbox completion via getBlockKramdowns + updateBlock
- `get_todo_stats`: Completion statistics (total/done/todo/percentage)
- Registered all 3 in getDefaultTools, updated system prompt

### ~14:40 — Sub-Agent Error Boundary

- `invokeSubAgentSafe()` wrapper: catches errors, returns friendly message
- Output truncation guard (8000 char limit) with `...(已截断)` suffix
- Re-throws AbortError to not swallow cancellations
- Empty results return `[子智能体未返回有效结果]`

### ~14:45 — Stream Idle Timeout

- 120-second per-chunk idle timeout in runAgentStream
- Promise.race between chunk promise and timeout promise
- Proper timer cleanup on each chunk

### ~14:50 — Better Tool Error Detection & Compaction Prompt

- Expanded error pattern regex: `Error:`, `[子智能体执行失败]`, `ToolError:`, `"error":` patterns
- Improved compaction summary prompt with structured preservation rules and 2000 char limit

### ~15:00 — Reasoning/Thinking Display

- Stream-runtime emits `reasoning_delta` events for models like DeepSeek-R1
- Chat panel renders collapsible "💭 思考中…" section during streaming
- Auto-closes when text content starts arriving
- Styled with dedicated CSS

### ~15:10 — Dark Mode & UI Polish

- Replaced all hardcoded `rgba(255,255,255,...)` with theme-aware CSS variables
- Used `color-mix()` and `var(--agent-surface-soft)` throughout
- Session bar, bottom bar, context bar, tasks header all fixed
- Auto-resize textarea (min 48px, max 200px, reduced initial rows to 2)

### ~15:15 — Tests Round 2

- `test/tools.test.ts`: 11 tests for tool registry, SQL escape, error detection
- Updated `test/sub-agent-tool.test.ts`: 3 new tests (error boundary, abort re-throw, output truncation)
- **Total: 71 tests passing, 4 skipped**

---

## Session 2: Continued Improvements

### ~02:35 — New Tools: Document Outline & Read Block

- `get_document_outline`: Get heading structure (TOC) of a document
- `read_block`: Read individual block's kramdown content by ID
- Registered in getDefaultTools, getLookupTools, updated system prompt
- Added display titles and categories in chat-panel

### ~02:38 — Auto-Compaction

- Added automatic context compaction after agent stream completes
- Uses `shouldCompact()` (>10 turns or >12000 chars) to decide
- Creates ChatOpenAI model and calls `compactMessages()` with source "auto"
- Best-effort: errors don't block session save

### ~02:40 — MCP (Model Context Protocol) Client System

Created `src/core/mcp-client.ts`:
- `McpClient`: JSON-RPC client for MCP servers via Streamable HTTP transport
- Supports session management (Mcp-Session-Id header)
- SSE response parsing
- `initialize()` → `tools/list` → `tools/call` lifecycle
- `mcpToolsToLangChain()`: Converts MCP tool definitions to LangChain tools
- JSON Schema → Zod schema conversion for tool parameters
- `McpManager`: Orchestrates multiple MCP server connections

Integrated into plugin:
- Added `McpServerConfig` interface to types.ts
- Added `mcpServers` field to `AgentConfig`
- Plugin loads MCP servers on startup, reconnects on settings save
- MCP tools automatically included in agent's tool list
- MCP settings UI in plugin settings (add/edit/delete/enable/disable servers)
- Connection status display (✅ connected / ❌ failed / ⏸ disabled)
- `test/mcp-client.test.ts`: 7 tests

### ~02:43 — Slash Commands: /help and /clear

- `/help`: Shows interactive help with available commands, tool list, and tips
- `/clear`: Shortcut for starting a new session
- Styled help message with tables, collapsible tool list, keyboard shortcuts

### ~02:44 — Welcome Screen

- New empty session shows welcome screen with:
  - 📚 icon and title
  - Quick action buttons (总结最近笔记 / 浏览笔记结构 / 搜索笔记 / 查看待办)
  - Clicking a button populates the input field
  - Search button positions cursor between 「」 quotes

### ~02:45 — Markdown Renderer Tests

- Added 14 more test cases to `test/markdown.test.ts` (was 1)
- Covers: headings, bold/italic, inline code, code blocks, links, lists, blockquotes, HR, strikethrough, tables, alignment, HTML escaping, empty input, mixed content

### ~02:46 — Improved Message Dedup

- Replaced fragile JSON.stringify comparison for tool calls with ID/name-based comparison
- More robust: avoids false positives from argument serialization differences

### Current Status

- **Build**: ✅ Passes (4 pre-existing webpack bundle size warnings)
- **Tests**: ✅ 92 pass, 4 skipped (up from 35)
- **Features added**: Multi-model management, MCP client system, Todo tools, Document outline/read block tools, Reasoning display, Welcome screen, /help and /clear commands, Auto-compaction
- **Bugs fixed**: Empty tool results, SQL injection (6 points), 400 error handling, Sub-agent error boundary, Stream idle timeout, Dark mode, Message dedup