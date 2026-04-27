[简体中文](https://github.com/RiviaAzusa/siyuan-agent/blob/main/README_zh_CN.md)

# SiYuan Agent

An AI agent plugin for SiYuan. Ask questions, search notes, read documents, edit content, and run recurring tasks without leaving your workspace.

## Feature Example

<img src="https://github.com/RiviaAzusa/siyuan-agent/blob/main/samples/sample1.png?raw=1" alt="SiYuan Agent feature example" width="50%" />

## What It Does

- Open the chat panel from the top bar and place it on the right or bottom side.
- Use a unified settings interface for model services, default models, knowledge base defaults, and tracing.
- Use the plugin in English or Simplified Chinese.
- Connect any OpenAI-compatible model with a custom base URL, API key, and model name.
- Use built-in DeepSeek provider support, including reasoning-capable models.
- Select reasoning effort per conversation for supported models.
- Use real note tools for search, read, append, block editing, move, and rename operations.
- Display responses in layers: main answer, lookup tools, and change tools.
- Keep recent sessions compact, with 3 shown by default and more available on demand.
- Send selected editor content directly into the chat context.
- Run `/init` to build a reusable guide document for the agent.
- Create recurring tasks for summaries, reminders, and routine note maintenance, with a manual "Run now" action.
- Optionally enable LangSmith tracing for debugging and evaluation.

## Built-in Tools

### Notes and Documents

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

### Scheduled Tasks

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

After enabling the plugin, fill in:

- `API Base URL`, for example `https://api.openai.com/v1`
- `API Key`
- `Provider`, such as OpenAI-compatible or DeepSeek
- `Model`, for example `gpt-4o`, `gpt-4.1`, or another compatible model
- `Custom Instructions`, optional
- `Guide Document`, optional but recommended
- `Default Notebook`, optional default target for write operations
- `LangSmith Tracing`, optional

The settings view is cached after opening, and scheduled tasks are loaded lazily so the chat panel can start faster.

## Development

```bash
npm install
npm run build
npm run test
```

Repository: [RiviaAzusa/siyuan-agent](https://github.com/RiviaAzusa/siyuan-agent)

## License

MIT
