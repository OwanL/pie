import type { TextContent } from "@mariozechner/pi-ai";

/** Build a TextContent part with the literal `"text"` type required by the SDK. */
export function textContent(text: string): TextContent {
	return { type: "text", text };
}
