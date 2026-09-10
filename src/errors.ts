import { LlmError } from "@deepseek-ai/dsh-llm";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function parseEndStream(payload) {
	try {
		const json = JSON.parse(new TextDecoder().decode(payload));
		const error = json?.error;
		if (!error) return undefined;
		const code = typeof error.code === "string" ? error.code : "unknown";
		let debugCode;
		let title;
		let detail;
		if (Array.isArray(error.details)) {
			for (const entry of error.details) {
				if (!record(entry) || !record(entry.debug)) continue;
				if (typeof entry.debug.error === "string") debugCode = entry.debug.error;
				const details = record(entry.debug.details) ? entry.debug.details : undefined;
				if (details !== undefined) {
					if (typeof details.title === "string") title = details.title;
					if (typeof details.detail === "string") detail = details.detail;
				}
			}
		}
		const fallback = typeof error.message === "string" && error.message.length > 0 ? error.message : undefined;
		const message = [title, detail].filter((part) => typeof part === "string" && part.length > 0).join(" ")
			|| (debugCode !== undefined ? `Cursor: ${debugCode}` : undefined)
			|| (fallback !== undefined ? `Cursor agent error ${code}: ${fallback}` : `Cursor agent error ${code}`);
		return { code, debugCode, message };
	} catch {
		return undefined;
	}
}

export function classifyCursorError(message) {
	if (/\b(?:401|403)\b|unauth|invalid.*(?:key|token|credential)/i.test(message)) return "AUTH";
	if (/rate.?limit|\b429\b|quota|resource_exhausted|spend.?limit|usage limit|exceeded/i.test(message)) return "RATE_LIMIT";
	if (/\b400\b|invalid.?request/i.test(message)) return "INVALID_REQUEST";
	if (/\b408\b|timeout|timed out/i.test(message)) return "TIMEOUT";
	if (/\b5\d\d\b|internal/i.test(message)) return "SERVER";
	if (/\b(?:network|connection|socket|fetch|ECONN|http2)/i.test(message)) return "TRANSPORT";
	return "CURSOR_ERROR";
}

/** Map a thrown stream failure onto the terminal finish chunk DSH assemblers expect. */
export function finishChunkForStreamError(error, upstream) {
	if (upstream.aborted) {
		return {
			type: "finish",
			reason: { kind: "aborted", failure: { message: "Cursor request aborted by caller", code: "ABORTED" } },
		};
	}
	if (error instanceof LlmError) {
		return { type: "finish", reason: { kind: "error", failure: { message: error.message, code: error.code } } };
	}
	const message = error instanceof Error ? error.message : String(error);
	return { type: "finish", reason: { kind: "error", failure: { message, code: classifyCursorError(message) } } };
}
