# AGENTS Notes

## Project Structure

```
src/
  index.ts                  # Plugin entry: Dock/Command/Setting
  types/                    # Type definitions and constants
    index.ts                #   Barrel re-export
    model-config.ts         #   ModelConfig, AgentConfig, DEFAULT_CONFIG, helpers
    tool-events.ts          #   ToolUIEvent, AgentStreamUiEvent, UiMessage etc
    session.ts              #   SessionData, SessionIndex, AgentState, ScheduledTaskMeta
    prompts.ts              #   BUILTIN_SYSTEM_PROMPT, INIT_PROMPT, SLASH_COMMANDS
  core/
    agent.ts                # LangChain Agent (makeAgent, makeTracer)
    stream-runtime.ts       # Agent streaming (runAgentStream, mergeState)
    compaction.ts           # Message compaction (compactMessages, shouldCompact)
    session-store.ts        # Session persistence (SessionStore, PluginStorage)
    scheduled-task-manager.ts # Scheduled task management
    ui-message-builder.ts   # UiMessage builder
    mcp-client.ts           # MCP client
    tools/                  # Tool definitions
      index.ts              #   Barrel: getDefaultTools, getLookupTools
      siyuan-api.ts         #   siyuanFetch, emitToolEvent, emitActivity, sqlEscape
      notebook-tools.ts     #   list_notebooks, list_documents, recent_documents
      document-tools.ts     #   get_document, get_document_blocks, outline, search
      edit-tools.ts         #   append_block, edit_blocks, create/move/rename/delete doc
      plan-tools.ts         #   write_todos (agent task plan management)
      scheduled-tools.ts    #   Scheduled task CRUD tools
  ui/
    chat-panel.ts           # ChatPanel orchestrator
    chat-helpers.ts         # Pure functions: msgType, escapeHtml, normalizeMessagesForDisplay etc
    autocomplete.ts         # Autocomplete delegate: @mention + slash command
    settings-view.ts        # SettingsView delegate: settings page rendering and persistence
    tasks-view.ts           # TasksView delegate: scheduled task list and editor
    markdown.ts             # Markdown to HTML renderer
    task-run-group.ts       # Task run grouping
  styles/
    index.scss              # Style entry, @use all partials
    _layout.scss            # Layout and panel structure
    _bottom-bar.scss        # Bottom bar and composer
    _settings.scss          # Settings panel
    _messages.scss          # Message bubbles
    _tools.scss             # Tool cards
    _session.scss           # Session bar
    _session-list.scss      # Session list
    _diff.scss              # Diff view
    _model-settings.scss    # Model editor
    _extras.scss            # Misc and tasks
test/                       # Vitest tests (94 passing)
```

## Build and Test

- **Build**: `npm run build` (Webpack 5 + esbuild-loader, output `dist/index.js` + `dist/index.css`)
- **Test**: `npx vitest run` (94 tests passing, 4 skipped)
- **Deploy**: `./deploy.sh` (build + copy to SiYuan plugin directory)

## Architecture Conventions

### Delegate Pattern
`ChatPanel` is the main orchestrator, delegating independent view logic to delegate classes:
- `Autocomplete` — injected via `textareaEl`, exposes `handleInput()`, `handleKey()`, `hide()`, `isActive`
- `SettingsView` — injected via `SettingsViewContext` interface, exposes `render()`
- `TasksView` — injected via `TasksViewContext` interface, exposes `render()`, `openTaskEditor()`

### Types and Barrel Re-export
- All types exported through `src/types/index.ts` barrel, import via `"../types"`
- All tools exported through `src/core/tools/index.ts` barrel

### Session Persistence
- `SessionStore` uses `PluginStorage` interface (native fetch), not SDK `fetchPost` (has bug)
- Dual message architecture: `messages` (LLM context, compressible) + `messagesUi` (user-visible, never compressed)

## Design Decisions

- Desktop `AI Agent` uses top bar button to toggle right/bottom custom tab, does not occupy dock
- Chat panel recent session list stays compact; shows 3 by default
- Chat messages layered display: body / lookup tools / change tools; lookup tools collapsed by default
- Document tree tools prefer SiYuan native `filetree` API, avoid direct SQL enumeration
- `recent_documents` only uses restricted SQL to query recent doc IDs, then reads each document individually
- SiYuan-specific facts documented in `.ai/siyuan_facts.md`
