/**
 * Preset-scoped join shims. Cursor already ran the native / display tool;
 * DSH's scheduler only needs a registered name so it can paint a card and
 * await the same result. Not model-visible (filtered from MCP injection).
 */
import { awaitCursorJoin } from "./joins";

const ANY_OBJECT = Object.freeze({
	type: "object",
	additionalProperties: true,
	properties: {},
});

const ANY_JSON = Object.freeze({});

function identityRender(_args, value) {
	return [{ type: "text", text: String(value?.text ?? "") }];
}

function identityMeta(_args, value) {
	const meta = value?.meta;
	return meta !== undefined ? meta : null;
}

async function joinExecute(_args, exec) {
	const result = await awaitCursorJoin(exec.callId, exec.signal);
	if (result.isError) throw new Error(result.text || "Cursor tool failed");
	return {
		text: result.text,
		...result.meta !== undefined ? { meta: result.meta } : {},
	};
}

function isSearchLineMatch(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return typeof value.lineNumber === "number" && typeof value.line === "string";
}

function isSearchFileMatches(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return typeof value.path === "string" && Array.isArray(value.matches) && value.matches.every(isSearchLineMatch);
}

export function searchViewFromMeta(meta) {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
	if (typeof meta.truncated !== "boolean" || typeof meta.total !== "number") return undefined;
	if (meta.shape === "matches") {
		if (!Array.isArray(meta.files) || !meta.files.every(isSearchFileMatches)) return undefined;
		return { card: "search", shape: "matches", files: meta.files, truncated: meta.truncated, total: meta.total };
	}
	if (meta.shape === "paths") {
		if (!Array.isArray(meta.paths) || !meta.paths.every((path) => typeof path === "string")) return undefined;
		return { card: "search", shape: "paths", paths: meta.paths, truncated: meta.truncated, total: meta.total };
	}
	return undefined;
}

function presentSearchCall(title, rawInput, kind = "search") {
	return { card: "generic", title, kind, rawInput };
}

function presentSearchResult(_args, result) {
	if (result.isError) return undefined;
	return searchViewFromMeta(result.meta);
}

function presentReadCall(args) {
	const path = String(args?.file_path ?? "");
	return {
		card: "generic",
		title: path.length > 0 ? `Read ${path}` : "Read",
		kind: "read",
		...path.length > 0 ? { locations: [{ path, line: 1 }] } : {},
	};
}

function presentReadResult(args, result) {
	if (result.isError) return undefined;
	const meta = result.meta;
	if (typeof meta !== "object" || meta === null || !Array.isArray(meta.lines)) return undefined;
	const path = typeof meta.path === "string" ? meta.path : String(args?.file_path ?? "");
	return {
		card: "read",
		path,
		offset: Number.isSafeInteger(meta.offset) ? meta.offset : 1,
		lines: meta.lines,
		totalLines: Number.isSafeInteger(meta.totalLines) ? meta.totalLines : meta.lines.length,
		content: result.content,
	};
}

function presentWriteCall(args) {
	const path = String(args?.file_path ?? "");
	const next = String(args?.content ?? "");
	return {
		card: "diff",
		title: path.length > 0 ? `Write ${path}` : "Write",
		diffs: [{ path, oldText: null, newText: next }],
		...path.length > 0 ? { locations: [{ path }] } : {},
	};
}

function presentWriteResult(args, result) {
	if (result.isError) return undefined;
	const path = typeof result.meta?.path === "string" ? result.meta.path : String(args?.file_path ?? "");
	const newText = typeof result.meta?.newText === "string" ? result.meta.newText : String(args?.content ?? "");
	const oldText = result.meta?.oldText;
	return {
		card: "diff",
		title: path.length > 0 ? `Write ${path}` : "Write",
		diffs: [{ path, oldText: typeof oldText === "string" ? oldText : null, newText }],
	};
}

function presentDeleteCall(args) {
	const path = String(args?.file_path ?? "");
	return {
		card: "generic",
		title: path.length > 0 ? `Delete ${path}` : "Delete",
		kind: "other",
		...path.length > 0 ? { locations: [{ path }] } : {},
	};
}

function presentBashCall(args) {
	const command = String(args?.command ?? "");
	const view: any = { card: "terminal", title: command.length > 0 ? command : "bash" };
	if (typeof args?.description === "string" && args.description.length > 0) view.description = args.description;
	if (typeof args?.workdir === "string" && args.workdir.length > 0) view.cwd = args.workdir;
	return view;
}

function presentWebSearchCall(args) {
	const queries = Array.isArray(args?.queries) ? args.queries.map(String) : [String(args?.search_term ?? args?.query ?? "")];
	const title = queries.filter((part) => part.length > 0).join(", ") || "Web search";
	return { card: "generic", title, kind: "search", rawInput: title };
}

function presentWebSearchResult(args, result) {
	if (result.isError) return undefined;
	const meta = result.meta;
	if (typeof meta !== "object" || meta === null || !Array.isArray(meta.sources)) return undefined;
	const queries = Array.isArray(args?.queries) ? args.queries.map(String) : [];
	return {
		card: "web",
		kind: "search",
		title: queries.join(", ") || undefined,
		sources: meta.sources,
		truncated: meta.truncated === true,
		...typeof meta.answer === "string" ? { answer: meta.answer } : {},
	};
}

function presentWebFetchCall(args) {
	const url = String(args?.url ?? "");
	return { card: "generic", title: url.length > 0 ? url : "Fetch", kind: "fetch", rawInput: url };
}

function presentWebFetchResult(_args, result) {
	if (result.isError) return undefined;
	const meta = result.meta;
	if (typeof meta !== "object" || meta === null || typeof meta.url !== "string") return undefined;
	return {
		card: "web",
		kind: "fetch",
		url: meta.url,
		statusCode: Number.isSafeInteger(meta.statusCode) ? meta.statusCode : 0,
		truncated: meta.truncated === true,
	};
}

function presentTodoCall() {
	return { card: "generic", title: "Update todos", kind: "other" };
}

function joinShim({ name, description, timeoutMs, parallel, presentCall, presentResult }: any) {
	return {
		name,
		description,
		parameters: ANY_OBJECT,
		timeoutMs,
		output: {
			schema: ANY_JSON,
			render: identityRender,
			presentationMeta: identityMeta,
		},
		...parallel === true ? { isConcurrencySafe: () => true } : {},
		execute: joinExecute,
		...presentCall !== undefined ? { presentCall } : {},
		...presentResult !== undefined ? { presentResult } : {},
	};
}

/** Cursor-named join shims registered on the preset-scoped tool runtime. */
export function cursorJoinShims() {
	return [
		joinShim({
			name: "read",
			description: "Read a file (Cursor-native).",
			timeoutMs: 120_000,
			parallel: true,
			presentCall: presentReadCall,
			presentResult: presentReadResult,
		}),
		joinShim({
			name: "write",
			description: "Write a file (Cursor-native).",
			timeoutMs: 120_000,
			presentCall: presentWriteCall,
			presentResult: presentWriteResult,
		}),
		joinShim({
			name: "delete",
			description: "Delete a file (Cursor-native).",
			timeoutMs: 120_000,
			presentCall: presentDeleteCall,
		}),
		joinShim({
			name: "grep",
			description: "Search file contents (Cursor-native).",
			timeoutMs: 120_000,
			parallel: true,
			presentCall: (args) => presentSearchCall(
				`Grep ${args?.pattern ?? ""}${args?.path ? ` in ${args.path}` : ""}${args?.glob ? ` (${args.glob})` : ""}`.trim(),
				args?.pattern ?? "",
			),
			presentResult: presentSearchResult,
		}),
		joinShim({
			name: "glob",
			description: "Find files by glob (Cursor-native).",
			timeoutMs: 120_000,
			parallel: true,
			presentCall: (args) => presentSearchCall(
				`Glob ${args?.pattern ?? ""}${args?.path ? ` in ${args.path}` : ""}`.trim(),
				args?.pattern ?? "",
			),
			presentResult: presentSearchResult,
		}),
		joinShim({
			name: "bash",
			description: "Run a shell command (Cursor-native).",
			timeoutMs: 30 * 60 * 1000,
			presentCall: presentBashCall,
		}),
		joinShim({
			name: "web_search",
			description: "Search the web (Cursor-native).",
			timeoutMs: 300_000,
			parallel: true,
			presentCall: presentWebSearchCall,
			presentResult: presentWebSearchResult,
		}),
		joinShim({
			name: "web_fetch",
			description: "Fetch a URL (Cursor-native).",
			timeoutMs: 300_000,
			parallel: true,
			presentCall: presentWebFetchCall,
			presentResult: presentWebFetchResult,
		}),
		joinShim({
			name: "todo_write",
			description: "Update the session todo list (Cursor-native).",
			timeoutMs: 60_000,
			presentCall: presentTodoCall,
		}),
	];
}

export function registerCursorShims(ctx) {
	const tools = ctx.get("tools");
	if (tools === undefined) {
		ctx.logger?.warn("cursor-agent: preset tools service missing; join shims were not registered");
		return;
	}
	for (const shim of cursorJoinShims()) {
		ctx.effect(() => tools.register(shim), `cursor-agent: shim ${shim.name}`);
	}
}
