/** Official Cursor Agent / auth / usage API origin. */
export const CURSOR_BASE_URL = "https://api2.cursor.sh";

/** Normalize a Cursor Agent API origin. Empty input falls back to the official host. */
export function resolveCursorApiBaseUrl(value) {
	const raw = typeof value === "string" ? value.trim() : "";
	const input = raw.length === 0 ? CURSOR_BASE_URL : raw;
	if (input.length > 2048) {
		throw new Error("cursor-agent: apiBaseUrl must be an absolute http(s) URL");
	}
	let url;
	try {
		url = new URL(input);
	} catch {
		throw new Error("cursor-agent: apiBaseUrl must be an absolute http(s) URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("cursor-agent: apiBaseUrl must be an absolute http(s) URL");
	}
	if (url.username || url.password) {
		throw new Error("cursor-agent: apiBaseUrl must not include credentials");
	}
	url.hash = "";
	url.search = "";
	let href = url.href;
	if (href.endsWith("/")) href = href.slice(0, -1);
	return href;
}
