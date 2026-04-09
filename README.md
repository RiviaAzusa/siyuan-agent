[简体中文](./README_zh_CN.md)

# SiYuan Agent

AI chat and automation for SiYuan. Connect an OpenAI-compatible model, search your notes, read documents, edit content, and run recurring tasks without leaving the workspace.

![SiYuan Agent preview](./preview.png)

## Highlights

- Chat panel opened from the top bar, with right-click actions to open it on the right or bottom.
- Streaming responses with tool activity grouped into lookup and change actions.
- Compact chat history plus a separate scheduled tasks view.
- OpenAI-compatible model setup: custom base URL, API key, and model name.
- Send selected text from the editor directly into the chat context.
- Read and write tools for notebooks and documents inside SiYuan.
- `/init` command to bootstrap a long-lived guide document for the agent.
- Optional LangSmith tracing for debugging.

## Built-in tools

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

## Installation

### Bazaar

Install `SiYuan Agent` from the SiYuan community bazaar and enable it in Settings.

### Manual

1. Download `package.zip` from the latest release.
2. Extract it to `data/plugins/siyuan-agent/` in your SiYuan workspace.
3. Restart SiYuan and enable the plugin.

## Configuration

After enabling the plugin, open its settings and fill in:

- `API Base URL`: for example `https://api.openai.com/v1`
- `API Key`
- `Model`: for example `gpt-4o`, `gpt-4.1`, or another compatible model
- `Custom Instructions`: optional behavior preferences
- `Guide Document`: optional but recommended long-term instruction document
- `Default Notebook`: optional default target for create/write tasks
- `LangSmith Tracing`: optional debugging integration

## Typical workflow

1. Open the panel from the top bar.
2. Ask a question, or send selected editor content with `Option + Command + L`.
3. Let the agent search, read, summarize, create, or edit notes in SiYuan.
4. Use `/init` once to help the agent learn your notebook structure and writing habits.
5. Use scheduled tasks for recurring summaries, reminders, or routine note maintenance.

## Notes

- You need to provide your own model endpoint and API key.
- Write operations act on real SiYuan content, so review important edits.
- The plugin prefers real tool calls over invented answers.
- Destructive document deletion is not exposed by default.

## Development

```bash
npm install
npm run build
npm run test
```

Repository: [RiviaAzusa/siyuan-agent](https://github.com/RiviaAzusa/siyuan-agent)

## License

MIT
