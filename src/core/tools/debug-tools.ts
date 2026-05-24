import { z } from "zod";
import { createTool } from "../tool-types";

export const callErrorTool = createTool({
	name: "call_error",
	description: "Debug tool that always throws an error. Use only when explicitly asked to test tool failure rendering.",
	parameters: z.object({
		message: z.string().optional().describe("Optional error message to throw."),
	}),
	execute({ message }) {
		throw new Error(message || "call_error debug failure");
	},
});
