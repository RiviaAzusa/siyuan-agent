[简体中文](https://github.com/RiviaAzusa/siyuan-agent/blob/main/README_zh_CN.md)

# SiYuan Agent

An AI Agent plugin built for SiYuan.

It understands your notes and writing habits, then helps with search, drafting, editing, document management, and recurring tasks.

<img src="https://github.com/RiviaAzusa/siyuan-agent/blob/main/samples/sample1.png?raw=1" alt="SiYuan Agent feature example" width="100%" />

## Quick Start

> [!IMPORTANT]
> Configure `API Key` and `API Base URL` in the settings page first.

1. Open `SiYuan Agent` from the SiYuan top bar.
2. For first-time use, run `/init` so the Agent can learn your document structure and writing style.
3. Ask questions directly, or let it search, summarize, create, append, edit, and move documents.
4. Create scheduled tasks, for example: "Every morning at 9, summarize what I did yesterday and write it into today's journal."

## Features

- Restrained UI that blends into different SiYuan themes.
- Interaction and workflow design inspired by mature Agent products:
  - Combines multiple retrieval tools and explorer agents to search note context like a codebase.
  - Automatically compresses context in the background, and manages long tasks with Todo.
- Scheduled tasks: delegate recurring work to the Agent.

## Roadmap

- Tool permission management
- Visual edit history and rollback
- ACP protocol exposure
- ... (tentative, issues are welcome)

## Tech Stack

- [LangChain](https://js.langchain.com/): Agent, tool calling, and streaming runtime
- [SiYuan Plugin API](https://github.com/siyuan-note/siyuan): SiYuan plugin integration and document operations
- TypeScript
- Webpack
- Sass
- Vitest

## Installation

### Bazaar

Install `SiYuan Agent` from the SiYuan community bazaar and enable it.

### Manual

1. Download `package.zip` from the latest release.
2. Extract it to `data/plugins/siyuan-agent/` in your SiYuan workspace.
3. Restart SiYuan and enable the plugin.

## Configuration

After enabling the plugin, fill in:

- `API Base URL`
- `API Key`
- `Provider`
- `Model`

Optional settings:

- `Custom Instructions`
- `Guide Document`
- `Default Notebook`
- `LangSmith Tracing`

## Development

```bash
npm install
npm run build
npm run test
```

## Feedback

Feature ideas, bug reports, and improvements are welcome via [Issue](https://github.com/RiviaAzusa/siyuan-agent/issues) or Pull Request.

## License

MIT
