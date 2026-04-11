/* ── Model configuration ────────────────────────────────────────────── */

export interface ModelConfig {
	id: string;
	name: string;
	provider: string;
	model: string;
	apiBaseURL: string;
	apiKey: string;
	/** Max tokens for context window (informational, used for prompt budget) */
	maxTokens?: number;
	/** Default temperature */
	temperature?: number;
}

export interface AgentConfig {
	apiBaseURL: string;
	apiKey: string;
	model: string;
	customInstructions: string;
	panelPosition?: "right" | "bottom";
	guideDoc?: { id: string; title: string } | null;
	defaultNotebook?: { id: string; name: string } | null;
	langSmithEnabled?: boolean;
	langSmithApiKey?: string;
	langSmithEndpoint?: string;
	langSmithProject?: string;
	/** Multi-model registry */
	models?: ModelConfig[];
	/** Default model ID from the registry (falls back to legacy apiBaseURL/apiKey/model) */
	defaultModelId?: string;
	/** Model ID used for sub-agents (cheaper/faster model) */
	subAgentModelId?: string;
	/** MCP server configurations */
	mcpServers?: McpServerConfig[];
}

/* ── MCP (Model Context Protocol) ────────────────────────────────────── */

export interface McpServerConfig {
	/** Unique ID for this MCP server */
	id: string;
	/** Display name */
	name: string;
	/** Server URL (SSE endpoint, e.g. http://localhost:3000/sse) */
	url: string;
	/** Whether this server is enabled */
	enabled: boolean;
	/** Optional API key/token for auth */
	apiKey?: string;
	/** Optional description of what this server provides */
	description?: string;
}

/** Agent 的完整状态，直接存储 values stream 的最后一次输出 */
export interface ToolUIEventText {
	type: "text";
	text: string;
}

export type ToolActivityCategory = "lookup" | "change" | "other";

export type ToolActivityAction =
	| "list"
	| "read"
	| "search"
	| "create"
	| "append"
	| "edit"
	| "move"
	| "rename"
	| "delete"
	| "other";

export interface ToolUIEventActivity {
	type: "activity";
	category: ToolActivityCategory;
	action: ToolActivityAction;
	id?: string;
	path?: string;
	label?: string;
	meta?: string;
	open?: boolean;
}

export interface ToolUIEventCreatedDocument {
	type: "created_document";
	id: string;
	path?: string;
}

export interface ToolUIEventDocumentLink {
	type: "document_link";
	id: string;
	path?: string;
	label?: string;
	open?: boolean;
}

export interface ToolUIEventDocumentBlocks {
	type: "document_blocks";
	id: string;
	path?: string;
	blockCount: number;
	open?: boolean;
}

export interface ToolUIEventAppendBlock {
	type: "append_block";
	parentID: string;
	path?: string;
	blockIDs: string[];
	open?: boolean;
}

export interface ToolUIEventEditBlocks {
	type: "edit_blocks";
	documentIDs: string[];
	primaryDocumentID?: string;
	path?: string;
	editedCount: number;
	open?: boolean;
}

export interface ToolUIEventUnknownStructured {
	type: "unknown_structured";
	raw: string;
	payload?: Record<string, any>;
}

export type ToolUIEventPayload =
	| ToolUIEventText
	| ToolUIEventActivity
	| ToolUIEventCreatedDocument
	| ToolUIEventDocumentLink
	| ToolUIEventDocumentBlocks
	| ToolUIEventAppendBlock
	| ToolUIEventEditBlocks
	| ToolUIEventUnknownStructured;

export interface ToolUIEvent {
	id: string;
	source: "writer";
	toolCallIndex: number;
	toolCallId?: string;
	toolName?: string;
	payload: ToolUIEventPayload;
}

export interface ChunkParserState {
	inputState: AgentState;
	currentState: AgentState | null;
	contentBuffer: string;
	reasoningBuffer: string;
	pendingMessages: any[];
	pendingToolCalls: any[];
	toolUIEvents: ToolUIEvent[];
	lastToolCallIndex: number;
	toolCallMap: Record<string, { index: number; name?: string }>;
	seenToolCallKeys: string[];
}

export type AgentStreamUiEvent =
	| {
		type: "text_delta";
		text: string;
	}
	| {
		type: "reasoning_delta";
		text: string;
	}
	| {
		type: "tool_call_start";
		toolName: string;
		toolCallIndex: number;
		toolCallId?: string;
		args?: unknown;
	}
	| {
		type: "tool_result";
		toolCallId?: string;
		result: string;
	}
	| {
		type: "tool_ui";
		event: ToolUIEvent;
	};

export interface RunAgentStreamResult {
	lastState: AgentState;
	aborted: boolean;
	completed: boolean;
	error?: unknown;
}

/* ── ToolMessageUi: replaces raw ToolMessage in the UI layer ─────────── */

export interface ToolMessageUi {
	type: "tool_message_ui";
	toolCallId: string;
	toolName: string;
	status: "running" | "done" | "error";
	summary?: string;
	events: ToolUIEvent[];
	startedAt: number;
	finishedAt?: number;
}

/**
 * A single element in `messagesUi`.
 *   - HumanMessage / AIMessage are kept as LangChain objects (serialised dict).
 *   - ToolMessage is *never* stored; ToolMessageUi takes its place.
 */
export type UiMessage = Record<string, any> | ToolMessageUi;

export function isToolMessageUi(m: UiMessage): m is ToolMessageUi {
	return (m as any).type === "tool_message_ui";
}

/* ── Compaction metadata ────────────────────────────────────────────── */

export interface CompactionState {
	summary: string;
	summarizedTurnCount: number;
	lastCompactedAt: number;
	lastSource: "auto" | "manual";
	lastRequirement?: string;
	version: 1;
}

/* ── Agent state ────────────────────────────────────────────────────── */

export type AgentState = Record<string, any> & {
	messages?: any[];
	messagesUi?: UiMessage[];
	compaction?: CompactionState;
	/** @deprecated kept for lazy migration only */
	toolUIEvents?: ToolUIEvent[];
};

export type SessionKind = "chat" | "scheduled_task";
export type SessionGroup = "chat_history" | "scheduled_tasks";
export type ScheduledTaskScheduleType = "once" | "recurring";
export type ScheduledTaskRunStatus = "idle" | "running" | "success" | "error";

export interface ScheduledTaskMeta {
	id: string;
	title: string;
	prompt: string;
	scheduleType: ScheduledTaskScheduleType;
	cron?: string;
	triggerAt?: number;
	timezone: string;
	enabled: boolean;
	nextRunAt?: number;
	lastRunAt?: number;
	lastRunStatus: ScheduledTaskRunStatus;
	lastRunError?: string;
	runCount: number;
	createdAt: number;
	updatedAt: number;
}

export interface SessionIndexEntry {
	id: string;
	title: string;
	created: number;
	updated: number;
	kind: SessionKind;
	group: SessionGroup;
	task?: ScheduledTaskMeta;
}

/** 单个会话的持久化格式 */
export interface SessionData {
	id: string;
	title: string;
	created: number;
	updated: number;
	kind: SessionKind;
	group: SessionGroup;
	task?: ScheduledTaskMeta;
	state: AgentState;
	/** Per-conversation model override (model config ID) */
	modelId?: string;
}

/** 会话列表索引（轻量，不含 messages） */
export interface SessionIndex {
	activeId: string;
	sessions: SessionIndexEntry[];
}

export const BUILTIN_SYSTEM_PROMPT = `你是思源笔记的 AI 助手。你的目标是帮助用户管理知识库、搜索信息并基于笔记内容回答问题。

## 当前时间
{{CURRENT_DATETIME}}

## 可用工具

### 查询工具
- list_notebooks: 列出所有笔记本，获取笔记本 ID (box ID)。
- list_documents: 以树形结构列出指定笔记本中的文档。
- recent_documents: 列出最近修改的文档。
- get_document: 读取文档完整 Markdown 内容。
- get_document_blocks: 获取文档的子块及 block ID，用于编辑。
- get_document_outline: 获取文档标题大纲 (目录结构)，快速了解文档结构。
- read_block: 读取单个块的 kramdown 内容，适合精确读取搜索结果中的块。
- search_fulltext: 全文搜索，跨所有笔记本检索关键词。
- search_documents: 按标题关键词搜索文档。
- explore_notes: 让探索子智能体自行搜索、筛选、归纳多篇笔记，适合跨文档问题。

### 编辑工具
- append_block: 向指定文档追加 Markdown 内容。
- edit_blocks: 编辑块内容。先 get_document_blocks 获取 ID，再修改。只改需要变更的块。
- create_document: 创建新文档，指定笔记本、路径和 Markdown 内容。
- move_document: 移动文档到另一个笔记本或父文档下。
- rename_document: 重命名文档标题。

### 任务工具
- search_todos: 搜索笔记中的任务列表项 (checkbox)，按完成状态/关键词过滤。
- toggle_todo: 切换任务项的完成状态（勾选/取消勾选）。
- get_todo_stats: 获取任务完成统计（总数/已完成/待办/完成率）。

### 定时任务
- create_scheduled_task: 创建一次性或定期执行的定时任务。
- list_scheduled_tasks: 列出所有定时任务及其状态。
- update_scheduled_task: 修改已有定时任务。
- delete_scheduled_task: 删除定时任务。

## 工作流程
1. 搜索信息: 优先 search_fulltext 搜索关键词。
2. 开放式问题: 跨多篇文档时，优先 explore_notes。
3. 浏览结构: 先 list_notebooks，再 list_documents。
4. 最近内容: recent_documents 查看最近活跃内容。
5. 读取文档: get_document 读取完整内容。
6. 写入内容: append_block 追加到目标文档。
7. 编辑内容: 先 get_document_blocks 获取块 ID，然后 edit_blocks。
8. 任务管理: search_todos 查询待办，toggle_todo 切换完成状态。
9. 定时任务: 用户表达定时需求时，使用定时任务工具。

## 注意事项
- 工具调用失败时，根据错误信息调整参数后重试。
- 使用工具获取真实信息，不要编造笔记内容。
- 回答简洁明了，使用与用户相同的语言。
- 已有信息足够回答时，不做不必要的工具调用。`;

/** Build the final system prompt with local date filled in. */
export function buildSystemPrompt(): string {
	const now = new Date();
	const currentDate = [
		now.getFullYear(),
		String(now.getMonth() + 1).padStart(2, "0"),
		String(now.getDate()).padStart(2, "0"),
	].join("-");
	return BUILTIN_SYSTEM_PROMPT.replace("{{CURRENT_DATETIME}}", currentDate);
}

export const INIT_PROMPT = `请对我的思源笔记库做一次全面的初始化探索，并将结果写入用户指南文档。

## 任务步骤

**第一步：探索笔记库结构**
1. 调用 \`list_notebooks\` 列出所有笔记本，记录每个笔记本的 ID 和名称
2. 对每个笔记本，调用 \`list_documents\` 获取根目录文档树，了解顶层结构；如有必要再提高 \`depth\` 展开一层
3. 识别重要的顶层目录（如"日记"、"项目"、"知识库"、"读书笔记"等）

**第二步：深入了解内容**
1. 调用 \`recent_documents\` 获取最近更新的文档（取前 10-20 篇），再用 \`get_document\` 读取内容
2. 用 \`search_fulltext\` 搜索几个通用词（如"项目"、"计划"、"习惯"、"目标"）了解用户的关注点
3. 观察用户的笔记风格：标题命名规律、常用模板、记录频率

**第三步：识别关键信息**
- 最活跃的笔记本和文档
- 用户最关心的主题领域
- 常用的文档 ID（尤其是经常被引用或更新的文档）
- 用户的语言偏好和写作风格

**第四步：将结果写入用户指南文档**
整理以上发现，用 \`edit_blocks\` 或 \`append_block\` 更新用户指南文档，格式如下：

\`\`\`markdown
# 笔记库概览

## 笔记本列表
| 笔记本名称 | ID | 用途描述 |
|-----------|-----|---------|
| ...       | ... | ...     |

## 重要文档
列出关键文档的标题和 ID，方便快速访问

## 笔记结构规律
- 目录组织方式
- 命名习惯
- 常用标签

## 用户偏好
- 语言：中文/英文/混合
- 笔记风格：...
- 活跃时间段：...

## 常用路径参考
列出常见操作的笔记本 ID 和文档路径，避免重复查询
\`\`\`

请开始探索。`;

export const SLASH_COMMANDS: { name: string; description: string }[] = [
	{ name: "/init", description: "探索笔记库，生成用户指南" },
	{ name: "/compact", description: "手动压缩对话上下文" },
	{ name: "/help", description: "显示可用命令和工具列表" },
	{ name: "/clear", description: "清空当前对话" },
];

export const DEFAULT_CONFIG: AgentConfig = {
	apiBaseURL: "https://api.openai.com/v1",
	apiKey: "",
	model: "gpt-4o",
	customInstructions: "",
	panelPosition: "right",
	guideDoc: null,
	langSmithEnabled: false,
	langSmithApiKey: "",
	langSmithEndpoint: "https://api.smith.langchain.com",
	langSmithProject: "SiYuan-Agent",
	models: [],
	defaultModelId: "",
	subAgentModelId: "",
};

/* ── Model provider presets ─────────────────────────────────────────── */

export interface ModelProviderPreset {
	provider: string;
	label: string;
	apiBaseURL: string;
	models: string[];
}

export const MODEL_PROVIDER_PRESETS: ModelProviderPreset[] = [
  {
    provider: "ark",
    label: "火山引擎",
    apiBaseURL: "https://ark.cn-beijing.volces.com/api/v3",
    models: [
      "doubao-seed-2-0-pro",
      "doubao-seed-2-0-mini",
      "doubao-seed-2-0-lite",
    ],
  },
  {
    provider: "bailian",
    label: "阿里云百炼",
    apiBaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen3.6-plus", "qwen3.5-plus"],
  },
  {
    provider: "custom",
    label: "自定义",
    apiBaseURL: "",
    models: [],
  },
];

/** Resolve a ModelConfig from the registry by ID, falling back to legacy fields. */
export function resolveModelConfig(config: AgentConfig, modelId?: string): ModelConfig {
	const id = modelId || config.defaultModelId || "";
	if (id && Array.isArray(config.models)) {
		const found = config.models.find((m) => m.id === id);
		if (found) return found;
	}
	// Legacy fallback: construct from top-level fields
	return {
		id: "__legacy__",
		name: config.model || "gpt-4o",
		provider: "custom",
		model: config.model || "gpt-4o",
		apiBaseURL: config.apiBaseURL || "https://api.openai.com/v1",
		apiKey: config.apiKey || "",
	};
}

/** Resolve the sub-agent model, falling back to main model. */
export function resolveSubAgentModelConfig(config: AgentConfig): ModelConfig {
	if (config.subAgentModelId) {
		const resolved = resolveModelConfig(config, config.subAgentModelId);
		if (resolved.id !== "__legacy__") return resolved;
	}
	return resolveModelConfig(config);
}

/** Generate a unique model config ID. */
export function genModelId(): string {
	return "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
