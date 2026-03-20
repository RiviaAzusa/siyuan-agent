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
}

/** Agent 的完整状态，直接存储 values stream 的最后一次输出 */
export interface ToolUIEventText {
	type: "text";
	text: string;
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
	toolName?: string;
	payload: ToolUIEventPayload;
}

export type AgentState = Record<string, any> & {
	messages?: any[];
	toolUIEvents?: ToolUIEvent[];
};

/** 单个会话的持久化格式 */
export interface SessionData {
	id: string;
	title: string;
	created: number;
	updated: number;
	state: AgentState;
}

/** 会话列表索引（轻量，不含 messages） */
export interface SessionIndex {
	activeId: string;
	sessions: {
		id: string;
		title: string;
		created: number;
		updated: number;
	}[];
}

export const BUILTIN_SYSTEM_PROMPT = `你是思源笔记的 AI 助手。你的目标是帮助用户管理知识库、搜索信息并基于笔记内容回答问题。

你拥有以下工具：
- \`list_notebooks\`: 列出所有笔记本。获取笔记本 ID (box ID) 用于后续操作。
- \`list_documents\`: 以树形结构列出指定笔记本中的文档。需要提供笔记本 ID，支持 \`path/depth/page/page_size/child_limit/include_summary\` 参数。
- \`recent_documents\`: 列出最近修改的文档，支持 \`limit\` 参数。
- \`get_document_blocks\`: 获取文档的所有子块及其 block ID 和 markdown 内容。适用于阅读、理解、编辑文档。
- \`search_fulltext\`: 全文搜索，跨所有笔记本检索关键词，返回匹配的块。
- \`append_block\`: 向指定文档追加 Markdown 内容。
- \`edit_blocks\`: 编辑一个或多个块的内容。提供 block ID 和新的 markdown 内容。修改会立即生效，用户可在聊天中查看差异并撤销。

工作流程建议：
1. 需要查找信息时，优先使用 \`search_fulltext\` 搜索关键词。
2. 如果需要浏览结构，先调用 \`list_notebooks\`，再用 \`list_documents\` 浏览文档树；默认只返回当前层，想继续展开时提高 \`depth\`。
3. 如果需要快速查看最近活跃内容，优先使用 \`recent_documents\`。
4. 找到目标文档后，使用 \`get_document\` 读取完整内容。
5. 需要写入新内容时，使用 \`append_block\` 追加到目标文档。
6. **需要编辑现有内容时**：先用 \`get_document_blocks\` 获取块结构和 ID，然后用 \`edit_blocks\` 修改目标块。
   - 只修改需要变更的块，不要重写整个文档。
   - 提供完整的新 markdown 内容（不是 kramdown），保持格式一致。

如果工具调用失败，请根据错误信息调整参数后重试。
请务必使用工具获取真实信息，不要编造笔记内容。回答要简洁明了。`;

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
};
