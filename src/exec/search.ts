import {
	encodeGrepSuccessResult,
	encodeGrepErrorResult,
	encodeGrepFilesResult,
	encodeGrepCountResult,
	encodeGrepContentResult,
} from "../wire/codec";
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { ToolCallId, LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, openSync, writeSync, closeSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http2 from "node:http2";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { encodeValue, decodeValue, Reader, Writer } from "../proto";
import {
	catalogFromAvailableModels,
	decodeAvailableModels,
	encodeAvailableModelsRequest,
	encodeRequestedModel,
	FALLBACK_CONTEXT_WINDOW,
	inputModalitiesFromCatalog,
	reasoningFromCatalogEntry,
	resolveCursorModelSelection,
} from "../models";
import {
	runPackagedRipgrep,
	runCursorSearch,
	cursorSandboxTypeToMode,
	worldFromAgent,
	execRead,
	execWrite,
	execDelete,
	execSearch,
	startCursorShell,
	pumpCursorShell,
	noteProbeRead,
	takeProbeRead,
} from "../exec-plane";
import {
	failCursorJoin,
	openCursorJoin,
	settleCursorJoin,
} from "../joins";
import { registerCursorShims } from "../shims";
import { collectCursorRules, encodeCursorRule, mergeDshSystemRule } from "../rules";
import {
	collectImageBlocks,
	contentHasImages,
	encodeSelectedContext,
	formatImageReadJoinText,
	resolveSelectedImages,
} from "../images";
import { CHECKPOINT_OBJECTS_SEGMENTS, createCheckpointStore, createLocalObjectStore } from "../checkpoint-store";
import {
	CURSOR_CHECKPOINT_SCHEMA_VERSION,
	appendCursorCheckpointEvent,
	listCursorCheckpointEvents,
	pickCursorCheckpointEvent,
} from "../checkpoint-log";
import {
	ACP_SYSTEM_SECTION,
	applyCursorCompaction,
	applySummaryFromPump,
	decodeConversationStateSummary,
	decodeSummaryUpdate,
	sanitizeConversationStateForSend,
	encodeSummarizeAction,
	isDeniedCursorMcpTool,
	pickCheckpointSummaryCommit,
	registerCursorSummarize,
	shouldDropCursorInject,
} from "../compaction";

export function classifyCursorSearch(args : any = {}) {
	const pattern = typeof args.pattern === "string" ? args.pattern : "";
	const path = typeof args.path === "string" ? args.path : "";
	const glob = typeof args.glob === "string" ? args.glob : "";
	const outputMode = args.outputMode || "content";
	const offset = Number.isSafeInteger(args.offset) ? args.offset : 0;
	if (outputMode === "files_with_matches" && pattern.length === 0 && glob.length > 0) {
		const displayArgs: any = { pattern: glob };
		if (path.length > 0) displayArgs.path = path;
		return {
			kind: "glob",
			displayName: "glob",
			displayArgs,
			wirePattern: pattern,
			wirePath: path,
			outputMode,
			offset,
			search: { mode: "glob", pattern: glob, path },
		};
	}
	const displayArgs: any = { pattern };
	if (path.length > 0) displayArgs.path = path;
	if (glob.length > 0) displayArgs.glob = glob;
	if (args.caseInsensitive === true) displayArgs.case_insensitive = true;
	if (Number.isSafeInteger(args.headLimit) && args.headLimit > 0) displayArgs.head_limit = args.headLimit;
	displayArgs.output_mode = outputMode;
	return {
		kind: "grep",
		displayName: "grep",
		displayArgs,
		wirePattern: pattern,
		wirePath: path,
		outputMode,
		offset,
		search: {
			mode: outputMode,
			pattern,
			path,
			glob,
			caseInsensitive: args.caseInsensitive === true,
			headLimit: Number.isSafeInteger(args.headLimit) && args.headLimit > 0 ? args.headLimit : undefined,
		},
	};
}

/** Encode a structured search result as the Cursor GrepResult wire payload. */
export function encodeGrepSearchResult(classified, result) {
	if (result?.error) return encodeGrepErrorResult(String(result.error));
	const offset = classified.offset > 0 ? classified.offset : 0;
	const offsetApplied = offset > 0 ? offset : undefined;
	const { wirePattern: pattern, wirePath: path, outputMode } = classified;
	if (result.mode === "files_with_matches" || result.mode === "glob") {
		const files = (result.files ?? []).slice(offset);
		return encodeGrepSuccessResult({
			pattern,
			path,
			outputMode,
			unionBytes: new Writer().message(2, encodeGrepFilesResult({
				files,
				totalFiles: result.totalFiles,
				clientTruncated: result.truncated === true,
				offsetApplied,
			})).finish(),
		});
	}
	if (result.mode === "count") {
		const counts = (result.counts ?? []).slice(offset);
		return encodeGrepSuccessResult({
			pattern,
			path,
			outputMode,
			unionBytes: new Writer().message(1, encodeGrepCountResult({
				counts,
				totalFiles: result.totalFiles,
				totalMatches: result.totalMatches,
				clientTruncated: result.truncated === true,
				offsetApplied,
			})).finish(),
		});
	}
	const matches = (result.matches ?? []).slice(offset);
	return encodeGrepSuccessResult({
		pattern,
		path,
		outputMode,
		unionBytes: new Writer().message(3, encodeGrepContentResult({
			matches,
			totalLines: result.totalMatchedLines,
			totalMatchedLines: result.totalMatchedLines,
			clientTruncated: result.truncated === true,
			ripgrepTruncated: result.ripgrepTruncated === true,
			offsetApplied,
		})).finish(),
	});
}

/**
 * DSH Web search-card meta. `lineNumber` must be >= 1; `include` is never set
 * (Cursor's glob filter stays on the call args as `glob`).
 */
export function searchMetaFromResult(classified, result) {
	if (result?.error) return undefined;
	const offset = classified.offset > 0 ? classified.offset : 0;
	if (result.mode === "content") {
		const files = [];
		for (const group of (result.matches ?? []).slice(offset)) {
			const matches = [];
			for (const match of group.matches ?? []) {
				const lineNumber = Number(match.lineNumber);
				if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) continue;
				matches.push({ lineNumber, line: String(match.content ?? "").replace(/\n$/, "") });
			}
			if (matches.length > 0) files.push({ path: group.file, matches });
		}
		return { shape: "matches", files, truncated: result.truncated === true, total: result.totalMatchedLines ?? 0 };
	}
	if (result.mode === "count") {
		const paths = (result.counts ?? []).slice(offset).map((entry) => entry.file);
		return { shape: "paths", paths, truncated: result.truncated === true, total: result.totalFiles ?? paths.length };
	}
	const paths = (result.files ?? []).slice(offset);
	return { shape: "paths", paths, truncated: result.truncated === true, total: result.totalFiles ?? paths.length };
}

/** Short generic-fallback text; never the wire JSON contract. */
export function searchResultSummary(classified, result) {
	if (result?.error) return String(result.error);
	if (result.mode === "content") {
		const n = result.totalMatchedLines ?? 0;
		return n === 0 ? "No matches found" : `${n} match${n === 1 ? "" : "es"}`;
	}
	if (result.mode === "count") {
		const matches = result.totalMatches ?? 0;
		const files = result.totalFiles ?? 0;
		return `${matches} match${matches === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"}`;
	}
	const n = result.totalFiles ?? (result.files ?? []).length;
	return n === 0 ? "No files found" : `${n} file${n === 1 ? "" : "s"}`;
}

/** DeleteSuccess { path=1, deleted_file=2, file_size=3, prev_content=4 } */
function encodeDeleteSuccessInner({ path, deletedFile, fileSize }: any) {
	const writer = new Writer();
	writer.string(1, path ?? "");
	writer.string(2, deletedFile ?? path ?? "");
	if (Number.isSafeInteger(fileSize) && fileSize >= 0) writer.varint(3, fileSize);
	return writer.finish();
}

/** DeleteResult { success=1 DeleteSuccess } — the full field-4 payload. */
export function encodeDeleteSuccess(args) {
	return new Writer().message(1, encodeDeleteSuccessInner(args)).finish();
}

/** DeleteError { path=1, error=2 } → DeleteResult { error=7 }. */
function encodeDeleteErrorInner({ path, error }: any) {
	const writer = new Writer();
	writer.string(1, path ?? "");
	writer.string(2, String(error ?? ""));
	return writer.finish();
}

export function encodeDeleteError(args) {
	return new Writer().message(7, encodeDeleteErrorInner(args)).finish();
}

/** WritePermissionDenied { path=1, directory=2, operation=3, error=4, is_readonly=5 } → WriteResult { permission_denied=3 } — every field the server might render is filled. */
export function encodeWritePermissionDenied({ path, error }: any) {
	const inner = new Writer();
	inner.string(1, path ?? "");
	inner.string(2, dirname(path ?? ""));
	inner.string(3, "write");
	inner.string(4, String(error ?? ""));
	return new Writer().message(3, inner.finish()).finish();
}

/** DeletePermissionDenied { path=1, client_visible_error=2 } → DeleteResult { permission_denied=4 }. */
export function encodeDeletePermissionDenied({ path, error }: any) {
	const inner = new Writer();
	inner.string(1, path ?? "");
	inner.string(2, String(error ?? ""));
	return new Writer().message(4, inner.finish()).finish();
}

/**
 * Split raw text into lines without a phantom trailing empty line: "a\nb\n"
 * has 2 lines, "" has 0. Used for the DSH read card; wire `total_lines`
 * follows Cursor's `Hj0` (trailing newline counts).
 */
function splitRawLines(text) {
	const value = String(text ?? "");
	if (value.length === 0) return [];
	const lines = value.split("\n");
	if (value.endsWith("\n")) lines.pop();
	return lines;
}

/**
 * LocalReadExecutor hard cap (`Y3` in `@cursor/sdk`). `ReadSuccess.truncated`
 * is only this character cut — not "the model asked for a range".
 */
export const READ_CONTENT_CHAR_CAP = 8_388_608;

/**
 * Cursor's `Hj0` line count: empty file is 1 line; every `\n` adds a line,
 * including a trailing newline's phantom empty line.
 */
function countCursorLines(text) {
	if (text === "") return 1;
	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) lines++;
	}
	return lines;
}

/**
 * Line-window meta for the DSH read card. Join `text` is a short occupancy
 * stub (the upload is not model-visible on the DSH surface); the card reads
 * these numbered lines.
 */
export function readPresentationMeta(path, text, extras : any = {}) {
	const lines = splitRawLines(text);
	const offset = Number.isSafeInteger(extras.offset) && extras.offset > 0 ? extras.offset : 1;
	const totalLines = Number.isSafeInteger(extras.totalLines) ? extras.totalLines : lines.length;
	return {
		path: String(path ?? ""),
		offset,
		lines: lines.map((line, index) => ({ number: offset + index, text: line })),
		totalLines,
	};
}

/**
 * Short DSH-priced join text. Cursor already received the file on the
 * ReadSuccess wire; identity-rendering that upload would make token-meter
 * treat server-side prompt truncation as local occupancy.
 */
export function formatReadJoinText(path, window) {
	const name = String(path ?? "").trim() || "file";
	const lines = Number.isSafeInteger(window?.totalLines) ? window.totalLines : 0;
	return `${name} (${lines} lines)`;
}

/**
 * Agent.v1 LocalReadExecutor window (`oK8` + `Y3` in `@cursor/sdk`).
 *
 * - No offset/limit → whole file, `range_applied=false`.
 * - Offset/limit actually sliced → `range_applied=true`. Past-EOF offset
 *   leaves the whole file and does not set the flag.
 * - `truncated` is only the 8 MiB character cap. A model-requested range
 *   does not set it.
 * - No footer / continuation copy (that text is the Pi read tool, not
 *   `ReadSuccess.content`).
 *
 * @returns { content, totalLines, truncated, rangeApplied, startLine }
 */
export function composeReadWindow(text, { offset, limit } : any = {}) {
	const raw = String(text ?? "");
	const totalLines = countCursorLines(raw);
	let content = raw;
	let rangeApplied = false;
	let startLine = 1;

	if ((offset !== undefined || limit !== undefined) && raw !== "") {
		const startOffset = offset ?? 1;
		const windowLimit = limit ?? (startOffset < 0 ? Math.abs(startOffset) : totalLines);
		const start = startOffset < 0 ? Math.max(0, totalLines + startOffset) : Math.max(0, startOffset - 1);
		if (start < totalLines) {
			const end = Math.min(totalLines, start + windowLimit);
			content = raw.split("\n").slice(start, end).join("\n");
			rangeApplied = true;
			startLine = start + 1;
		}
	}

	let truncated = false;
	if (content.length > READ_CONTENT_CHAR_CAP) {
		content = content.substring(0, READ_CONTENT_CHAR_CAP);
		truncated = true;
	}

	return { content, totalLines, truncated, rangeApplied, startLine };
}

/**
 * Canonical failure texts from the escalation tools, mapped to three wire
 * tiers so the model can tell a human "no" from an environment denial:
 *   user rejection → the `rejected` variant,
 *   sandbox/approval-channel denial → the `permission_denied` variant,
 *   everything else → the generic `error` variant.
 */
export const WRITE_USER_REJECTED = /^(?:Error: )?cannot write ".*": permission denied \((?:the user rejected|approval was cancelled)/;
export const WRITE_DENIED = /^(?:Error: )?cannot write ".*": permission denied/;
export const DELETE_USER_REJECTED = /^(?:Error: )?cannot delete ".*": permission denied \((?:the user rejected|approval was cancelled)/;
export const DELETE_DENIED = /^(?:Error: )?cannot delete ".*": permission denied/;
export const SANDBOX_MODE_DENIED = /file access denied under (?:read-only|workspace-write|danger-full-access) mode/;

function countLines(content) {
	const text = String(content ?? "");
	if (text.length === 0) return 0;
	return text.split("\n").length;
}

/** The exec-client reply field for each whitelisted native exec frame. */
export const EXEC_REPLY_FIELDS = Object.freeze({
	readArgs: 7,
	writeArgs: 3,
	grepArgs: 5,
	deleteArgs: 4,
});
