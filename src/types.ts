export interface AgentConfig {
	apiBaseURL: string;
	apiKey: string;
	model: string;
	systemPrompt: string;
	langSmithEnabled?: boolean;
	langSmithApiKey?: string;
	langSmithEndpoint?: string;
	langSmithProject?: string;
}

/** Agent 的完整状态，直接存储 values stream 的最后一次输出 */
export type AgentState = Record<string, any>;

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

export const DEFAULT_SYSTEM_PROMPT = `你是思源笔记的 AI 助手。你的目标是帮助用户管理知识库、搜索信息并基于笔记内容回答问题。

你拥有以下工具：
- \`list_notebooks\`: 列出所有笔记本。获取笔记本 ID (box ID) 用于后续操作。
- \`list_documents\`: 获取指定笔记本中的文档列表。需要提供笔记本 ID，可用 path 过滤路径。
- \`get_document_blocks\`: 获取文档的所有子块及其 block ID 和 markdown 内容。适用于阅读、理解、编辑文档。
- \`search_fulltext\`: 全文搜索，跨所有笔记本检索关键词，返回匹配的块。
- \`append_block\`: 向指定文档追加 Markdown 内容。
- \`edit_blocks\`: 编辑一个或多个块的内容。提供 block ID 和新的 markdown 内容。修改会立即生效，用户可在聊天中查看差异并撤销。

工作流程建议：
1. 需要查找信息时，优先使用 \`search_fulltext\` 搜索关键词。
2. 如果需要浏览结构，先调用 \`list_notebooks\`，再用 \`list_documents\` 查找文档。
3. 找到目标文档后，使用 \`get_document\` 读取完整内容。
4. 需要写入新内容时，使用 \`append_block\` 追加到目标文档。
5. **需要编辑现有内容时**：先用 \`get_document_blocks\` 获取块结构和 ID，然后用 \`edit_blocks\` 修改目标块。
   - 只修改需要变更的块，不要重写整个文档。
   - 提供完整的新 markdown 内容（不是 kramdown），保持格式一致。

如果工具调用失败，请根据错误信息调整参数后重试。
请务必使用工具获取真实信息，不要编造笔记内容。回答要简洁明了。`;

export const DEFAULT_CONFIG: AgentConfig = {
	apiBaseURL: "https://api.openai.com/v1",
	apiKey: "",
	model: "gpt-4o",
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	langSmithEnabled: false,
	langSmithApiKey: "",
	langSmithEndpoint: "https://api.smith.langchain.com",
	langSmithProject: "SiYuan-Agent",
};
