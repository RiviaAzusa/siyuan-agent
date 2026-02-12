export interface ChatMessage {
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	timestamp: number;
	context?: string;
	tool_calls?: {
		id: string;
		name: string;
		args: any;
	}[];
	tool_call_id?: string;
	name?: string;
}

export interface ChatSession {
	id: string;
	title: string;
	created: number;
	updated: number;
	messages: ChatMessage[];
}

export interface ChatStore {
	activeId: string;
	sessions: ChatSession[];
}

export interface AgentConfig {
	apiBaseURL: string;
	apiKey: string;
	model: string;
	systemPrompt: string;
	maxToolRounds: number;
	langSmithEnabled?: boolean;
	langSmithApiKey?: string;
	langSmithEndpoint?: string;
	langSmithProject?: string;
}

export const DEFAULT_SYSTEM_PROMPT = `你是思源笔记的 AI 助手。你的目标是帮助用户管理知识库、搜索信息并基于笔记内容回答问题。

你拥有以下工具：
- \`list_notebooks\`: 列出所有笔记本。获取笔记本 ID (box ID) 用于后续操作。
- \`list_documents\`: 获取指定笔记本中的文档列表。需要提供笔记本 ID，可用 path 过滤路径。
- \`get_document\`: 获取文档的详细 Markdown 内容。
- \`search_fulltext\`: 全文搜索，跨所有笔记本检索关键词，返回匹配的块。
- \`append_block\`: 向指定文档追加 Markdown 内容。

工作流程建议：
1. 需要查找信息时，优先使用 \`search_fulltext\` 搜索关键词。
2. 如果需要浏览结构，先调用 \`list_notebooks\`，再用 \`list_documents\` 查找文档。
3. 找到目标文档后，使用 \`get_document\` 读取完整内容。
4. 需要写入内容时，使用 \`append_block\` 追加到目标文档。

如果工具调用失败，请根据错误信息调整参数后重试。
请务必使用工具获取真实信息，不要编造笔记内容。回答要简洁明了。`;

export const DEFAULT_CONFIG: AgentConfig = {
	apiBaseURL: "https://api.openai.com/v1",
	apiKey: "",
	model: "gpt-4o",
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	maxToolRounds: 10,
	langSmithEnabled: false,
	langSmithApiKey: "",
	langSmithEndpoint: "https://api.smith.langchain.com",
	langSmithProject: "SiYuan-Agent",
};
