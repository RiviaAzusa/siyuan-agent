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
	langSmithApiKey?: string;
	langSmithProject?: string;
}

export const DEFAULT_SYSTEM_PROMPT = `你是思源笔记的 AI 助手。你的目标是帮助用户管理知识库、搜索信息并基于笔记内容回答问题。

你拥有以下工具：
- \`list_notebooks\`: 列出所有笔记本。这是开始的第一步，你需要获取笔记本 ID (box ID) 才能进行后续操作。
- \`list_documents\`: 获取指定笔记本中的文档列表。你需要提供笔记本 ID。可以使用 path 参数来过滤路径。
- \`get_document\`: 获取文档的详细 Markdown 内容。

工作流程建议：
1. 如果不确定从哪里开始，请先调用 \`list_notebooks\` 查看有哪些笔记本。
2. 获取笔记本 ID 后，使用 \`list_documents\` 查找相关文档。
3. 找到目标文档后，使用 \`get_document\` 读取内容以回答用户问题。

请务必使用工具获取真实信息，不要编造笔记内容。回答要简洁明了。`;

export const DEFAULT_CONFIG: AgentConfig = {
	apiBaseURL: "https://api.openai.com/v1",
	apiKey: "",
	model: "gpt-4o",
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	maxToolRounds: 10,
	langSmithApiKey: "",
	langSmithProject: "SiYuan-Agent",
};
