import { HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AgentState, CompactionState } from "../types";

const COMPACT_SUMMARY_PROMPT = `You are a conversation summariser.  Below is the existing summary (if any) followed by new conversation turns.  Produce a concise, information-dense summary that preserves all facts, decisions, and open questions.  Write in the same language the user predominantly uses (Chinese / English / mixed).

## Existing summary
{existing_summary}

## New turns
{new_turns}

Produce only the updated summary, no preamble.`;

function msgType(m: any): string {
	if (typeof m?._getType === "function") return m._getType();
	if (m?.lc === 1 && Array.isArray(m.id)) {
		const cls = m.id[m.id.length - 1] as string;
		if (cls === "HumanMessage") return "human";
		if (cls === "AIMessage" || cls === "AIMessageChunk") return "ai";
		if (cls === "SystemMessage") return "system";
		if (cls === "ToolMessage") return "tool";
	}
	return m?.type ?? m?.role ?? "";
}

function getContent(m: any): string {
	const c = m?.kwargs?.content ?? m?.content;
	return typeof c === "string" ? c : "";
}

/** Count total characters across all messages. */
function charCount(messages: any[]): number {
	let total = 0;
	for (const m of messages) {
		total += getContent(m).length;
		const tc = m?.kwargs?.tool_calls ?? m?.tool_calls;
		if (Array.isArray(tc)) {
			total += JSON.stringify(tc).length;
		}
	}
	return total;
}

/**
 * Split messages into turns.  A turn starts at each HumanMessage and
 * includes all subsequent AI / Tool messages until the next HumanMessage.
 */
function splitTurns(messages: any[]): any[][] {
	const turns: any[][] = [];
	let current: any[] = [];
	for (const m of messages) {
		const t = msgType(m);
		if ((t === "human" || t === "user") && current.length > 0) {
			turns.push(current);
			current = [];
		}
		current.push(m);
	}
	if (current.length > 0) turns.push(current);
	return turns;
}

function turnsToText(turns: any[][]): string {
	const lines: string[] = [];
	for (const turn of turns) {
		for (const m of turn) {
			const t = msgType(m);
			const c = getContent(m);
			if (t === "human" || t === "user") {
				lines.push(`User: ${c}`);
			} else if (t === "ai") {
				const tc = m?.kwargs?.tool_calls ?? m?.tool_calls;
				if (Array.isArray(tc) && tc.length > 0) {
					const names = tc.map((t: any) => t.name || "?").join(", ");
					lines.push(`Assistant: ${c || "(tool calls)"} [tools: ${names}]`);
				} else if (c) {
					lines.push(`Assistant: ${c}`);
				}
			}
			/* skip tool messages in summary input */
		}
	}
	return lines.join("\n");
}

export interface CompactOptions {
	/** The LLM used for summarisation. */
	model: BaseChatModel;
	/** How many recent turns to keep verbatim. */
	keepRecentTurns?: number;
	/** Extra requirement text from `/compact [text]`. */
	requirement?: string;
	/** Source: auto (middleware) or manual (/compact). */
	source?: "auto" | "manual";
}

/**
 * Run a manual compaction on `state.messages`, updating `state.compaction`.
 *
 * Returns the summary text, or null if there was nothing to compact.
 */
export async function compactMessages(
	state: AgentState,
	options: CompactOptions,
): Promise<string | null> {
	const messages = state.messages || [];
	const turns = splitTurns(messages);

	const keepRecent = options.keepRecentTurns ?? 4;
	if (turns.length <= keepRecent) return null;

	const oldTurns = turns.slice(0, turns.length - keepRecent);
	const recentTurns = turns.slice(turns.length - keepRecent);

	const existingSummary = state.compaction?.summary || "(none)";
	const newTurnsText = turnsToText(oldTurns);

	let prompt = COMPACT_SUMMARY_PROMPT
		.replace("{existing_summary}", existingSummary)
		.replace("{new_turns}", newTurnsText);

	if (options.requirement) {
		prompt += `\n\nAdditional user instruction for this summary: ${options.requirement}`;
	}

	const result = await options.model.invoke([new HumanMessage(prompt)]);
	const summary = typeof result.content === "string"
		? result.content
		: JSON.stringify(result.content);

	/* Rebuild state.messages: keep only recent turns */
	state.messages = recentTurns.flat();

	const comp: CompactionState = {
		summary,
		summarizedTurnCount: (state.compaction?.summarizedTurnCount ?? 0) + oldTurns.length,
		lastCompactedAt: Date.now(),
		lastSource: options.source || "manual",
		lastRequirement: options.requirement,
		version: 1,
	};
	state.compaction = comp;

	return summary;
}

/**
 * Check whether a state's messages exceed the compaction thresholds.
 */
export function shouldCompact(
	state: AgentState,
	turnThreshold = 10,
	charThreshold = 12000,
): boolean {
	const messages = state.messages || [];
	if (messages.length === 0) return false;
	const turns = splitTurns(messages);
	return turns.length > turnThreshold || charCount(messages) > charThreshold;
}
