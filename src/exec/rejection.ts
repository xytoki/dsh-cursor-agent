import {
	encodeReadRejected,
	encodeLsRejected,
	encodeGrepError,
	encodeWriteRejected,
	encodeDeleteRejected,
	encodeShellRejectedResult,
	encodeShellStreamRejected,
	encodeBackgroundShellRejectedResult,
	encodeFetchError,
	encodeWriteShellStdinError,
	encodeDiagnosticsResult,
	encodeMcpError,
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

const TOOL_REJECT_REASON =
	"Tool not available in this environment. Use the MCP tools provided instead.";

export function rejectionFor(exec) {
	switch (exec.case) {
		case "readArgs":
			return { field: 7, payload: encodeReadRejected(exec.path, TOOL_REJECT_REASON) };
		case "lsArgs":
			return { field: 8, payload: encodeLsRejected(exec.path, TOOL_REJECT_REASON) };
		case "grepArgs":
			return { field: 5, payload: encodeGrepError(TOOL_REJECT_REASON) };
		case "writeArgs":
			return { field: 3, payload: encodeWriteRejected({ path: exec.path, reason: TOOL_REJECT_REASON }) };
		case "deleteArgs":
			return { field: 4, payload: encodeDeleteRejected({ path: exec.path, reason: TOOL_REJECT_REASON }) };
		case "shellArgs":
			// Non-streaming shell exec replies with ShellResult (field 2).
			return { field: 2, payload: encodeShellRejectedResult(undefined, undefined, TOOL_REJECT_REASON) };
		case "shellStreamArgs":
			// Streaming shell exec replies with ShellStream (field 14); a
			// ShellResult here leaves the server waiting for the stream.
			return { field: 14, payload: encodeShellStreamRejected(undefined, undefined, TOOL_REJECT_REASON) };
		case "backgroundShellSpawnArgs":
			return { field: 16, payload: encodeBackgroundShellRejectedResult(undefined, undefined, TOOL_REJECT_REASON) };
		case "fetchArgs":
			return { field: 20, payload: encodeFetchError(exec.url, TOOL_REJECT_REASON) };
		case "writeShellStdinArgs":
			return { field: 23, payload: encodeWriteShellStdinError(TOOL_REJECT_REASON) };
		case "diagnosticsArgs":
			return { field: 9, payload: encodeDiagnosticsResult() };
		case "recordScreenArgs":
			return { field: 21, payload: encodeMcpError("Screen recording is not available") };
		case "computerUseArgs":
			return { field: 22, payload: encodeMcpError("Computer use is not available") };
		case "listMcpResourcesExecArgs":
			return { field: 17, payload: encodeMcpError("MCP resources are not available") };
		case "readMcpResourceExecArgs":
			return { field: 18, payload: encodeMcpError("MCP resources are not available") };
		default:
			return undefined;
	}
}
