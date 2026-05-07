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

SiYuan Agent — AI assistant plugin for the SiYuan note-taking app. LangChain agent with streaming, tool calling, and MCP support.

### Entry & Lifecycle
- `src/index.ts`: Plugin class → creates Dock (mobile) / Tab (desktop), registers `editorCallback` (`⌥⌘L`) for send-to-chat, right-click context menu. Lifecycle: `onload` → `onLayoutReady` → `onunload` → `uninstall`

### Core (`src/core/`)
- **`agent.ts`**: `makeAgent()` — LangChain `createAgent()` with customizable system prompt (guide doc, default notebook, custom instructions). Auto-compacts after 30 messages via `summarizationMiddleware`
- **`stream-runtime.ts`**: Core streaming engine (~590 lines). Processes `agent.stream()` with three modes: `messages` (token deltas), `values` (state snapshots), `custom` (tool UI events). Handles abort, idle timeout (120s), reasoning content (DeepSeek thinking), tool call dedup
- **`chat-model.ts`**: LLM factory — `ChatOpenAI` or custom `SiYuanChatDeepSeek` (injects `reasoning_content`). Supports `ReasoningEffort`: `default`, `off`, `high`, `xhigh`
- **`compaction.ts`**: Splits messages into turns, summarizes older turns, preserves todo plans
- **`session-store.ts`**: Uses native `fetch` (not SDK's `fetchPost` which has a hanging-Promise bug)
- **`sub-agent.ts`**: `explore_notes` — sub-agent with its own recursive tool loop (12 steps max)

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
- **`settings-view.ts`** (39KB): Model service management, MCP config, guide doc, LangSmith tracing
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
- **Tool events via writer**: Tools emit structured JSON through `runtime.writer()`, parsed into typed `ToolUIEvent` objects
- **Streaming with state recovery**: `stream-runtime.ts` builds recoverable state incrementally
- **Document tree via filetree API**: Prefer SiYuan native `filetree` API over SQL enumeration; `recent_documents` uses restricted SQL only for IDs, then reads individually
- **`edit_blocks` diff**: `stripIAL()` filters kramdown `{: ...}` markers before comparison; LCS line-level diff algorithm, no external deps

## Session Management (chat-panel.ts)

- Title lives only in `SessionIndex.sessions[].title`, not in `SessionData.title`
- `newSession()` checks `messagesEl.children.length === 0` (UI state), not `state`
- `loadSession()` on miss returns `{ id: <passed id>, ... }` (no random new id, prevents key drift)
- `deleteSession()` picks next session by `updated` descending
- `title`/`updated` only written after stream completes (prevents stale reads)
- `switchSession()` saves current session first

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
