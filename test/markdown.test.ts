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

	it("renders headings", () => {
		expect(renderMarkdown("# Hello")).toContain("<h1>Hello</h1>");
		expect(renderMarkdown("## Sub")).toContain("<h2>Sub</h2>");
		expect(renderMarkdown("### Third")).toContain("<h3>Third</h3>");
	});

	it("renders bold and italic", () => {
		const result = renderMarkdown("**bold** and *italic*");
		expect(result).toContain("<strong>bold</strong>");
		expect(result).toContain("<em>italic</em>");
	});

	it("renders inline code", () => {
		const result = renderMarkdown("Use `console.log()` here");
		expect(result).toContain("<code>console.log()</code>");
	});

	it("renders fenced code blocks", () => {
		const result = renderMarkdown("```js\nconst x = 1;\n```");
		expect(result).toContain('<code class="language-js">');
		expect(result).toContain("const x = 1;");
	});

	it("renders links", () => {
		const result = renderMarkdown("[Click](https://example.com)");
		expect(result).toContain('<a href="https://example.com" target="_blank">Click</a>');
	});

	it("renders unordered lists", () => {
		const result = renderMarkdown("- item1\n- item2");
		expect(result).toContain("<ul>");
		expect(result).toContain("<li>item1</li>");
		expect(result).toContain("</ul>");
	});

	it("renders ordered lists", () => {
		const result = renderMarkdown("1. first\n2. second");
		expect(result).toContain("<ol>");
		expect(result).toContain("<li>first</li>");
	});

	it("renders blockquotes", () => {
		const result = renderMarkdown("> This is a quote");
		expect(result).toContain("<blockquote>");
		expect(result).toContain("This is a quote");
	});

	it("renders horizontal rules", () => {
		expect(renderMarkdown("---")).toContain("<hr>");
		expect(renderMarkdown("***")).toContain("<hr>");
	});

	it("renders strikethrough", () => {
		expect(renderMarkdown("~~deleted~~")).toContain("<del>deleted</del>");
	});

	it("escapes HTML in text", () => {
		const result = renderMarkdown("<script>alert('xss')</script>");
		expect(result).not.toContain("<script>");
		expect(result).toContain("&lt;script&gt;");
	});

	it("protects code blocks from inline formatting", () => {
		const result = renderMarkdown("```\n**not bold**\n```");
		expect(result).not.toContain("<strong>");
	});

	it("handles empty input", () => {
		expect(renderMarkdown("")).toBe("");
	});

	it("handles mixed content", () => {
		const md = "# Title\n\nSome **bold** text.\n\n- item 1\n- item 2\n\n```js\ncode()\n```";
		const result = renderMarkdown(md);
		expect(result).toContain("<h1>");
		expect(result).toContain("<strong>");
		expect(result).toContain("<ul>");
		expect(result).toContain("<pre>");
	});
});
