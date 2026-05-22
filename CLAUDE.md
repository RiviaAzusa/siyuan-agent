# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test

```bash
npm run dev          # Dev build with watch (Webpack 5 + esbuild-loader)
npm run build        # Production build → dist/index.js + dist/index.css + package.zip
npm run test         # Vitest single pass
npm run test:watch   # Vitest watch mode
npm run lint         # ESLint --fix with cache
./deploy.sh          # Build + copy to local SiYuan plugin directory
```

Single test file: `npx vitest run test/markdown.test.ts`

## Architecture

SiYuan Agent — AI assistant plugin for the SiYuan note-taking app. Vercel AI SDK agent with streaming, tool calling, and MCP support.

### Entry & Lifecycle
- `src/index.ts`: Plugin class → creates Dock (mobile) / Tab (desktop), registers `editorCallback` (`⌥⌘L`) for send-to-chat, right-click context menu. Lifecycle: `onload` → `onLayoutReady` → `onunload` → `uninstall`

### Core (`src/core/`)
- **`agent.ts`**: `prepareAgent()` — creates model + tools + system prompt for AI SDK. Supports guide doc, default notebook, custom instructions, reasoning effort
- **`stream-runtime.ts`**: Core streaming engine. Manual agent loop using AI SDK `streamText()` with `maxSteps: 1` per iteration. Processes `fullStream` chunks (text-delta, reasoning, tool-call, tool-result). Tool UI events collected via `experimental_context` writer. Handles abort, idle timeout (120s)
- **`tool-types.ts`**: `createTool()` wrapper bridging AI SDK's `tool()` with custom `ToolContext` (writer for UI events)
- **`compaction.ts`**: Splits messages into turns, summarizes older turns via AI SDK `generateText()`, preserves todo plans
- **`session-store.ts`**: Uses native `fetch` (not SDK's `fetchPost` which has a hanging-Promise bug)
- **`sub-agent.ts`**: `explore_notes` — sub-agent using AI SDK `generateText()` with its own recursive tool loop (12 steps max)
- **`mcp-client.ts`**: MCP (Model Context Protocol) client with Streamable HTTP transport. `mcpToolsToAiSdk()` converts MCP tools to AI SDK format

### LLM Providers (`src/llms/`)
- **`ai-sdk-provider.ts`**: Model factory for AI SDK. Supports OpenAI-compatible, Anthropic (`@ai-sdk/anthropic`), DeepSeek (`@ai-sdk/deepseek`). `buildProviderOptions()` maps reasoning effort to provider-specific options

### Tools (`src/core/tools/`)
19 tools, all Zod-schema validated, all use `siyuanFetch` (native fetch wrapper):

| Category | Tools |
|----------|-------|
| Lookup | `list_notebooks`, `list_documents`, `recent_documents`, `get_document`, `get_document_blocks`, `get_document_outline`, `read_block`, `search_fulltext`, `search_documents` |
| Change | `append_block`, `edit_blocks`, `create_document`, `move_document`, `rename_document` |
| Planning | `write_todos` |
| Scheduling | `create/list/update/delete_scheduled_task` |
| Meta | `explore_notes` (sub-agent with own lookup toolset) |

`delete_document` is exported but **not registered** (safety). Import and register manually if needed.

### UI (`src/ui/`)
- **`chat-panel.ts`** (74KB): Main orchestrator, delegate pattern → `SettingsView`, `TasksView`, `Autocomplete`
- **`settings-view.ts`** (39KB): Model service management, MCP config, guide doc
- **`markdown.ts`**: Zero-dependency MD→HTML renderer
- **`chat-helpers.ts`**: Pure functions for message type detection, HTML escaping, tool display

### Types (`src/types/`)
- Barrel re-export via `src/types/index.ts`, import via `"../types"`
- `model-config.ts`: Multi-model registry (`ModelServiceConfig` grouped by provider, `ModelConfig` per model), legacy flat migration
- `session.ts`: `SessionData` with dual messages — `messages` (LLM context, compressible) + `messagesUi` (user-visible, never compressed). Supports `chat` and `scheduled_task` kinds
- `tool-events.ts`: `ToolUIEvent` types for rendering tool activity cards
- `prompts.ts`: System prompt, init prompt, slash commands

### Styles (`src/styles/`)
SCSS with `@use` partials. Uses SiYuan CSS variables (`--b3-theme-*`).

## Key Design Decisions

- **Native fetch over SDK**: `siyuanFetch` uses `fetch()` directly; SDK's `fetchPost` has a hanging-Promise bug
- **Auto-apply + Diff + Undo**: Edit tools apply changes automatically, return diff info for git-style UI with undo
- **Tool events via writer**: Tools emit structured JSON through `experimental_context.writer` (AI SDK context passing), collected per-step and parsed into typed `ToolUIEvent` objects
- **Manual agent loop**: `stream-runtime.ts` uses `streamText()` with `maxSteps: 1` per iteration for fine-grained control over tool execution, UI events, and abort handling. Enables future tool approval checkpoints
- **Document tree via filetree API**: Prefer SiYuan native `filetree` API over SQL enumeration; `recent_documents` uses restricted SQL only for IDs, then reads individually
- **`edit_blocks` diff**: `stripIAL()` filters kramdown `{: ...}` markers before comparison; LCS line-level diff algorithm, no external deps

## Session Management (chat-panel.ts)

- Title lives only in `SessionIndex.sessions[].title`, not in `SessionData.title`
- `newSession()` checks `messagesEl.children.length === 0` (UI state), not `state`
- `loadSession()` on miss returns `{ id: <passed id>, ... }` (no random new id, prevents key drift)
- `deleteSession()` picks next session by `updated` descending
- `title`/`updated` only written after stream completes (prevents stale reads)
- `switchSession()` saves current session first

## Message Format

Messages use a simple flat JSON format (not LangChain serialized dicts):
```json
{ "role": "user", "content": "..." }
{ "role": "assistant", "content": "...", "reasoning": "...", "toolCalls": [{ "id": "...", "name": "...", "args": {...} }] }
{ "role": "system", "content": "..." }
{ "role": "tool", "toolCallId": "...", "toolName": "...", "result": "..." }
```

Legacy `lc:1` LangChain format is auto-converted on read via `mergeState()` (lazy migration). Old sessions are migrated on first load.

## SiYuan Plugin API Gotchas

### Command Callbacks (ICommand)
- `editorCallback(protyle)`: fires when editor has focus; `globalCallback`: fires when app unfocused
- `callback`: generic, only fires when no other callback type is defined
- If any non-`callback` callback exists on a command, `callback` is **not** triggered by global keydown

### Editor Keydown Interception
- Cross-block selection causes `stopPropagation()` + `return` — only `⌘C` passes through
- `editorCallback` won't fire during cross-block selection
- Block-level selection marked by `.protyle-wysiwyg--select` CSS class

### Getting Selected Text
```typescript
editorCallback: (protyle) => {
    // 1. Text selection: window.getSelection() + verify inside wysiwyg
    // 2. Block selection fallback: querySelectorAll(".protyle-wysiwyg--select")
}
```
Right-click menu: use `open-menu-content` event's `e.detail.range`.
