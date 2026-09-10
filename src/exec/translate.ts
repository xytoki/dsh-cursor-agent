import {
	EXEC_REPLY_FIELDS,
	WRITE_USER_REJECTED,
	WRITE_DENIED,
	DELETE_USER_REJECTED,
	DELETE_DENIED,
	SANDBOX_MODE_DENIED,
	composeReadWindow,
	encodeWritePermissionDenied,
	encodeDeletePermissionDenied,
	encodeDeleteSuccess,
	encodeDeleteError,
} from "./search";
import {
	encodeReadSuccess,
	encodeReadError,
	encodeReadFileNotFound,
	encodeReadInvalidFile,
	encodeWriteSuccess,
	encodeWriteError,
	encodeWriteRejected,
	encodeDeleteRejected,
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

export function translateNativeExec(exec) {
	switch (exec.case) {
		case "readArgs": {
			const args = exec.args ?? {};
			const path = args.path ?? "";
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			return {
				tool: "read",
				args: { file_path: path },
				field: EXEC_REPLY_FIELDS.readArgs,
				encode: (content, isError, extras : any = {}) => {
					if (isError) {
						// The server probes the target with a readArgs before every
						// writeArgs (StrReplace flow, same toolCallId). A missing
						// file must answer file_not_found — answering the generic
						// error variant makes the model give up on creating files.
						const text = String(content ?? "");
						if (/^(?:Error: )?cannot read ".*": not found$/.test(text)) {
							return encodeReadFileNotFound({ path });
						}
						if (extras.invalidFile === true || /not supported by the read executor/.test(text)) {
							return encodeReadInvalidFile({ path, reason: extras.reason ?? text });
						}
						return encodeReadError({ path, error: text });
					}
					if (extras.data instanceof Uint8Array) {
						return encodeReadSuccess({
							path,
							data: extras.data,
							totalLines: 0,
							fileSize: Number.isSafeInteger(extras.fileSize) ? extras.fileSize : extras.data.length,
							truncated: false,
							rangeApplied: false,
						});
					}
					// LocalReadExecutor: raw file + oK8 range + 8 MiB cap, no footer.
					const window = composeReadWindow(content, { offset, limit });
					return encodeReadSuccess({
						path,
						content: window.content,
						totalLines: window.totalLines,
						fileSize: Number.isSafeInteger(extras.fileSize) ? extras.fileSize : 0,
						truncated: window.truncated,
						rangeApplied: window.rangeApplied,
					});
				},
			};
		}
		case "writeArgs": {
			const args = exec.args ?? {};
			const path = args.path ?? "";
			if (args.fileBytes !== undefined && args.fileBytes.length > 0) {
				return {
					field: EXEC_REPLY_FIELDS.writeArgs,
					reject: encodeWriteError({ path, error: "binary file writes (file_bytes) are not supported" }),
				};
			}
			const content = args.fileText ?? "";
			return {
				tool: "write",
				args: { file_path: path, content },
				field: EXEC_REPLY_FIELDS.writeArgs,
				encode: (result, isError) => {
					if (isError) {
						const text = String(result ?? "");
						if (WRITE_USER_REJECTED.test(text)) return encodeWriteRejected({ path, reason: text });
						if (WRITE_DENIED.test(text) || SANDBOX_MODE_DENIED.test(text)) return encodeWritePermissionDenied({ path, error: text });
						return encodeWriteError({ path, error: text });
					}
					return encodeWriteSuccess({ path, content, returnFileContentAfterWrite: args.returnFileContentAfterWrite === true });
				},
			};
		}
		case "deleteArgs": {
			const args = exec.args ?? {};
			const path = args.path ?? "";
			return {
				tool: "delete",
				args: { file_path: path },
				field: EXEC_REPLY_FIELDS.deleteArgs,
				encode: (content, isError) => {
					if (isError) {
						const text = String(content ?? "");
						if (DELETE_USER_REJECTED.test(text)) return encodeDeleteRejected({ path, reason: text });
						if (DELETE_DENIED.test(text) || SANDBOX_MODE_DENIED.test(text)) return encodeDeletePermissionDenied({ path, error: text });
						return encodeDeleteError({ path, error: text });
					}
					// The delete tool's own render contract carries the pre-delete
					// size: "Deleted <path> (<N> bytes)" → DeleteSuccess.file_size.
					const sizeMatch = / \((\d+) bytes\)$/.exec(String(content ?? ""));
					const fileSize = sizeMatch === null ? undefined : Number(sizeMatch[1]);
					return encodeDeleteSuccess({ path, deletedFile: path, fileSize });
				},
			};
		}
		default:
			return undefined;
	}
}
