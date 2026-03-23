import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/ui/markdown";

describe("renderMarkdown", () => {
	it("renders GFM tables with alignment and inline formatting", () => {
		const html = renderMarkdown([
			"| Name | Score | Note |",
			"| :--- | ---: | :--: |",
			"| Alice | 95 | **great** |",
			"| Bob | 88 | `ok` |",
		].join("\n"));

		expect(html).toContain('<div class="chat-md-table-wrap"><table>');
		expect(html).toContain("<thead><tr><th style=\"text-align:left\">Name</th><th style=\"text-align:right\">Score</th><th style=\"text-align:center\">Note</th></tr></thead>");
		expect(html).toContain("<tbody><tr><td style=\"text-align:left\">Alice</td><td style=\"text-align:right\">95</td><td style=\"text-align:center\"><strong>great</strong></td></tr><tr><td style=\"text-align:left\">Bob</td><td style=\"text-align:right\">88</td><td style=\"text-align:center\"><code>ok</code></td></tr></tbody>");
	});
});
