export function stripSiyuanBlockAttrs(value: string): string {
	const lines = value.split(/\r?\n/);
	const output: string[] = [];
	let inAttrBlock = false;
	let attrBlockPrefix = "";
	for (const line of lines) {
		if (inAttrBlock) {
			const endIndex = line.indexOf("}");
			if (endIndex >= 0) {
				const rest = line.slice(endIndex + 1).trim();
				if (rest) output.push(`${attrBlockPrefix}${rest}`.replace(/^(\s*[-*+]\s*)\[\]/, "$1[ ]"));
				inAttrBlock = false;
				attrBlockPrefix = "";
			}
			continue;
		}
		const singleLine = line.replace(/\s*\{:\s+[^}]*\}\s*/g, " ").trimEnd();
		if (!singleLine.trim()) {
			output.push(singleLine);
			continue;
		}
		const startMatch = singleLine.match(/^(\s*(?:[-*+]\s*)?)\{:\s*$/);
		if (startMatch) {
			attrBlockPrefix = startMatch[1] || "";
			inAttrBlock = true;
			continue;
		}
		output.push(singleLine);
	}
	return output.join("\n").trim();
}

export function normalizeSiyuanPreviewText(value: string): string {
	const text = stripSiyuanBlockAttrs(value);
	const lines = text.split("\n");
	const output: string[] = [];
	const isListItem = (line: string) => /^\s*[-*+]\s+(?:\[[ xX]\]\s*)?\S/.test(line);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim() && output.length > 0 && isListItem(output[output.length - 1] || "") && isListItem(lines[i + 1] || "")) {
			continue;
		}
		output.push(line);
	}
	return output.join("\n").trim();
}
