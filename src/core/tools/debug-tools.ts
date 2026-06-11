import { z } from "zod";
import { createTool } from "../tool-types";
import { TOOL_DESC } from "../../types";

const desc = TOOL_DESC.call_error;
export const callErrorTool = createTool({
	name: "call_error",
	description: desc.description,
	parameters: z.object({
		message: z.string().optional().describe(desc.params.message),
	}),
	execute({ message }) {
		throw new Error(message || "call_error debug failure");
	},
});
