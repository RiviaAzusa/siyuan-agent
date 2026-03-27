import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
	resolve: {
		alias: {
			siyuan: resolve(__dirname, "test/mocks/siyuan.ts"),
		},
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
