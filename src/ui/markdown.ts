/*
 * Lightweight Markdown → HTML renderer.
 * Handles: code blocks, inline code, bold, italic, links, headings, lists, blockquotes, hr, tables.
 * No external dependencies. Good enough for chat messages.
 */

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function renderMarkdown(src: string): string {
	/* Extract fenced code blocks first to protect them from inline processing */
	const codeBlocks: string[] = [];
	let text = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
		const idx = codeBlocks.length;
		const escaped = escapeHtml(code.replace(/\n$/, ""));
		const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
		codeBlocks.push(`<pre><code${cls}>${escaped}</code></pre>`);
		return `\x00CODEBLOCK${idx}\x00`;
	});

	/* Process line by line */
	const lines = text.split("\n");
	const out: string[] = [];
	let inList = false;
	let listType = "";
	let inBlockquote = false;

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];

		/* Code block placeholder — pass through */
		if (/\x00CODEBLOCK\d+\x00/.test(line)) {
			closeList();
			closeBlockquote();
			out.push(line);
			continue;
		}

		/* Horizontal rule */
		if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			closeList();
			closeBlockquote();
			out.push("<hr>");
			continue;
		}

		/* Headings */
		const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
		if (headingMatch) {
			closeList();
			closeBlockquote();
			const level = headingMatch[1].length;
			out.push(`<h${level}>${inlineFormat(headingMatch[2])}</h${level}>`);
			continue;
		}

		/* GFM table */
		if (i + 1 < lines.length && isTableRow(line) && isTableSeparator(lines[i + 1])) {
			closeList();
			closeBlockquote();

			const headers = splitTableRow(line);
			const alignments = parseTableAlignments(lines[i + 1]);
			const rows: string[][] = [];
			let j = i + 2;

			while (j < lines.length && isTableRow(lines[j]) && !isTableSeparator(lines[j])) {
				rows.push(splitTableRow(lines[j]));
				j += 1;
			}

			out.push(renderTable(headers, alignments, rows));
			i = j - 1;
			continue;
		}

		/* Blockquote */
		if (line.startsWith("> ")) {
			closeList();
			if (!inBlockquote) {
				out.push("<blockquote>");
				inBlockquote = true;
			}
			out.push(`<p>${inlineFormat(line.slice(2))}</p>`);
			continue;
		} else if (inBlockquote) {
			closeBlockquote();
		}

		/* Unordered list */
		const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
		if (ulMatch) {
			if (!inList || listType !== "ul") {
				closeList();
				out.push("<ul>");
				inList = true;
				listType = "ul";
			}
			out.push(`<li>${inlineFormat(ulMatch[2])}</li>`);
			continue;
		}

		/* Ordered list */
		const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
		if (olMatch) {
			if (!inList || listType !== "ol") {
				closeList();
				out.push("<ol>");
				inList = true;
				listType = "ol";
			}
			out.push(`<li>${inlineFormat(olMatch[2])}</li>`);
			continue;
		}

		closeList();

		/* Empty line */
		if (line.trim() === "") {
			continue;
		}

		/* Regular paragraph */
		out.push(`<p>${inlineFormat(line)}</p>`);
	}

	closeList();
	closeBlockquote();

	let result = out.join("\n");

	/* Restore code blocks */
	result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => {
		return codeBlocks[parseInt(idx, 10)];
	});

	return result;

	function closeList() {
		if (inList) {
			out.push(listType === "ul" ? "</ul>" : "</ol>");
			inList = false;
			listType = "";
		}
	}

	function closeBlockquote() {
		if (inBlockquote) {
			out.push("</blockquote>");
			inBlockquote = false;
		}
	}
}

function inlineFormat(text: string): string {
	/* Inline code (must be first to protect contents) */
	const codes: string[] = [];
	text = text.replace(/`([^`]+)`/g, (_, code) => {
		const idx = codes.length;
		codes.push(`<code>${escapeHtml(code)}</code>`);
		return `\x01IC${idx}\x01`;
	});

	/* Escape HTML in the rest */
	text = escapeHtml(text);

	/* Bold + italic */
	text = text.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
	/* Bold */
	text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
	/* Italic */
	text = text.replace(/\*(.+?)\*/g, "<em>$1</em>");
	/* Strikethrough */
	text = text.replace(/~~(.+?)~~/g, "<del>$1</del>");
	/* Links */
	text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

	/* Restore inline code */
	text = text.replace(/\x01IC(\d+)\x01/g, (_, idx) => codes[parseInt(idx, 10)]);

	return text;
}

function isTableRow(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.includes("|") && !/^\|?\s*[-:]+\s*(\|\s*[-:]+\s*)+\|?$/.test(trimmed);
}

function isTableSeparator(line: string): boolean {
	const cells = splitTableRow(line);
	return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell.trim()));
}

function splitTableRow(line: string): string[] {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	const cells: string[] = [];
	let current = "";
	let escaped = false;

	for (const char of trimmed) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if ("\\" === char) {
			escaped = true;
			current += char;
			continue;
		}

		if ("|" === char) {
			cells.push(current.trim());
			current = "";
			continue;
		}

		current += char;
	}

	cells.push(current.trim());
	return cells;
}

function parseTableAlignments(line: string): Array<"left" | "center" | "right" | null> {
	return splitTableRow(line).map((cell) => {
		const trimmed = cell.trim();
		const startsWithColon = trimmed.startsWith(":");
		const endsWithColon = trimmed.endsWith(":");
		if (startsWithColon && endsWithColon) return "center";
		if (endsWithColon) return "right";
		if (startsWithColon) return "left";
		return null;
	});
}

function renderTable(
	headers: string[],
	alignments: Array<"left" | "center" | "right" | null>,
	rows: string[][],
): string {
	const renderCell = (tag: "th" | "td", value: string, index: number): string => {
		const alignment = alignments[index];
		const style = alignment ? ` style="text-align:${alignment}"` : "";
		return `<${tag}${style}>${inlineFormat(value)}</${tag}>`;
	};

	const thead = `<thead><tr>${headers.map((cell, index) => renderCell("th", cell, index)).join("")}</tr></thead>`;
	const tbody = rows.length
		? `<tbody>${rows.map((row) => `<tr>${headers.map((_, index) => renderCell("td", row[index] ?? "", index)).join("")}</tr>`).join("")}</tbody>`
		: "";

	return `<div class="chat-md-table-wrap"><table>${thead}${tbody}</table></div>`;
}
