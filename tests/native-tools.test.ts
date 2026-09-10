/**
 * Unit tests for the Phase 1 Cursor native tool support:
 * native result encoders, arg decoders, exec translation, the interaction
 * bridge, and the todo sync — all against the reconstructed agent.v1 wire
 * schemas (b-nnett/grok-bot-0.18-reconstructed, commit
 * a9f633e09d49a85829b8236331b9e21f7e612634).
 */
import { test } from "@rstest/core";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Writer, Reader } from "../src/proto";
import {
	isCursorNativeTool,
	encodeReadSuccess,
	encodeReadError,
	encodeReadFileNotFound,
	encodeReadInvalidFile,
	encodeWriteSuccess,
	encodeWriteError,
	encodeWritePermissionDenied,
	encodeDeleteSuccess,
	encodeDeleteError,
	encodeDeletePermissionDenied,
	translateNativeExec,
	classifyCursorSearch,
	encodeGrepSearchResult,
	searchMetaFromResult,
	searchResultSummary,
	runCursorSearch,
	allocateLocalToolCallId,
	composeReadWindow,
	formatReadJoinText,
	READ_CONTENT_CHAR_CAP,
	encodeShellStreamStart,
	encodeShellStreamStdout,
	encodeShellStreamStderr,
	encodeShellStreamExit,
	encodeShellStreamBackgrounded,
	createPidProbe,
	parseJobIdN,
	encodeWriteRejected,
	encodeDeleteRejected,
	encodeShellSuccess,
	encodeShellFailure,
	encodeShellTimeout,
	encodeShellSpawnError,
	encodeShellPermissionDenied,
	encodeBackgroundShellSpawnSuccess,
	encodeBackgroundShellSpawnError,
	encodeWriteShellStdinSuccess,
	encodeWriteShellStdinError,
	encodeInteractionResponseEnvelope,
	encodeAskQuestionSuccess,
	encodeAskQuestionResultSuccess,
	encodeAskQuestionResultError,
	encodeAskQuestionInteractionResponse,
	buildAskQuestionResultBytes,
	encodeInteractionApproved,
	encodeInteractionRejected,
	INTERACTION_UNAVAILABLE,
	rejectionForInteraction,
	normalizeCursorTodos,
	decodeAskQuestionInteractionQuery,
	decodeInteractionQuery,
	decodeReadArgs,
	decodeWriteArgs,
	decodeGrepArgs,
	decodeDeleteArgs,
	decodeShellArgs,
	decodeToolCallDisplay,
	parseCursorWebSearchChunk,
	decodeBackgroundShellSpawnArgs,
	decodeWriteShellStdinArgs,
	splitShellDelta,
	cursorSandboxTypeToMode,
	decodeConversationStateTodos,
	decodeExecServerMessage,
	formatCursorTerminalHeader,
	formatCursorTerminalFooter,
	createCursorTerminalLog,
	noteProbeRead,
	takeProbeRead,
	createStreamBlocks,
	emitToolCall,
	execRead,
	execWrite,
	execDelete,
	openCursorJoin,
	settleCursorJoin,
	awaitCursorJoin,
	resetCursorJoins,
	readPresentationMeta,
	displayJoinResult,
	cursorJoinShims,
	searchViewFromMeta,
} from "../src/index";

/** Encode a string into a plain byte array (deepStrictEqual-safe). */
const bytes = (text) => Array.from(new TextEncoder().encode(text));

/** Walk one message into [field, wireType, value] triples (varint | bytes). */
function fields(bytes) {
	const reader = new Reader(bytes);
	const out = [];
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (wireType === 0) out.push([field, "v", reader.varint()]);
		else if (wireType === 2) out.push([field, "b", Array.from(reader.bytes())]);
		else {
			reader.skip(wireType);
			out.push([field, "s"]);
		}
	}
	return out;
}

test("isCursorNativeTool matches snake_case Cursor names and rejects others", () => {
	assert.equal(isCursorNativeTool("read"), true);
	assert.equal(isCursorNativeTool("todo_write"), true);
	assert.equal(isCursorNativeTool("web_fetch"), true);
	assert.equal(isCursorNativeTool("apply_patch"), true);
	assert.equal(isCursorNativeTool("Read"), true);
	assert.equal(isCursorNativeTool("ask_user_question"), true);
	assert.equal(isCursorNativeTool("subagent_cursor"), true);
	assert.equal(isCursorNativeTool("subagent_fork"), true);
	// Hyphenated spellings normalize to snake_case and still match.
	assert.equal(isCursorNativeTool("ask-user-question"), true);
	assert.equal(isCursorNativeTool("workflow"), false);
	assert.equal(isCursorNativeTool(""), false);
	assert.equal(isCursorNativeTool(undefined), false);
});

test("decodeReadArgs reads path/toolCallId/offset/limit, negative offset intact", () => {
	const writer = new Writer();
	writer.string(1, "src/a.ts");
	writer.string(2, "call-1");
	writer.varint(4, 0xffffffff); // int32 -1
	writer.varint(5, 50);
	const args = decodeReadArgs(writer.finish());
	assert.equal(args.path, "src/a.ts");
	assert.equal(args.toolCallId, "call-1");
	assert.equal(args.offset, -1);
	assert.equal(args.limit, 50);
});

test("decodeWriteArgs reads text, toolCallId, echo flag and fileBytes", () => {
	const writer = new Writer();
	writer.string(1, "out.txt");
	writer.string(2, "hello");
	writer.string(3, "call-2");
	writer.varint(4, 1);
	const args = decodeWriteArgs(writer.finish());
	assert.equal(args.path, "out.txt");
	assert.equal(args.fileText, "hello");
	assert.equal(args.toolCallId, "call-2");
	assert.equal(args.returnFileContentAfterWrite, true);
	assert.equal(args.fileBytes, undefined);

	const binary = new Writer();
	binary.string(1, "x.bin");
	binary.bytes(5, new Uint8Array([1, 2, 3]));
	const binaryArgs = decodeWriteArgs(binary.finish());
	assert.deepEqual(Array.from(binaryArgs.fileBytes), [1, 2, 3]);
});

test("decodeGrepArgs reads pattern/path/glob/outputMode/toolCallId", () => {
	const writer = new Writer();
	writer.string(1, "TODO");
	writer.string(2, "src");
	writer.string(3, "**/*.ts");
	writer.string(4, "files_with_matches");
	writer.string(14, "call-3");
	const args = decodeGrepArgs(writer.finish());
	assert.equal(args.pattern, "TODO");
	assert.equal(args.path, "src");
	assert.equal(args.glob, "**/*.ts");
	assert.equal(args.outputMode, "files_with_matches");
	assert.equal(args.toolCallId, "call-3");
});

test("decodeDeleteArgs reads path and toolCallId", () => {
	const writer = new Writer();
	writer.string(1, "tmp/x");
	writer.string(2, "call-4");
	const args = decodeDeleteArgs(writer.finish());
	assert.deepEqual(args, { path: "tmp/x", toolCallId: "call-4" });
});

test("decodeExecServerMessage carries full args for whitelisted frames", () => {
	const writer = new Writer();
	writer.varint(1, 7);
	writer.string(15, "exec-1");
	writer.message(3, new Writer().string(1, "f.txt").string(2, "data").finish());
	const exec = decodeExecServerMessage(writer.finish());
	assert.equal(exec.case, "writeArgs");
	assert.equal(exec.path, "f.txt");
	assert.deepEqual(exec.args, { path: "f.txt", fileText: "data", toolCallId: "" });
});

test("encodeReadSuccess + encodeReadError carry the ReadResult oneof wrapper", () => {
	// The exec-client field 7 payload is ReadResult { success=1 ReadSuccess }.
	const result = fields(encodeReadSuccess({
		path: "a.ts",
		content: "1|one\n2|two",
		totalLines: 2,
		fileSize: 11,
		rangeApplied: true,
	}));
	assert.equal(result.length, 1);
	assert.equal(result[0][0], 1); // success
	const success = fields(new Uint8Array(result[0][2]));
	assert.deepEqual(success, [
		[1, "b", bytes("a.ts")],
		[2, "b", bytes("1|one\n2|two")],
		[3, "v", 2],
		[4, "v", 11],
		[8, "v", 1],
	]);

	const error = fields(encodeReadError({ path: "a.ts", error: "nope" }));
	assert.equal(error.length, 1);
	assert.equal(error[0][0], 2); // error
	const errorInner = fields(new Uint8Array(error[0][2]));
	assert.deepEqual(errorInner, [
		[1, "b", bytes("a.ts")],
		[2, "b", bytes("nope")],
	]);
});

test("encodeReadSuccess data uses the output oneof instead of content", () => {
	const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
	const result = fields(encodeReadSuccess({
		path: "shot.png",
		data: png,
		totalLines: 0,
		fileSize: png.length,
	}));
	assert.equal(result[0][0], 1);
	const success = fields(new Uint8Array(result[0][2]));
	assert.equal(success[0][0], 1);
	assert.equal(success[1][0], 5);
	assert.deepEqual(success[1][2], Array.from(png));
	assert.equal(success.some((field) => field[0] === 2), false);
	const invalid = fields(encodeReadInvalidFile({ path: "a.bin", reason: "Binary files of type .bin are not supported by the read executor" }));
	assert.equal(invalid[0][0], 6);
});

test("encodeWriteSuccess carries the WriteResult wrapper", () => {
	const result = fields(encodeWriteSuccess({ path: "o.txt", content: "a\nb\n", returnFileContentAfterWrite: true }));
	assert.equal(result.length, 1);
	assert.equal(result[0][0], 1); // success
	const success = fields(new Uint8Array(result[0][2]));
	assert.equal(success.length, 4);
	assert.equal(success[0][0], 1);
	assert.equal(success[1][0], 2);
	assert.equal(success[1][2], 3); // lines_created
	assert.equal(success[2][0], 3);
	assert.equal(success[2][2], 4); // file_size bytes
	assert.equal(success[3][0], 4);
	assert.deepEqual(success[3][2], bytes("a\nb\n"));
});

test("translateNativeExec read: raw content, exact totals, negative offset slicing", () => {
	const normal = translateNativeExec({ case: "readArgs", args: { path: "a.ts", toolCallId: "c1", offset: 2, limit: 2 } });
	assert.equal(normal.tool, "read");
	assert.deepEqual(normal.args, { file_path: "a.ts" });
	assert.equal(normal.field, 7);
	// cursor_read returns RAW text; the bridge composes the window with the
	// exact total. "a\nb\nc\nd\n" = 4 lines.
	const raw = "a\nb\nc\nd\n";
	const successResult = fields(normal.encode(raw, false));
	assert.equal(successResult.length, 1);
	assert.equal(successResult[0][0], 1); // ReadResult.success
	const success = fields(new Uint8Array(successResult[0][2]));
	assert.deepEqual(success, [
		[1, "b", bytes("a.ts")],
		[2, "b", bytes("b\nc")], // lines 2-3
		[3, "v", 5], // Hj0 total_lines ("a\\nb\\nc\\nd\\n" has a trailing empty line)
		[8, "v", 1], // rangeApplied; truncated is only the 8 MiB cap
	]);
	const errorResult = fields(normal.encode("boom", true));
	assert.equal(errorResult.length, 1);
	assert.equal(errorResult[0][0], 2); // ReadResult.error
	const error = fields(new Uint8Array(errorResult[0][2]));
	assert.deepEqual(error, [
		[1, "b", bytes("a.ts")],
		[2, "b", bytes("boom")],
	]);

	// Negative offset = last |offset| lines, including the trailing empty line.
	const negative = translateNativeExec({ case: "readArgs", args: { path: "a.ts", offset: -2 } });
	const negativeResult = fields(negative.encode(raw, false));
	const negativeSuccess = fields(new Uint8Array(negativeResult[0][2]));
	assert.deepEqual(negativeSuccess[1], [2, "b", bytes("d\n")]);
	assert.deepEqual(negativeSuccess[2], [3, "v", 5]);

	// Whole-file read (no offset/limit): content passes through verbatim.
	const whole = translateNativeExec({ case: "readArgs", args: { path: "a.ts" } });
	const wholeResult = fields(whole.encode(raw, false));
	const wholeSuccess = fields(new Uint8Array(wholeResult[0][2]));
	assert.deepEqual(wholeSuccess[1], [2, "b", bytes(raw)]);
	assert.deepEqual(wholeSuccess[2], [3, "v", 5]);
	assert.equal(wholeSuccess.length, 3); // no truncated/rangeApplied fields
});

test("composeReadWindow matches LocalReadExecutor oK8 + 8 MiB cap", () => {
	const raw = "l1\nl2\nl3\nl4\nl5\n";
	assert.deepEqual(composeReadWindow(raw, {}), { content: raw, totalLines: 6, truncated: false, rangeApplied: false, startLine: 1 });
	assert.deepEqual(composeReadWindow(raw, { offset: 2, limit: 2 }), { content: "l2\nl3", totalLines: 6, truncated: false, rangeApplied: true, startLine: 2 });
	assert.deepEqual(composeReadWindow(raw, { offset: -2 }), { content: "l5\n", totalLines: 6, truncated: false, rangeApplied: true, startLine: 5 });
	assert.deepEqual(composeReadWindow(raw, { offset: 100 }), { content: raw, totalLines: 6, truncated: false, rangeApplied: false, startLine: 1 });
	assert.deepEqual(composeReadWindow("", {}), { content: "", totalLines: 1, truncated: false, rangeApplied: false, startLine: 1 });
	assert.deepEqual(composeReadWindow("", { offset: 1, limit: 10 }), { content: "", totalLines: 1, truncated: false, rangeApplied: false, startLine: 1 });

	const huge = "x".repeat(READ_CONTENT_CHAR_CAP + 16);
	const capped = composeReadWindow(huge, {});
	assert.equal(capped.content.length, READ_CONTENT_CHAR_CAP);
	assert.equal(capped.truncated, true);
	assert.equal(capped.rangeApplied, false);
	assert.equal(capped.content.includes("Showing lines"), false);
	assert.equal(formatReadJoinText("agent-instructions.spec.ts", { totalLines: 4123 }), "agent-instructions.spec.ts (4123 lines)");
});

test("translateNativeExec write: fileBytes rejected, text mapped, permission denied variant", () => {
	const binary = translateNativeExec({ case: "writeArgs", args: { path: "b.bin", fileBytes: new Uint8Array([1]) } });
	assert.ok(binary.reject !== undefined);
	assert.equal(binary.field, 3);

	const text = translateNativeExec({ case: "writeArgs", args: { path: "o.txt", fileText: "hi", returnFileContentAfterWrite: true } });
	assert.equal(text.tool, "write");
	assert.deepEqual(text.args, { file_path: "o.txt", content: "hi" });
	assert.equal(text.field, 3);
	const successResult = fields(text.encode("", false));
	assert.equal(successResult.length, 1);
	assert.equal(successResult[0][0], 1); // WriteResult.success
	const success = fields(new Uint8Array(successResult[0][2]));
	assert.equal(success[0][0], 1);
	assert.equal(success[1][0], 2);
	assert.equal(success[1][2], 1);
	assert.equal(success[2][0], 3);
	assert.equal(success[2][2], 2);
	assert.equal(success[3][0], 4);

	// The escalation tool throws `cannot write "<path>": permission denied …`.
	// A USER rejection maps to WriteResult.rejected (6) so the model can tell
	// a human "no" from an environment denial.
	const rejected = fields(text.encode('Error: cannot write "/x/o.txt": permission denied (the user rejected the sandbox escalation)', true));
	assert.equal(rejected[0][0], 6); // rejected
	const rejectedInner = fields(new Uint8Array(rejected[0][2]));
	assert.deepEqual(rejectedInner[0], [1, "b", bytes("o.txt")]); // path
	assert.deepEqual(rejectedInner[1], [2, "b", bytes('Error: cannot write "/x/o.txt": permission denied (the user rejected the sandbox escalation)')]); // reason

	// An environment denial (no approval channel / sandbox mode) maps to
	// permission_denied (3) with every server-rendered field filled.
	const denied = fields(text.encode('Error: cannot write "/x/o.txt": permission denied (no approval channel is available)', true));
	assert.equal(denied[0][0], 3); // permission_denied
	const deniedInner = fields(new Uint8Array(denied[0][2]));
	assert.deepEqual(deniedInner[0], [1, "b", bytes("o.txt")]); // path
	assert.equal(deniedInner[1][0], 2); // directory
	assert.deepEqual(deniedInner[2], [3, "b", bytes("write")]); // operation
	assert.deepEqual(deniedInner[3], [4, "b", bytes('Error: cannot write "/x/o.txt": permission denied (no approval channel is available)')]); // error

	// A raw sandbox-mode denial also maps to permission_denied.
	const sandboxDenied = fields(text.encode('cannot write "/x/o.txt": file access denied under read-only mode', true));
	assert.equal(sandboxDenied[0][0], 3);

	// Any other failure stays the generic error variant.
	const generic = fields(text.encode("disk full", true));
	assert.equal(generic[0][0], 5); // WriteResult.error
});

test("classifyCursorSearch: glob-via-grep vs grep display args (no include)", () => {
	const glob = classifyCursorSearch({
		pattern: "",
		glob: "**/*.ts",
		outputMode: "files_with_matches",
		path: "src",
	});
	assert.equal(glob.kind, "glob");
	assert.equal(glob.displayName, "glob");
	assert.deepEqual(glob.displayArgs, { pattern: "**/*.ts", path: "src" });
	assert.equal(Object.hasOwn(glob.displayArgs, "include"), false);
	assert.equal(glob.wirePattern, "");
	assert.equal(glob.wirePath, "src");

	const content = classifyCursorSearch({ pattern: "TODO", path: "src", glob: "*.ts" });
	assert.equal(content.kind, "grep");
	assert.equal(content.displayName, "grep");
	assert.deepEqual(content.displayArgs, { pattern: "TODO", path: "src", glob: "*.ts", output_mode: "content" });
	assert.equal(Object.hasOwn(content.displayArgs, "include"), false);

	const count = classifyCursorSearch({ pattern: "TODO", outputMode: "count" });
	assert.equal(count.kind, "grep");
	assert.equal(count.displayArgs.output_mode, "count");
	assert.equal(count.search.mode, "count");

	// Empty-pattern grep without a glob stays grep (the Web card rejects it).
	const empty = classifyCursorSearch({ pattern: "", outputMode: "files_with_matches" });
	assert.equal(empty.kind, "grep");
	assert.equal(empty.displayName, "grep");
});

test("encodeGrepSearchResult: cursor glob/grep wire contracts", () => {
	const glob = classifyCursorSearch({
		pattern: "",
		glob: "**/*.ts",
		outputMode: "files_with_matches",
		path: "src",
	});
	const globResult = fields(encodeGrepSearchResult(glob, { mode: "glob", files: ["a.ts", "b.ts"], totalFiles: 2, truncated: false }));
	assert.equal(globResult[0][0], 1);
	const globSuccess = fields(new Uint8Array(globResult[0][2]));
	assert.equal(globSuccess[3][0], 4);
	const globEntry = fields(new Uint8Array(globSuccess[3][2]));
	assert.equal(globEntry.length, 2);
	assert.equal(globEntry[0][0], 1); // key
	assert.deepEqual(globEntry[0][2], bytes("src"));
	assert.equal(globEntry[1][0], 2); // value = GrepUnionResult
	const globUnion = fields(new Uint8Array(globEntry[1][2]));
	assert.equal(globUnion[0][0], 2); // files variant

	const content = classifyCursorSearch({ pattern: "TODO", path: "src", glob: "*.ts" });
	const contentResult = fields(encodeGrepSearchResult(content, {
		mode: "content",
		matches: [{ file: "src/a.ts", matches: [{ lineNumber: 3, content: "TODO x" }] }],
		totalMatchedLines: 1,
		truncated: false,
	}));
	assert.equal(contentResult[0][0], 1);
	const contentSuccess = fields(new Uint8Array(contentResult[0][2]));
	assert.equal(contentSuccess[3][0], 4);
	const contentEntry = fields(new Uint8Array(contentSuccess[3][2]));
	assert.equal(contentEntry[0][0], 1);
	assert.deepEqual(contentEntry[0][2], bytes("src"));
	const contentUnion = fields(new Uint8Array(contentEntry[1][2]));
	assert.equal(contentUnion[0][0], 3); // content variant

	const count = classifyCursorSearch({ pattern: "TODO", outputMode: "count" });
	const countResult = fields(encodeGrepSearchResult(count, {
		mode: "count",
		counts: [{ file: "src/a.ts", count: 3 }],
		totalFiles: 1,
		totalMatches: 3,
		truncated: false,
	}));
	assert.equal(countResult[0][0], 1);
	const countSuccess = fields(new Uint8Array(countResult[0][2]));
	const countEntry = fields(new Uint8Array(countSuccess[3][2]));
	assert.equal(countEntry[0][0], 1);
	assert.deepEqual(countEntry[0][2], bytes(".")); // no path → "."
	const countUnion = fields(new Uint8Array(countEntry[1][2]));
	assert.equal(countUnion[0][0], 1); // count variant

	const bad = fields(encodeGrepSearchResult(content, { error: "not json" }));
	assert.equal(bad[0][0], 2); // GrepResult.error
});

test("grep result carries output_mode, totals, truncation, offset — JSON contract parity", () => {
	// An omitted output_mode must land on the wire as "content" ("" renders as
	// "unknown output mode" upstream).
	const omitted = classifyCursorSearch({ pattern: "TODO" });
	const omittedResult = fields(encodeGrepSearchResult(omitted, {
		mode: "content",
		matches: [{ file: "src/a.ts", matches: [{ lineNumber: 3, content: "TODO x" }] }],
		totalMatchedLines: 1,
		truncated: false,
	}));
	assert.equal(omittedResult[0][0], 1); // GrepResult.success
	const omittedSuccess = fields(new Uint8Array(omittedResult[0][2]));
	assert.equal(omittedSuccess[2][0], 3); // output_mode
	assert.deepEqual(omittedSuccess[2][2], bytes("content"));

	// Truncated + offset: client_truncated=1, ripgrep_truncated=1,
	// offset_applied echoed, total_lines == total_matched_lines.
	const full = classifyCursorSearch({ pattern: "recursive.*", path: "src", offset: 2 });
	const fullResult = fields(encodeGrepSearchResult(full, {
		mode: "content",
		matches: [
			{ file: "src/a.ts", matches: [{ lineNumber: 3, content: "x" }] },
			{ file: "src/a.ts", matches: [{ lineNumber: 9, content: "y" }] },
			{ file: "src/b.ts", matches: [{ lineNumber: 1, content: "z" }] },
		],
		totalMatchedLines: 3,
		truncated: true,
		ripgrepTruncated: true,
	}));
	const fullSuccess = fields(new Uint8Array(fullResult[0][2]));
	assert.deepEqual(fullSuccess[2][2], bytes("content"));
	const entry = fields(new Uint8Array(fullSuccess[3][2])); // map entry
	assert.deepEqual(entry[0][2], bytes("src"));
	const union = fields(new Uint8Array(entry[1][2]));
	assert.equal(union[0][0], 3); // content variant
	const payload = fields(new Uint8Array(union[0][2]));
	const byField = new Map(payload.map(([field, type, value]) => [field, { type, value }]));
	assert.equal(byField.get(2).value, 3); // total_lines == 3 match lines
	assert.equal(byField.get(3).value, 3); // total_matched_lines
	assert.equal(byField.get(4).value, 1); // client_truncated
	assert.equal(byField.get(5).value, 1); // ripgrep_truncated
	assert.equal(byField.get(7).value, 2); // offset_applied echoes args.offset
	// matches: offset 2 slices the first two entries away.
	const matchBytes = payload.filter(([field]) => field === 1);
	assert.equal(matchBytes.length, 1);
});

test("searchMetaFromResult projects DSH search-card meta (no include, lineNumber >= 1)", () => {
	const grep = classifyCursorSearch({ pattern: "TODO", glob: "*.ts" });
	const matchesMeta = searchMetaFromResult(grep, {
		mode: "content",
		matches: [
			{ file: "src/a.ts", matches: [{ lineNumber: 3, content: "TODO x\n" }, { lineNumber: 0, content: "skip" }] },
		],
		totalMatchedLines: 2,
		truncated: false,
	});
	assert.deepEqual(matchesMeta, {
		shape: "matches",
		files: [{ path: "src/a.ts", matches: [{ lineNumber: 3, line: "TODO x" }] }],
		truncated: false,
		total: 2,
	});
	assert.equal(Object.hasOwn(matchesMeta, "include"), false);
	assert.equal(searchResultSummary(grep, { mode: "content", totalMatchedLines: 2 }), "2 matches");

	const glob = classifyCursorSearch({ pattern: "", glob: "**/*.ts", outputMode: "files_with_matches" });
	const pathsMeta = searchMetaFromResult(glob, { mode: "glob", files: ["a.ts", "b.ts"], totalFiles: 2, truncated: false });
	assert.deepEqual(pathsMeta, { shape: "paths", paths: ["a.ts", "b.ts"], truncated: false, total: 2 });
	assert.equal(searchResultSummary(glob, { mode: "glob", files: ["a.ts", "b.ts"], totalFiles: 2 }), "2 files");

	const count = classifyCursorSearch({ pattern: "TODO", outputMode: "count" });
	const countMeta = searchMetaFromResult(count, {
		mode: "count",
		counts: [{ file: "a.ts", count: 3 }],
		totalFiles: 1,
		totalMatches: 3,
		truncated: false,
	});
	assert.deepEqual(countMeta, { shape: "paths", paths: ["a.ts"], truncated: false, total: 1 });
	assert.equal(searchResultSummary(count, { mode: "count", totalFiles: 1, totalMatches: 3 }), "3 matches in 1 file");

	assert.equal(searchMetaFromResult(grep, { error: "failed" }), undefined);
	assert.equal(searchResultSummary(grep, { error: "failed" }), "failed");
});

test("runCursorSearch: live rg against a temp tree", async () => {
	const root = mkdtempSync(join(tmpdir(), "cursor-search-"));
	try {
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "a.ts"), "const TODO = 1;\nconst ok = 2;\n");
		writeFileSync(join(root, "src", "b.js"), "const TODO = 2;\n");
		writeFileSync(join(root, "readme.md"), "no hit\n");

		const content = await runCursorSearch(classifyCursorSearch({ pattern: "TODO", path: "src", glob: "*.ts" }), { cwd: root });
		assert.equal(content.mode, "content");
		assert.equal(content.totalMatchedLines, 1);
		assert.equal(content.matches[0].file.replaceAll("\\", "/"), "src/a.ts");
		assert.equal(content.matches[0].matches[0].lineNumber, 1);

		const files = await runCursorSearch(classifyCursorSearch({
			pattern: "TODO",
			path: "src",
			outputMode: "files_with_matches",
		}), { cwd: root });
		assert.equal(files.mode, "files_with_matches");
		assert.equal(files.totalFiles, 2);

		const glob = await runCursorSearch(classifyCursorSearch({
			pattern: "",
			glob: "*.ts",
			outputMode: "files_with_matches",
			path: "src",
		}), { cwd: root });
		assert.equal(glob.mode, "glob");
		assert.ok(glob.files.some((file) => file.replaceAll("\\", "/").endsWith("a.ts")));

		const none = await runCursorSearch(classifyCursorSearch({ pattern: "NO_SUCH_TOKEN_XYZ" }), { cwd: root });
		assert.equal(none.totalMatchedLines, 0);
		assert.equal(searchResultSummary(classifyCursorSearch({ pattern: "NO_SUCH_TOKEN_XYZ" }), none), "No matches found");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("translateNativeExec delete maps to delete with permission-denied mapping + file_size", () => {
	const del = translateNativeExec({ case: "deleteArgs", args: { path: "tmp/x", toolCallId: "c5" } });
	assert.equal(del.tool, "delete");
	assert.deepEqual(del.args, { file_path: "tmp/x" });
	assert.equal(del.field, 4);
	// The delete tool's render contract carries the pre-delete size.
	const successResult = fields(del.encode("Deleted tmp/x (42 bytes)", false));
	assert.equal(successResult.length, 1);
	assert.equal(successResult[0][0], 1); // DeleteResult.success
	const success = fields(new Uint8Array(successResult[0][2]));
	assert.deepEqual(success, [
		[1, "b", bytes("tmp/x")],
		[2, "b", bytes("tmp/x")],
		[3, "v", 42], // file_size
	]);
	// A render without the size suffix simply omits file_size.
	const bare = fields(del.encode("Deleted tmp/x", false));
	assert.deepEqual(fields(new Uint8Array(bare[0][2])), [
		[1, "b", bytes("tmp/x")],
		[2, "b", bytes("tmp/x")],
	]);
	// Escalation denial → DeleteResult.permission_denied (4).
	const denied = fields(del.encode('Error: cannot delete "/x/tmp/x": permission denied (no approval channel is available)', true));
	assert.equal(denied[0][0], 4);
	const deniedInner = fields(new Uint8Array(denied[0][2]));
	assert.deepEqual(deniedInner[0], [1, "b", bytes("tmp/x")]);
	// Other errors stay the generic error variant.
	const errorResult = fields(del.encode("denied", true));
	assert.equal(errorResult.length, 1);
	assert.equal(errorResult[0][0], 7); // DeleteResult.error
	const error = fields(new Uint8Array(errorResult[0][2]));
	assert.deepEqual(error, [
		[1, "b", bytes("tmp/x")],
		[2, "b", bytes("denied")],
	]);
});

test("encodeDeleteSuccess/encodeDeleteError carry the DeleteResult wrapper", () => {
	const successResult = fields(encodeDeleteSuccess({ path: "x", deletedFile: "x" }));
	assert.equal(successResult.length, 1);
	assert.equal(successResult[0][0], 1); // success
	assert.deepEqual(fields(new Uint8Array(successResult[0][2])), [
		[1, "b", bytes("x")],
		[2, "b", bytes("x")],
	]);
	const errorResult = fields(encodeDeleteError({ path: "x", error: "busy" }));
	assert.equal(errorResult.length, 1);
	assert.equal(errorResult[0][0], 7); // error
	assert.deepEqual(fields(new Uint8Array(errorResult[0][2])), [
		[1, "b", bytes("x")],
		[2, "b", bytes("busy")],
	]);
});

test("ShellStream frame encoders carry the event oneof (stdout=1/stderr=2/exit=3/start=4)", () => {
	const start = fields(encodeShellStreamStart());
	assert.equal(start.length, 1);
	assert.equal(start[0][0], 4); // start (empty ShellStreamStart)

	const stdout = fields(encodeShellStreamStdout("hi"));
	assert.equal(stdout[0][0], 1); // stdout event
	assert.deepEqual(fields(new Uint8Array(stdout[0][2])), [[1, "b", bytes("hi")]]); // ShellStreamStdout{data=1}
	const stderr = fields(encodeShellStreamStderr("oops"));
	assert.equal(stderr[0][0], 2); // stderr event
	assert.deepEqual(fields(new Uint8Array(stderr[0][2])), [[1, "b", bytes("oops")]]);
	const exit = fields(encodeShellStreamExit({ code: 2, cwd: "/x", aborted: true }));
	assert.equal(exit.length, 1);
	assert.equal(exit[0][0], 3); // exit
	const exitInner = fields(new Uint8Array(exit[0][2]));
	assert.deepEqual(exitInner, [
		[1, "v", 2], // code
		[2, "b", bytes("/x")], // cwd
		[4, "v", 1], // aborted
	]);

	const located = fields(encodeShellStreamExit({
		code: 0,
		cwd: "/x",
		outputLocation: { filePath: "/tmp/t/7.txt", sizeBytes: 128, lineCount: 12 },
	}));
	const locatedInner = fields(new Uint8Array(located[0][2]));
	assert.equal(locatedInner[2][0], 3); // output_location
	assert.deepEqual(fields(new Uint8Array(locatedInner[2][2])), [
		[1, "b", bytes("/tmp/t/7.txt")],
		[2, "v", 128],
		[3, "v", 12],
	]);
});

test("ShellResult encoders: success/failure/timeout/spawn_error/permission_denied + terminals_folder(103)", () => {
	const success = fields(encodeShellSuccess({
		command: "ls",
		workingDirectory: "/x",
		exitCode: 0,
		stdout: "a",
		stderr: "",
		executionTime: 12,
		terminalsFolder: "/tmp/t",
		isBackground: true,
		pid: 99,
	}));
	assert.equal(success[0][0], 1); // success
	const successInner = fields(new Uint8Array(success[0][2]));
	assert.deepEqual(successInner.slice(0, 3), [
		[1, "b", bytes("ls")],
		[2, "b", bytes("/x")],
		[3, "v", 0],
	]);
	const byField = new Map(success.map(([field, type, value]) => [field, { type, value }]));
	assert.equal(byField.get(102).value, 1); // is_background
	assert.deepEqual(byField.get(103).value, bytes("/tmp/t")); // terminals_folder
	assert.equal(byField.get(104).value, 99); // pid

	const failure = fields(encodeShellFailure({ command: "x", workingDirectory: "/x", exitCode: 1, stdout: "", stderr: "e", executionTime: 3, aborted: true }));
	assert.equal(failure[0][0], 2); // failure
	const failureInner = fields(new Uint8Array(failure[0][2]));
	assert.equal(failureInner.filter(([field]) => field === 11).length, 1); // aborted

	const timeout = fields(encodeShellTimeout({ command: "x", workingDirectory: "/x", timeoutMs: 5000 }));
	assert.equal(timeout[0][0], 3); // timeout

	const spawn = fields(encodeShellSpawnError({ command: "x", workingDirectory: "/x", error: "no" }));
	assert.equal(spawn[0][0], 5); // spawn_error

	const denied = fields(encodeShellPermissionDenied({ command: "x", workingDirectory: "/x", error: "denied", isReadonly: true }));
	assert.equal(denied[0][0], 7); // permission_denied
	const deniedInner = fields(new Uint8Array(denied[0][2]));
	assert.deepEqual(deniedInner, [
		[1, "b", bytes("x")],
		[2, "b", bytes("/x")],
		[3, "b", bytes("denied")],
		[4, "v", 1],
	]);
});

test("BackgroundShellSpawn + WriteShellStdin encoders", () => {
	const spawn = fields(encodeBackgroundShellSpawnSuccess({ shellId: 7, command: "serve", workingDirectory: "/x", pid: 42 }));
	assert.equal(spawn[0][0], 1); // success
	const spawnInner = fields(new Uint8Array(spawn[0][2]));
	assert.deepEqual(spawnInner, [
		[1, "v", 7],
		[2, "b", bytes("serve")],
		[3, "b", bytes("/x")],
		[4, "v", 42],
	]);

	const spawnError = fields(encodeBackgroundShellSpawnError({ command: "x", workingDirectory: "/x", error: "limit" }));
	assert.equal(spawnError[0][0], 2); // error

	const stdin = fields(encodeWriteShellStdinSuccess({ shellId: 3, terminalFileLengthBeforeInputWritten: 128 }));
	assert.equal(stdin[0][0], 1); // success
	assert.deepEqual(fields(new Uint8Array(stdin[0][2])), [
		[1, "v", 3],
		[2, "v", 128],
	]);
	const stdinError = fields(encodeWriteShellStdinError("unknown"));
	assert.equal(stdinError[0][0], 2); // error
});

test("shell arg decoders: ShellArgs/BackgroundShellSpawnArgs/WriteShellStdinArgs", () => {
	const writer = new Writer();
	writer.string(1, "ls -la");
	writer.string(2, "/work");
	writer.varint(3, 30);
	writer.string(4, "call-1");
	// requested_sandbox_policy (9) + skip_approval (12) — the model's
	// escalation channel: type 1 = INSECURE_NONE (no sandbox).
	writer.message(9, new Writer().varint(1, 1).varint(2, 1).string(3, "/extra").finish());
	writer.varint(12, 1);
	const shell = decodeShellArgs(writer.finish());
	assert.deepEqual(shell, {
		command: "ls -la",
		workingDirectory: "/work",
		timeout: 30,
		toolCallId: "call-1",
		skipApproval: true,
		sandboxPolicy: { type: 1, networkAccess: true, additionalReadwritePaths: ["/extra"] },
		isBackground: false,
		timeoutBehavior: 0,
		hardTimeout: undefined,
		description: undefined,
	});

	const withTitle = new Writer();
	withTitle.string(1, "sleep 5");
	withTitle.string(15, "wait a bit");
	assert.equal(decodeShellArgs(withTitle.finish()).description, "wait a bit");

	const bg = new Writer();
	bg.string(1, "npm run dev");
	bg.string(2, "/work");
	bg.string(3, "call-2");
	bg.varint(6, 1);
	const spawnArgs = decodeBackgroundShellSpawnArgs(bg.finish());
	assert.deepEqual(spawnArgs, { command: "npm run dev", workingDirectory: "/work", toolCallId: "call-2", enableWriteShellStdinTool: true, sandboxPolicy: undefined });

	const stdin = new Writer();
	stdin.varint(1, 5);
	stdin.string(2, "hello\n");
	const stdinArgs = decodeWriteShellStdinArgs(stdin.finish());
	assert.deepEqual(stdinArgs, { shellId: 5, chars: "hello\n" });
});

test("encodeWritePermissionDenied/encodeDeletePermissionDenied carry the oneof variants", () => {
	const write = fields(encodeWritePermissionDenied({ path: "x", error: "denied" }));
	assert.equal(write[0][0], 3); // WriteResult.permission_denied
	assert.deepEqual(fields(new Uint8Array(write[0][2]))[0], [1, "b", bytes("x")]);
	const del = fields(encodeDeletePermissionDenied({ path: "x", error: "denied" }));
	assert.equal(del[0][0], 4); // DeleteResult.permission_denied
	const inner = fields(new Uint8Array(del[0][2]));
	assert.deepEqual(inner[0], [1, "b", bytes("x")]);
	assert.deepEqual(inner[1], [2, "b", bytes("denied")]);
});

test("encodeInteractionResponseEnvelope wraps field 6", () => {
	const envelope = fields(encodeInteractionResponseEnvelope(new Uint8Array([9])));
	assert.equal(envelope[0][0], 6);
	assert.deepEqual(envelope[0][2], [9]);
});

test("encodeAskQuestionSuccess/Result shapes", () => {
	const success = fields(encodeAskQuestionSuccess([
		{ questionId: "q1", selectedOptionIds: ["o1", "o2"], freeformText: "extra" },
		{ questionId: "q2", selectedOptionIds: [] },
	]));
	// AskQuestionSuccess { answers=1 repeated } — two entries.
	assert.equal(success.length, 2);
	assert.equal(success[0][0], 1);
	const answer = fields(success[0][2]);
	assert.deepEqual(answer, [
		[1, "b", bytes("q1")],
		[2, "b", bytes("o1")],
		[2, "b", bytes("o2")],
		[3, "b", bytes("extra")],
	]);

	const result = fields(encodeAskQuestionResultSuccess([{ questionId: "q", selectedOptionIds: [] }]));
	assert.equal(result[0][0], 1);
	const error = fields(encodeAskQuestionResultError("bad"));
	assert.equal(error[0][0], 2);
	assert.deepEqual(fields(error[0][2]), [[1, "b", bytes("bad")]]);
});

test("encodeAskQuestionInteractionResponse wraps id + field 3", () => {
	const encoded = encodeAskQuestionInteractionResponse({ id: 42, resultBytes: encodeAskQuestionResultError("no") });
	const outer = fields(encoded);
	assert.deepEqual(outer[0], [1, "v", 42]);
	// Field 3 payload: AskQuestionInteractionResponse { result=1 AskQuestionResult }
	const expectedInner = new Writer().message(1, encodeAskQuestionResultError("no")).finish();
	assert.deepEqual(outer[1], [3, "b", Array.from(expectedInner)]);
});

test("buildAskQuestionResultBytes reverse-maps labels to option ids, keeps freeform", () => {
	const questions = [
		{ id: "q1", prompt: "Pick", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }], allowMultiple: true },
		{ id: "q2", prompt: "Type", options: [] },
	];
	const result = { isError: false, content: JSON.stringify({ answers: [
		{ id: "q1", selected: ["Beta", "Alpha"] },
		{ id: "q2", selected: [], custom: "typed text" },
	] }) };
	const encoded = buildAskQuestionResultBytes(questions, result);
	const outer = fields(encoded);
	assert.equal(outer[0][0], 1); // success
	const success = fields(outer[0][2]);
	assert.equal(success.length, 2);
	const first = fields(success[0][2]);
	assert.deepEqual(first, [
		[1, "b", bytes("q1")],
		[2, "b", bytes("b")],
		[2, "b", bytes("a")],
	]);
	const second = fields(success[1][2]);
	assert.deepEqual(second, [
		[1, "b", bytes("q2")],
		[3, "b", bytes("typed text")],
	]);

	// Missing / error results produce the AskQuestionResult error variant.
	assert.equal(fields(buildAskQuestionResultBytes(questions, undefined))[0][0], 2);
	assert.equal(fields(buildAskQuestionResultBytes(questions, { isError: true, content: "denied" }))[0][0], 2);
	assert.equal(fields(buildAskQuestionResultBytes(questions, { isError: false, content: "not json" }))[0][0], 2);
});

test("encodeInteractionApproved/Rejected shapes", () => {
	const approved = fields(encodeInteractionApproved(9, 9));
	assert.equal(approved.length, 2);
	assert.deepEqual(approved[0], [1, "v", 9]);
	// Field 9 payload: WebFetchRequestResponse { approved=1 {} } = [10, 0]
	assert.deepEqual(approved[1], [9, "b", [10, 0]]);
	const inner = fields(new Uint8Array(approved[1][2]));
	assert.equal(inner.length, 1);
	assert.deepEqual(inner[0], [1, "b", []]);

	const rejected = fields(encodeInteractionRejected(3, 4, INTERACTION_UNAVAILABLE));
	assert.equal(rejected[0][0], 1);
	assert.equal(rejected[0][2], 3);
	assert.equal(rejected[1][0], 4);
	// Field 4 payload: { rejected=2 { reason=1 INTERACTION_UNAVAILABLE } }
	const rejectedInner = fields(new Uint8Array(rejected[1][2]));
	const reason = bytes(INTERACTION_UNAVAILABLE);
	assert.deepEqual(rejectedInner, [[2, "b", [10, reason.length, ...reason]]]);
});

test("rejectionForInteraction maps every handled query kind to its response field", () => {
	const cases = {
		switchModeRequestQuery: 4,
		createPlanRequestQuery: 7,
		prManagementRequestQuery: 10,
		mcpAuthRequestQuery: 11,
		generateImageRequestQuery: 12,
		replaceEnvArgs: 13,
		connectScmRequestQuery: 14,
	};
	for (const [kind, field] of Object.entries(cases)) {
		const reply = rejectionForInteraction({ id: 5, case: kind });
		assert.equal(reply.field, field, kind);
		const outer = fields(reply.payload);
		assert.equal(outer[0][0], 1);
		assert.equal(outer[0][2], 5);
		assert.equal(outer[1][0], field);
	}
	// No rejection variant exists for VM setup; today's hang behavior.
	assert.equal(rejectionForInteraction({ id: 1, case: "setupVmEnvironmentArgs" }), undefined);
	assert.equal(rejectionForInteraction({ id: 1, case: "unknown" }), undefined);
});

test("decodeInteractionQuery routes every oneof field", () => {
	const ask = new Writer();
	ask.varint(1, 77);
	const askArgs = new Writer();
	askArgs.string(1, "Title");
	const question = new Writer();
	question.string(1, "q1");
	question.string(2, "Pick one");
	question.message(3, new Writer().string(1, "o1").string(2, "One").finish());
	askArgs.message(2, question.finish());
	ask.message(3, new Writer().message(1, askArgs.finish()).string(2, "tc-1").finish());
	const askQuery = decodeInteractionQuery(ask.finish());
	assert.equal(askQuery.id, 77);
	assert.equal(askQuery.case, "askQuestionInteractionQuery");
	assert.equal(askQuery.value.toolCallId, "tc-1");
	assert.equal(askQuery.value.args.title, "Title");
	assert.deepEqual(askQuery.value.args.questions, [{
		id: "q1",
		prompt: "Pick one",
		options: [{ id: "o1", label: "One" }],
		allowMultiple: false,
	}]);

	const search = new Writer();
	search.varint(1, 8);
	search.message(2, new Uint8Array(0));
	const searchQuery = decodeInteractionQuery(search.finish());
	assert.equal(searchQuery.case, "webSearchRequestQuery");

	const fetch = new Writer();
	fetch.varint(1, 9);
	fetch.message(9, new Uint8Array(0));
	assert.equal(decodeInteractionQuery(fetch.finish()).case, "webFetchRequestQuery");

	const switchMode = new Writer();
	switchMode.varint(1, 10);
	switchMode.message(4, new Uint8Array(0));
	assert.equal(decodeInteractionQuery(switchMode.finish()).case, "switchModeRequestQuery");
});

test("decodeAskQuestionInteractionQuery handles multiple options and allow_multiple", () => {
	const question = new Writer();
	question.string(1, "q1");
	question.string(2, "Pick");
	question.message(3, new Writer().string(1, "a").string(2, "Alpha").finish());
	question.message(3, new Writer().string(1, "b").string(2, "Beta").finish());
	question.varint(4, 1);
	const args = new Writer();
	args.string(1, "Choose");
	args.message(2, question.finish());
	const query = new Writer();
	query.message(1, args.finish());
	query.string(2, "tc-9");
	const decoded = decodeAskQuestionInteractionQuery(query.finish());
	assert.equal(decoded.args.title, "Choose");
	assert.deepEqual(decoded.args.questions, [{
		id: "q1",
		prompt: "Pick",
		options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }],
		allowMultiple: true,
	}]);
});

test("normalizeCursorTodos maps statuses and drops unknown/cancelled", () => {
	const todos = normalizeCursorTodos([
		{ id: "1", content: "do a", status: "PENDING" },
		{ id: "2", content: "do b", status: 2 },
		{ id: "3", content: "done c", status: "completed" },
		{ id: "4", content: "gone", status: "CANCELLED" },
		{ id: "5", content: "unknown", status: 0 },
		{ id: "6", content: "", status: "pending" },
		{ id: "7", content: "odd", status: "weird" },
		"not-an-object",
	]);
	assert.deepEqual(todos, [
		{ content: "do a", status: "pending" },
		{ content: "do b", status: "in_progress" },
		{ content: "done c", status: "completed" },
	]);
});

test("decodeConversationStateTodos distinguishes absent from empty and parses JSON", () => {
	const empty = decodeConversationStateTodos(new Writer().string(1, "{}").finish());
	assert.equal(empty.present, false);
	assert.deepEqual(empty.items, []);

	const writer = new Writer();
	writer.string(1, "x");
	writer.bytes(3, new TextEncoder().encode(JSON.stringify({ id: "1", content: "a", status: 1 })));
	writer.bytes(3, new TextEncoder().encode(JSON.stringify({ content: "b", status: "in_progress" })));
	writer.bytes(3, bytes("not json"));
	const decoded = decodeConversationStateTodos(writer.finish());
	assert.equal(decoded.present, true);
	assert.deepEqual(decoded.items, [
		{ id: "1", content: "a", status: 1 },
		{ content: "b", status: "in_progress" },
	]);
});

test("encodeReadFileNotFound carries ReadResult { file_not_found=4 ReadFileNotFound{path=1} }", () => {
	const result = fields(encodeReadFileNotFound({ path: "new.txt" }));
	assert.equal(result.length, 1);
	assert.equal(result[0][0], 4); // file_not_found
	const inner = fields(new Uint8Array(result[0][2]));
	assert.deepEqual(inner, [[1, "b", bytes("new.txt")]]);
});

test("translateNativeExec read maps DSH not-found to file_not_found, keeps other errors", () => {
	const read = translateNativeExec({ case: "readArgs", args: { path: "dsh-permission-test.txt", toolCallId: "call-1" } });
	// The exact DSH tool error text: read-target.ts throws
	// FsError(`cannot read "${path}": not found`, "FS_NOT_FOUND"), flattened
	// into the tool-result text with an "Error: " prefix.
	const notFound = fields(read.encode('Error: cannot read "/root/x/dsh-permission-test.txt": not found', true));
	assert.equal(notFound.length, 1);
	assert.equal(notFound[0][0], 4); // ReadResult.file_not_found
	const notFoundInner = fields(new Uint8Array(notFound[0][2]));
	assert.deepEqual(notFoundInner, [[1, "b", bytes("dsh-permission-test.txt")]]);

	// Any other failure stays the generic error variant.
	const generic = fields(read.encode("Error: permission denied", true));
	assert.equal(generic.length, 1);
	assert.equal(generic[0][0], 2); // ReadResult.error
});

test("allocateLocalToolCallId sanitizes the embedded newline and de-duplicates shared ids", () => {
	const used = new Set();
	const first = allocateLocalToolCallId("call-47208213-12ad-4455-93f5-212ff36f6a9f-10\nfc_ozLGNmW-3LYxF7-a3764b83fc74d090_0", used);
	assert.equal(first, "call-47208213-12ad-4455-93f5-212ff36f6a9f-10-fc_ozLGNmW-3LYxF7-a3764b83fc74d090_0");
	// The StrReplace probe read and its write share ONE wire toolCallId; the
	// second allocation must not collide with the first.
	const second = allocateLocalToolCallId("call-47208213-12ad-4455-93f5-212ff36f6a9f-10\nfc_ozLGNmW-3LYxF7-a3764b83fc74d090_0", used);
	assert.equal(second, "call-47208213-12ad-4455-93f5-212ff36f6a9f-10-fc_ozLGNmW-3LYxF7-a3764b83fc74d090_0-2");
	assert.equal(allocateLocalToolCallId("call-x", used), "call-x");
	// The set survives across stream() calls via the live bridge; a fresh
	// set (cold start) starts from a bare id again.
	assert.equal(allocateLocalToolCallId("call-x", new Set()), "call-x");
	// Empty/undefined input falls back to a random UUID.
	const uuid = allocateLocalToolCallId(undefined, used);
	assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("decodeExecServerMessage carries decoded shell frame args", () => {
	const stream = new Writer();
	stream.varint(1, 3);
	stream.string(15, "exec-s");
	stream.message(14, new Writer().string(1, "ls -la").string(2, "").varint(3, 30).finish());
	const shell = decodeExecServerMessage(stream.finish());
	assert.equal(shell.case, "shellStreamArgs");
	assert.deepEqual(shell.args, { command: "ls -la", workingDirectory: "", timeout: 30, toolCallId: "", skipApproval: false, sandboxPolicy: undefined, isBackground: false, timeoutBehavior: 0, hardTimeout: undefined, description: undefined });

	const spawn = new Writer();
	spawn.varint(1, 4);
	spawn.message(16, new Writer().string(1, "npm run dev").string(2, "/w").varint(6, 1).finish());
	const bg = decodeExecServerMessage(spawn.finish());
	assert.equal(bg.case, "backgroundShellSpawnArgs");
	assert.deepEqual(bg.args, { command: "npm run dev", workingDirectory: "/w", toolCallId: "", enableWriteShellStdinTool: true, sandboxPolicy: undefined });

	const stdin = new Writer();
	stdin.varint(1, 5);
	stdin.message(23, new Writer().varint(1, 9).string(2, "y\n").finish());
	const write = decodeExecServerMessage(stdin.finish());
	assert.equal(write.case, "writeShellStdinArgs");
	assert.deepEqual(write.args, { shellId: 9, chars: "y\n" });
});

test("splitShellDelta separates stdout from the [stderr] marker sections", () => {
	assert.deepEqual(splitShellDelta("out1\n"), { stdout: "out1\n", stderr: "" });
	assert.deepEqual(splitShellDelta("out1\nerr1\n[stderr]\nerr2\n"), { stdout: "out1\nerr1", stderr: "err2\n" });
	assert.deepEqual(splitShellDelta("out\na\n[stderr]\ne1\n\n[stderr]\ne2"), { stdout: "out\na", stderr: "e1\n\n[stderr]\ne2" });
	assert.deepEqual(splitShellDelta(undefined), { stdout: "", stderr: "" });
});

test("isCursorNativeTool excludes the bash backend from injection", () => {
	assert.equal(isCursorNativeTool("bash"), true);
});

test("cursorSandboxTypeToMode maps the Cursor SandboxPolicy.Type enum", () => {
	assert.equal(cursorSandboxTypeToMode({ type: 1 }), "danger-full-access"); // INSECURE_NONE
	assert.equal(cursorSandboxTypeToMode({ type: 2 }), "workspace-write"); // WORKSPACE_READWRITE
	assert.equal(cursorSandboxTypeToMode({ type: 3 }), "read-only"); // WORKSPACE_READONLY
	assert.equal(cursorSandboxTypeToMode({ type: 0 }), undefined); // UNSPECIFIED
	assert.equal(cursorSandboxTypeToMode(undefined), undefined);
	// Extra read-write paths beyond the workspace imply full access.
	assert.equal(cursorSandboxTypeToMode({ type: 2, additionalReadwritePaths: ["/extra"] }), "danger-full-access");
});

test("encodeShellStreamStart echoes the requested sandbox policy type", () => {
	const typed = fields(encodeShellStreamStart(1));
	assert.equal(typed[0][0], 4); // start
	const inner = fields(new Uint8Array(typed[0][2]));
	assert.equal(inner.length, 1);
	assert.equal(inner[0][0], 1); // sandbox_policy
	const policy = fields(new Uint8Array(inner[0][2]));
	assert.deepEqual(policy, [[1, "v", 1]]); // type
	const bare = fields(encodeShellStreamStart(undefined));
	assert.equal(bare[0][0], 4);
	assert.deepEqual(fields(new Uint8Array(bare[0][2])), []);
});

test("encodeShellStreamBackgrounded carries shell_id/command/cwd/pid/ms_to_wait/reason", () => {
	const bg = fields(encodeShellStreamBackgrounded({ shellId: 7, command: "serve", workingDirectory: "/x", pid: 4242, msToWait: 3000, reason: 1 }));
	assert.equal(bg[0][0], 7); // backgrounded event
	const inner = fields(new Uint8Array(bg[0][2]));
	assert.deepEqual(inner, [
		[1, "v", 7],
		[2, "b", bytes("serve")],
		[3, "b", bytes("/x")],
		[4, "v", 4242],
		[5, "v", 3000],
		[6, "v", 1],
	]);
	const withoutPid = fields(encodeShellStreamBackgrounded({ shellId: 7, command: "serve", workingDirectory: "/x" }));
	assert.deepEqual(fields(new Uint8Array(withoutPid[0][2])), [
		[1, "v", 7],
		[2, "b", bytes("serve")],
		[3, "b", bytes("/x")],
	]);
});

test("createPidProbe strips the NSpid marker line and parses the host pid", () => {
	const { consume } = createPidProbe();
	const first = consume("CURSOR_BG_PID=4242\nhello");
	assert.equal(first.pid, 4242);
	assert.equal(first.rest, "hello");
	const more = consume(" world");
	assert.equal(more.pid, undefined);
	assert.equal(more.rest, " world");
});

test("createPidProbe tolerates a marker split across chunks", () => {
	const { consume } = createPidProbe();
	assert.deepEqual(consume("CURSOR_BG_PI"), { pid: undefined, rest: "" });
	assert.deepEqual(consume("D=12"), { pid: undefined, rest: "" });
	const last = consume("34\noutput");
	assert.equal(last.pid, 1234);
	assert.equal(last.rest, "output");
});

test("createPidProbe passes non-marker output through and disables probing", () => {
	const { consume } = createPidProbe();
	const first = consume("normal output\n");
	assert.equal(first.pid, undefined);
	assert.equal(first.rest, "normal output\n");
	const second = consume("CURSOR_BG_PID=99\n");
	assert.equal(second.pid, undefined);
	assert.equal(second.rest, "CURSOR_BG_PID=99\n");
});

test("createPidProbe treats an empty awk substitution as resolved-without-pid", () => {
	const { consume } = createPidProbe();
	const result = consume("CURSOR_BG_PID=\ntail");
	assert.equal(result.pid, undefined);
	assert.equal(result.rest, "tail");
	assert.equal(consume("more").rest, "more");
});

test("parseJobIdN extracts the numeric suffix of a registry bash job id", () => {
	assert.equal(parseJobIdN("bash-7"), 7);
	assert.equal(parseJobIdN("bash-123"), 123);
	assert.equal(parseJobIdN("bash-"), undefined);
	assert.equal(parseJobIdN("subagent-3"), undefined);
	assert.equal(parseJobIdN(undefined), undefined);
});

test("encodeWriteRejected/encodeDeleteRejected carry path + reason", () => {
	const write = fields(encodeWriteRejected({ path: "x", reason: "user said no" }));
	assert.equal(write[0][0], 6);
	assert.deepEqual(fields(new Uint8Array(write[0][2])), [
		[1, "b", bytes("x")],
		[2, "b", bytes("user said no")],
	]);
	const del = fields(encodeDeleteRejected({ path: "x", reason: "user said no" }));
	assert.equal(del[0][0], 6);
});

test("decodeToolCallDisplay extracts update_todos / web_search / fetch display frames", () => {
	// ToolCallCompletedUpdate { call_id=1, tool_call=2 ToolCall{update_todos_tool_call=9} }
	const todoItem = new Writer().string(1, "t1").string(2, "do a").varint(3, 1).finish();
	const todoSuccess = new Writer().message(1, todoItem).varint(2, 1).finish(); // todos=1, total_count=2
	const updateResult = new Writer().message(1, todoSuccess).finish(); // success=1
	const updateCall = new Writer().message(2, updateResult).finish(); // result=2
	const updateTool = new Writer().message(9, updateCall).finish();
	const updateFrame = new Writer().string(1, "call-9").message(2, updateTool).finish();
	const update = decodeToolCallDisplay(updateFrame);
	assert.equal(update.displayKind, "update_todos");
	assert.deepEqual(update.call.todos, [{ id: "t1", content: "do a", status: 1 }]);
	assert.equal(update.call.totalCount, 1);

	// WebSearchToolCall=18 { args{search_term=1}, result{success{references=[{title,url,chunk}]}} }
	const reference = new Writer().string(1, "T").string(2, "https://x").string(3, "snippet").finish();
	const searchSuccess = new Writer().message(1, reference).finish();
	const searchResult = new Writer().message(1, searchSuccess).finish();
	const searchArgs = new Writer().string(1, "deepseek").finish();
	const searchCall = new Writer().message(1, searchArgs).message(2, searchResult).finish();
	const searchFrame = new Writer().string(1, "call-18").message(2, new Writer().message(18, searchCall).finish()).finish();
	const search = decodeToolCallDisplay(searchFrame);
	assert.equal(search.displayKind, "web_search");
	assert.equal(search.call.searchTerm, "deepseek");
	assert.deepEqual(search.call.references, [{ title: "T", url: "https://x", chunk: "snippet" }]);

	// FetchToolCall=24 { args{url=1}, result{success{url,content,status_code}} }
	const fetchSuccess = new Writer().string(1, "https://x").string(2, "body").varint(3, 200).finish();
	const fetchResult = new Writer().message(1, fetchSuccess).finish();
	const fetchArgs = new Writer().string(1, "https://x").finish();
	const fetchCall = new Writer().message(1, fetchArgs).message(2, fetchResult).finish();
	const fetchFrame = new Writer().string(1, "call-24").message(2, new Writer().message(24, fetchCall).finish()).finish();
	const fetch = decodeToolCallDisplay(fetchFrame);
	assert.equal(fetch.displayKind, "web_fetch");
	assert.equal(fetch.call.url, "https://x");
	assert.equal(fetch.call.content, "body");
	assert.equal(fetch.call.statusCode, 200);

	// Unknown tool-call union case drops to undefined.
	const unknown = decodeToolCallDisplay(new Writer().string(1, "c").message(2, new Writer().message(19, new Uint8Array([0])).finish()).finish());
	assert.equal(unknown, undefined);
});

test("parseCursorWebSearchChunk recovers links + synthesis from the aggregated display chunk", () => {
	const chunk = "Links:\n1. [deepseek-ai/deepseek-harness](https://www.github.com/deepseek-ai/deepseek-harness)\n2. [Quickstart](https://deepseekdocs.com/en/docs/getting-started/quickstart)\n\nSynthesis:\nThe DeepSeek Harness web GUI is local-first.\n\nHighlights:\n<result id=\"1\">...</result>";
	const parsed = parseCursorWebSearchChunk(chunk);
	assert.deepEqual(parsed.links, [
		{ title: "deepseek-ai/deepseek-harness", url: "https://www.github.com/deepseek-ai/deepseek-harness" },
		{ title: "Quickstart", url: "https://deepseekdocs.com/en/docs/getting-started/quickstart" },
	]);
	assert.equal(parsed.synthesis, "The DeepSeek Harness web GUI is local-first.");
	assert.equal(parseCursorWebSearchChunk("no links section"), undefined);
});

test("Cursor terminal header matches ~/.cursor agent file metadata", () => {
	const header = formatCursorTerminalHeader({
		pid: 67657,
		cwd: "/root/projects/gateway",
		command: "chmod +x acc.sh",
		title: "Diagnose empty-store",
		status: "succeeded",
		startedAt: "2026-09-07T20:41:01.193Z",
		runningForMs: 50514,
	});
	assert.equal(header, [
		"---",
		"pid: 67657",
		"cwd: \"/root/projects/gateway\"",
		"command: \"chmod +x acc.sh\"",
		"title: \"Diagnose empty-store\"",
		"status: succeeded",
		"started_at: 2026-09-07T20:41:01.193Z",
		"running_for_ms: 50514    ",
		"---",
		"",
	].join("\n"));
	assert.match(header.split("\n")[7], /^running_for_ms: .{9}$/);

	const footer = formatCursorTerminalFooter({
		exitCode: 0,
		elapsedMs: 50360,
		endedAt: "2026-09-07T20:41:51.553Z",
	});
	assert.equal(footer, [
		"",
		"---",
		"exit_code: 0",
		"elapsed_ms: 50360",
		"ended_at: 2026-09-07T20:41:51.553Z",
		"---",
		"",
	].join("\n"));
});

test("createCursorTerminalLog writes header, body, then footer on settle", () => {
	const dir = mkdtempSync(join(tmpdir(), "cursor-term-"));
	const filePath = join(dir, "7.txt");
	try {
		const log = createCursorTerminalLog(filePath, {
			pid: -1,
			cwd: "/work",
			command: "echo hi",
			title: "say hi",
			startedAt: "2026-09-08T00:00:00.000Z",
			startedAtMs: Date.parse("2026-09-08T00:00:00.000Z"),
		});
		const opened = readFileSync(filePath, "utf8");
		assert.match(opened, /^---\n/);
		assert.match(opened, /\npid: -1\n/);
		assert.match(opened, /\nstatus: running\n/);
		assert.match(opened, /\nrunning_for_ms: 0        \n/);
		assert.ok(opened.endsWith("---\n"));

		log.setPid(4242);
		log.append("hello\n");
		log.finish({ exitCode: 0, now: Date.parse("2026-09-08T00:00:01.500Z") });
		const settled = readFileSync(filePath, "utf8");
		assert.match(settled, /\npid: 4242\n/);
		assert.match(settled, /\nstatus: succeeded\n/);
		assert.match(settled, /\nrunning_for_ms: 1500     \n/);
		assert.ok(settled.includes("hello\n"));
		assert.match(settled, /\n---\nexit_code: 0\nelapsed_ms: 1500\nended_at: 2026-09-08T00:00:01.500Z\n---\n$/);
		assert.equal(log.stats().filePath, filePath);
		assert.ok(log.stats().sizeBytes > 0);
		assert.ok(log.stats().lineCount >= 12);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("noteProbeRead / takeProbeRead pair a raw toolCallId", () => {
	const store = new Map();
	noteProbeRead(store, "call-1", { localId: "call-1", path: "a.ts", content: "old" });
	assert.equal(store.size, 1);
	assert.deepEqual(takeProbeRead(store, "call-1"), { localId: "call-1", path: "a.ts", content: "old" });
	assert.equal(store.size, 0);
	assert.equal(takeProbeRead(store, "call-1"), undefined);
	noteProbeRead(store, "", { path: "x" });
	assert.equal(store.size, 0);
});

test("execRead / execWrite / execDelete use the session fs+shell seams", async () => {
	const files = new Map([["notes.txt", "hello"]]);
	const world = {
		agent: { session: { header: { cwd: "/work" } } },
		fs: {
			resolve: async (path) => ({ displayPath: String(path) }),
			stat: async (target) => (files.has(target.displayPath) ? { type: "file", size: files.get(target.displayPath).length } : undefined),
			readText: async (target) => {
				if (!files.has(target.displayPath)) throw new Error(`cannot read "${target.displayPath}": not found`);
				return files.get(target.displayPath);
			},
			writeText: async (target, content) => {
				files.set(target.displayPath, String(content));
			},
		},
		shell: {
			resolve: (request) => request,
			run: async (request) => {
				const match = /rm -f -- '([^']+)'/.exec(request.command);
				if (match) files.delete(match[1]);
				return { exitCode: 0, stderr: { text: "" } };
			},
		},
	};
	const read = await execRead(world, { path: "notes.txt" });
	assert.equal(read.kind, "text");
	assert.equal(read.content, "hello");
	assert.equal(read.path, "notes.txt");
	const created = await execWrite(world, { path: "new.txt", content: "created" });
	assert.equal(created.operation, "create");
	assert.equal(files.get("new.txt"), "created");
	const updated = await execWrite(world, { path: "notes.txt", content: "bye" });
	assert.equal(updated.operation, "update");
	const deleted = await execDelete(world, { path: "notes.txt" });
	assert.equal(deleted.fileSize, 3);
	assert.equal(files.has("notes.txt"), false);
	await assert.rejects(() => execRead(world, { path: "notes.txt" }), /not found/);
});

test("runCursorSearch prefers the session subprocess seam", async () => {
	const seen = [];
	const subprocess = {
		spawn(request) {
			seen.push(request.argv);
			const text = request.argv.includes("--json")
				? `${JSON.stringify({ type: "match", data: { path: { text: "a.ts" }, lines: { text: "TODO\n" }, line_number: 1 } })}\n`
				: "a.ts\n";
			const stdout = { text, lossy: false, readFrom() { return { text, lossy: false }; } };
			const stderr = { text: "", readFrom() { return { text: "", lossy: false }; } };
			return {
				collected: { stdout, stderr },
				done: Promise.resolve({ exitCode: 0, signal: null }),
			};
		},
	};
	const content = await runCursorSearch(classifyCursorSearch({ pattern: "TODO" }), { cwd: "/work", subprocess });
	assert.equal(content.mode, "content");
	assert.equal(content.totalMatchedLines, 1);
	assert.equal(content.matches[0].file, "a.ts");
	assert.ok(seen[0][0].includes("rg") || seen[0][0].endsWith("rg") || seen[0][0].includes("ripgrep"));
	assert.equal(seen[0][1], "--no-config");
});

test("createStreamBlocks keeps one reasoning index until a tool batch", () => {
	const blocks = createStreamBlocks();
	const first = blocks.reasoning("a");
	const second = blocks.reasoning("b");
	assert.deepEqual(first, [
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 0, text: "a" },
	]);
	assert.deepEqual(second, [{ type: "reasoning-delta", index: 0, text: "b" }]);
	blocks.markWork();
	const third = blocks.reasoning("c");
	assert.deepEqual(third, [
		{ type: "block-start", index: 1, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 1, text: "c" },
	]);
});

test("createStreamBlocks splits text after tools and shares the index allocator with tool calls", () => {
	const blocks = createStreamBlocks();
	assert.equal(blocks.text("hi")[0].index, 0);
	blocks.markWork();
	assert.equal(blocks.toolCall(), 1);
	const next = blocks.text("after");
	assert.deepEqual(next, [
		{ type: "block-start", index: 2, blockType: "text" },
		{ type: "text-delta", index: 2, text: "after" },
	]);
});

test("createStreamBlocks does not let thinking after tools reuse the previous text lane", () => {
	const blocks = createStreamBlocks();
	assert.equal(blocks.reasoning("plan")[0].index, 0);
	assert.equal(blocks.text("narrate")[0].index, 1);
	blocks.markWork();
	assert.equal(blocks.reasoning("again")[0].index, 2);
	const answer = blocks.text("answer");
	assert.deepEqual(answer, [
		{ type: "block-start", index: 3, blockType: "text" },
		{ type: "text-delta", index: 3, text: "answer" },
	]);
	assert.equal(blocks.text(" more")[0].index, 3);
});

test("emitToolCall uses a fresh index after text/reasoning", () => {
	const blocks = createStreamBlocks();
	blocks.reasoning("plan");
	blocks.text("hi");
	const chunks = emitToolCall(blocks, { id: "c1", name: "grep", args: { pattern: "TODO" } });
	assert.equal(chunks[0].index, 2);
	assert.equal(chunks[1].name, "grep");
	assert.equal(chunks[2].block.arguments, JSON.stringify({ pattern: "TODO" }));
	assert.equal(blocks.text("after")[0].index, 3);
});

test("cursor joins settle once and await returns the same payload", async () => {
	resetCursorJoins();
	openCursorJoin("join-1");
	const pending = awaitCursorJoin("join-1");
	settleCursorJoin("join-1", { text: "2 matches", meta: { shape: "paths", paths: ["a.ts"], truncated: false, total: 1 } });
	settleCursorJoin("join-1", { text: "ignored" });
	const result = await pending;
	assert.equal(result.text, "2 matches");
	assert.equal(result.isError, false);
	assert.equal(result.meta.total, 1);
	await assert.rejects(() => awaitCursorJoin("join-1"), /no in-flight join/);
	resetCursorJoins();
});

test("readPresentationMeta numbers raw lines from 1", () => {
	assert.deepEqual(readPresentationMeta("a.ts", "one\ntwo\n"), {
		path: "a.ts",
		offset: 1,
		lines: [{ number: 1, text: "one" }, { number: 2, text: "two" }],
		totalLines: 2,
	});
	assert.deepEqual(readPresentationMeta("a.ts", "two\nthree", { offset: 2, totalLines: 6 }), {
		path: "a.ts",
		offset: 2,
		lines: [{ number: 2, text: "two" }, { number: 3, text: "three" }],
		totalLines: 6,
	});
});

test("displayJoinResult projects web_search meta and todo text", () => {
	const search = displayJoinResult({
		displayKind: "web_search",
		call: {
			references: [
				{ title: "Web search results", chunk: "Links:\n1. [Example](https://example.com)\n\nSynthesis:\nHello\n\nHighlights:\n<result></result>" },
			],
		},
	});
	assert.equal(search.isError, false);
	assert.deepEqual(search.meta.sources, [{ url: "https://example.com", title: "Example" }]);
	assert.equal(search.meta.answer, "Hello");
	const todos = displayJoinResult({
		displayKind: "update_todos",
		call: { todos: [{ content: "x", status: "pending" }] },
	});
	assert.match(todos.text, /1 pending/);
	assert.equal(todos.isError, false);
});

test("join shims render identity text and pass search/read meta through", async () => {
	resetCursorJoins();
	const shims = Object.fromEntries(cursorJoinShims().map((tool) => [tool.name, tool]));
	assert.equal(shims.read.isConcurrencySafe(), true);
	assert.equal(shims.grep.isConcurrencySafe(), true);
	assert.equal(shims.bash.isConcurrencySafe, undefined);
	openCursorJoin("grep-1");
	settleCursorJoin("grep-1", {
		text: "2 matches",
		meta: { shape: "matches", files: [{ path: "a.ts", matches: [{ lineNumber: 1, line: "TODO" }] }], truncated: false, total: 2 },
	});
	const value = await shims.grep.execute({}, { callId: "grep-1" });
	assert.deepEqual(shims.grep.output.render({}, value), [{ type: "text", text: "2 matches" }]);
	assert.deepEqual(searchViewFromMeta(shims.grep.output.presentationMeta({}, value)), {
		card: "search",
		shape: "matches",
		files: [{ path: "a.ts", matches: [{ lineNumber: 1, line: "TODO" }] }],
		truncated: false,
		total: 2,
	});
	resetCursorJoins();
});
