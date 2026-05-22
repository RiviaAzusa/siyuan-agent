import { getWriter, type SiyuanToolOptions } from "../tool-types";

/** Call a SiYuan kernel API and return `resp.data` on success.
 *
 *  Uses native `fetch` instead of the SDK's `fetchPost` to avoid the
 *  hanging-Promise bug: `fetchPost` swallows the callback when
 *  `processMessage` returns false (response.code < 0), leaving the
 *  Promise unresolved forever.  */
export async function siyuanFetch(url: string, data: any): Promise<any> {
	const resp = await fetch(url, {
		method: "POST",
		body: JSON.stringify(data),
	});
	const json = await resp.json();
	if (json.code !== 0) {
		throw new Error(json.msg || `API error code ${json.code}`);
	}
	return json.data;
}

export function emitToolEvent(options: SiyuanToolOptions, payload: Record<string, unknown>): void {
	getWriter(options)?.(JSON.stringify({
		...payload,
		toolCallId: options.toolCallId,
	}));
}

export function emitActivity(
	options: SiyuanToolOptions,
	payload: {
		category: "lookup" | "change" | "other";
		action: "list" | "read" | "search" | "create" | "append" | "edit" | "move" | "rename" | "delete" | "other";
		id?: string;
		path?: string;
		label?: string;
		meta?: string;
		open?: boolean;
	},
): void {
	emitToolEvent(options, {
		__tool_type: "activity",
		...payload,
	});
}

/** Sanitize a string for safe inclusion in SQL queries. */
export function sqlEscape(val: string): string {
	return val.replace(/'/g, "''");
}
