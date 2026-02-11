/**
 * test-tools.ts
 *
 * Standalone integration test for SiYuan tools.
 * Calls SiYuan HTTP API directly (no `siyuan` SDK dependency).
 *
 * Usage:
 *   npx tsx test/test-tools.ts
 *
 * Prerequisites:
 *   - SiYuan must be running locally on port 6806
 */

const SIYUAN_BASE = "http://127.0.0.1:6806";

// ───────────────────────── helpers ─────────────────────────

async function siyuanFetch(url: string, data: any): Promise<any> {
	const resp = await fetch(`${SIYUAN_BASE}${url}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
	});
	const json = await resp.json();
	if (json.code !== 0) {
		throw new Error(json.msg || `API error code ${json.code}`);
	}
	return json.data;
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

async function runTest(name: string, fn: () => Promise<void>) {
	try {
		await fn();
		console.log(`  ✅ ${name}`);
		passed++;
	} catch (err: any) {
		console.error(`  ❌ ${name}`);
		console.error(`     ${err.message}`);
		failed++;
	}
}

// ───────────────────── tool implementations (mirror tools.ts) ─────────────────────

async function listNotebooks() {
	const data = await siyuanFetch("/api/notebook/lsNotebooks", {});
	const notebooks = (data.notebooks || []).map((nb: any) => ({
		id: nb.id,
		name: nb.name,
		icon: nb.icon,
		closed: nb.closed,
	}));
	return JSON.stringify(notebooks, null, 2);
}

async function listDocuments(notebook: string, path?: string) {
	const stmt = path
		? `SELECT * FROM blocks WHERE type='d' AND box='${notebook}' AND hpath LIKE '${path}%' ORDER BY updated DESC LIMIT 50`
		: `SELECT * FROM blocks WHERE type='d' AND box='${notebook}' ORDER BY updated DESC LIMIT 50`;
	const data = await siyuanFetch("/api/query/sql", { stmt });
	const docs = (data || []).map((d: any) => ({
		id: d.id,
		title: d.content,
		hpath: d.hpath,
		updated: d.updated,
	}));
	return JSON.stringify(docs, null, 2);
}

async function getDocument(id: string) {
	const data = await siyuanFetch("/api/export/exportMdContent", { id });
	const hpath = data.hPath || "";
	const content = data.content || "";
	return `# ${hpath}\n\n${content}`;
}

// ───────────────────── tests ─────────────────────

async function main() {
	console.log("\n🔧 SiYuan Tools Integration Test\n");

	// ── 0. Connectivity check ──
	console.log("── Connectivity ──");
	await runTest("SiYuan is reachable", async () => {
		const resp = await fetch(`${SIYUAN_BASE}/api/system/version`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		const json = await resp.json();
		assert(json.code === 0, `unexpected code: ${json.code}`);
		console.log(`     SiYuan version: ${json.data}`);
	});

	// ── 1. list_notebooks ──
	console.log("\n── list_notebooks ──");
	let notebookId = "";

	await runTest("returns valid JSON array", async () => {
		const result = await listNotebooks();
		const parsed = JSON.parse(result);
		assert(Array.isArray(parsed), "result is not an array");
		assert(parsed.length > 0, "no notebooks found");
	});

	await runTest("each notebook has required fields", async () => {
		const result = await listNotebooks();
		const parsed = JSON.parse(result);
		for (const nb of parsed) {
			assert(typeof nb.id === "string" && nb.id.length > 0, `invalid id: ${nb.id}`);
			assert(typeof nb.name === "string", `invalid name: ${nb.name}`);
			assert("icon" in nb, "missing icon field");
			assert(typeof nb.closed === "boolean", `invalid closed: ${nb.closed}`);
		}
	});

	await runTest("can find 'Azusa's Notebook' (20250808230205-rbnjq3m)", async () => {
		const result = await listNotebooks();
		const parsed = JSON.parse(result);
		const target = parsed.find(
			(nb: any) => nb.id === "20250808230205-rbnjq3m"
		);
		assert(!!target, "notebook 20250808230205-rbnjq3m not found");
		notebookId = target.id;
		console.log(`     Found: ${target.name} (icon: ${target.icon})`);
	});

	// ── 2. list_documents ──
	console.log("\n── list_documents ──");
	let firstDocId = "";

	await runTest("lists documents in notebook", async () => {
		const result = await listDocuments(notebookId);
		const parsed = JSON.parse(result);
		assert(Array.isArray(parsed), "result is not an array");
		assert(parsed.length > 0, "no documents found in notebook");
		console.log(`     Found ${parsed.length} documents`);
	});

	await runTest("each document has required fields", async () => {
		const result = await listDocuments(notebookId);
		const parsed = JSON.parse(result);
		for (const doc of parsed) {
			assert(typeof doc.id === "string" && doc.id.length > 0, `invalid id: ${doc.id}`);
			assert(typeof doc.title === "string", `invalid title: ${doc.title}`);
			assert(typeof doc.hpath === "string", `invalid hpath: ${doc.hpath}`);
			assert(typeof doc.updated === "string", `invalid updated: ${doc.updated}`);
		}
		firstDocId = parsed[0].id;
		console.log(`     First doc: "${parsed[0].title}" (${parsed[0].id})`);
	});

	await runTest("path filter works (no crash even if empty result)", async () => {
		// Use a path that likely exists or not — just make sure API doesn't error
		const result = await listDocuments(notebookId, "/");
		const parsed = JSON.parse(result);
		assert(Array.isArray(parsed), "result is not an array");
		console.log(`     With path '/' filter: ${parsed.length} documents`);
	});

	await runTest("invalid notebook ID returns empty array (not crash)", async () => {
		const result = await listDocuments("nonexistent-notebook-id");
		const parsed = JSON.parse(result);
		assert(Array.isArray(parsed), "result is not an array");
		assert(parsed.length === 0, `expected 0 docs, got ${parsed.length}`);
	});

	// ── 3. get_document ──
	console.log("\n── get_document ──");

	if (firstDocId) {
		await runTest("retrieves document content", async () => {
			const result = await getDocument(firstDocId);
			assert(typeof result === "string", "result is not a string");
			assert(result.startsWith("# "), `result doesn't start with '# ': ${result.substring(0, 50)}`);
			console.log(`     Content preview: ${result.substring(0, 100).replace(/\n/g, "\\n")}...`);
		});

		await runTest("document contains hpath and content", async () => {
			const result = await getDocument(firstDocId);
			const lines = result.split("\n");
			// First line should be "# /some/path"
			assert(lines[0].startsWith("# "), "first line should be hpath heading");
			// Should have some content after the heading
			assert(result.length > lines[0].length + 2, "document should have content beyond heading");
		});
	} else {
		console.log("  ⚠️  Skipping get_document tests (no document ID available)");
	}

	await runTest("invalid document ID returns error or empty content gracefully", async () => {
		try {
			const result = await getDocument("nonexistent-id");
			// If API doesn't error, check that we at least get a string back
			assert(typeof result === "string", "result should be a string");
		} catch (err: any) {
			// API error is also acceptable for invalid ID
			assert(err.message.length > 0, "error should have a message");
			console.log(`     Expected error: ${err.message}`);
		}
	});

	// ── 4. SQL query (underlying API for list_documents) ──
	console.log("\n── SQL query API ──");

	await runTest("raw SQL query works", async () => {
		const data = await siyuanFetch("/api/query/sql", {
			stmt: "SELECT COUNT(*) AS cnt FROM blocks WHERE type='d'",
		});
		assert(Array.isArray(data), "sql result should be an array");
		assert(data.length > 0, "sql result should have rows");
		console.log(`     Total documents in SiYuan: ${data[0].cnt}`);
	});

	// ── Summary ──
	console.log(`\n${"─".repeat(40)}`);
	console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
	if (failed > 0) {
		console.log("⚠️  Some tests failed!\n");
		process.exit(1);
	} else {
		console.log("🎉 All tests passed!\n");
	}
}

main().catch((err) => {
	console.error("\n💥 Fatal error:", err.message);
	console.error("   Is SiYuan running on port 6806?\n");
	process.exit(1);
});
