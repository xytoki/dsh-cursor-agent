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
import { DSH_SESSION_TITLE_FRAME_PREFIX } from "../constants";
import {
	AgentConversationTurnStructure,
	AssistantMessage,
	ConversationAction,
	ConversationStateStructure,
	ConversationStep,
	ConversationTurnStructure,
	InjectContextAction,
	InteractionQuery,
	InteractionUpdate,
	ModelDetails2,
	ResumeAction,
	SystemContextInjection,
	UserContextInjection,
	UserMessage,
	UserMessageAction,
} from "#generated/agent/v1/agent_pb.js";
import { SelectedContext } from "#generated/agent/v1/selected_context_pb.js";
import {
	AgentClientMessage,
	ClientHeartbeat,
	GetUsableModelsResponse,
	NameAgentRequest,
	NameAgentResponse,
} from "#generated/agent/v1/agent_service_pb.js";
import { ExecServerMessage } from "#generated/agent/v1/exec_pb.js";
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

//#region protobuf message builders (agent.v1 subset)
const textEncoder = new TextEncoder();

function bytesOf(value) {
	return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function optionalString(value) {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function encodeUserMessage({ text, messageId, images = [] }: any) {
	const data: any = {};
	if (typeof text === "string" && text.length > 0) data.text = text;
	if (typeof messageId === "string" && messageId.length > 0) data.messageId = messageId;
	if (images.length > 0) data.selectedContext = SelectedContext.fromBinary(encodeSelectedContext(images));
	return new UserMessage(data).toBinary();
}

export function encodeAssistantMessage(text) {
	return new AssistantMessage({ text }).toBinary();
}

/** ConversationStep { assistant_message = 1 } */
export function encodeAssistantStep(text) {
	return new ConversationStep({
		message: { case: "assistantMessage", value: new AssistantMessage({ text }) },
	}).toBinary();
}

/** AgentConversationTurnStructure { user_message = 1, steps = 2 } */
export function encodeAgentTurn(userBytes, stepBytes) {
	return new AgentConversationTurnStructure({
		...(userBytes.length > 0 ? { userMessage: userBytes } : {}),
		steps: stepBytes,
	}).toBinary();
}

/** ConversationTurnStructure { agent_conversation_turn = 1 } */
export function encodeTurnStructure(turnBytes) {
	return new ConversationTurnStructure({
		turn: { case: "agentConversationTurn", value: AgentConversationTurnStructure.fromBinary(turnBytes) },
	}).toBinary();
}

/** ModelDetails { model_id = 1, display_model_id = 3, display_name = 4 } */
export function encodeModelDetails(modelId) {
	return new ModelDetails2({
		modelId,
		displayModelId: modelId,
		displayName: modelId,
	}).toBinary();
}

/** ConversationAction { user_message_action = 1 } → UserMessageAction { user_message = 1 } */
export function encodeUserMessageAction(userBytes) {
	return new ConversationAction({
		action: {
			case: "userMessageAction",
			value: new UserMessageAction({ userMessage: UserMessage.fromBinary(userBytes) }),
		},
	}).toBinary();
}

/** ConversationStateStructure — the durable conversation payload. */
export function encodeConversationState({ rootPromptBlobIds, turns }: any) {
	return new ConversationStateStructure({
		rootPromptMessagesJson: rootPromptBlobIds,
		turns,
	}).toBinary();
}

/** AgentRunRequest { conversation_state=1, action=2, model_details=3, requested_model=9, conversation_id=5, run_id=25 }.
 * Cursor CLI sends exactly one of `requested_model` or `model_details`. When
 * both are present the server validates `model_details.model_id` against the
 * exploded usable-model slugs and rejects canonical ids like `grok-4.6`.
 * `run_id` is the client-minted generation UUID that `InjectContextAction.expected_run_id` must match. */
export function encodeRunRequest({ conversationState, action, modelDetails, conversationId, requestedModel, runId }: any) {
	// Checkpoints are opaque: tests and the server persist partial
	// ConversationStateStructure bytes that generated fromBinary rejects.
	const writer = new Writer();
	writer.message(1, sanitizeConversationStateForSend(conversationState) ?? conversationState);
	writer.message(2, action);
	if (requestedModel) writer.message(9, requestedModel);
	else if (modelDetails) writer.message(3, modelDetails);
	if (conversationId) writer.string(5, conversationId);
	if (typeof runId === "string" && runId.length > 0) writer.string(25, runId);
	return writer.finish();
}

/** AgentClientMessage { run_request = 1 } */
export function encodeRunMessage(runRequestBytes) {
	return new Writer().message(1, runRequestBytes).finish();
}

/**
 * Store a client-side blob under its SHA-256 id and return the id bytes.
 * Cursor's KV handshake fetches blobs by exactly the ids embedded in
 * `ConversationStateStructure.turns` entries, so the id must be reproducible.
 */
export function storeBlob(blobStore, data) {
	const bytes = bytesOf(data);
	const id = new Uint8Array(createHash("sha256").update(bytes).digest());
	blobStore.set(Buffer.from(id).toString("hex"), bytes);
	return id;
}

/**
 * ConversationAction { resume_action = 2 } — resume a conversation from its
 * checkpoint without a new user message.
 */
export function encodeResumeAction() {
	return new ConversationAction({
		action: { case: "resumeAction", value: new ResumeAction() },
	}).toBinary();
}

/** AgentClientMessage { conversation_action = 4 } — mid-run steer / inject. */
export function encodeConversationActionMessage(actionBytes) {
	return new Writer().message(4, actionBytes).finish();
}

/** UserContextInjection { user_message = 1 } */
export function encodeUserContextInjection({ text, messageId, images = [] }: any) {
	return new UserContextInjection({
		userMessage: UserMessage.fromBinary(encodeUserMessage({ text, messageId, images })),
	}).toBinary();
}

/** SystemContextInjection { producer = 1, content = 2 } */
export function encodeSystemContextInjection({ producer, content }: any) {
	return new SystemContextInjection({
		producer: optionalString(producer),
		content: optionalString(content),
	}).toBinary();
}

/**
 * ConversationAction { inject_context_action = 19 }
 * InjectContextAction { injection_id=1, expected_run_id=2, user_context=3 | system_context=4 }
 */
export function encodeInjectContextAction({ injectionId, expectedRunId, userContext, systemContext }: any) {
	const action: any = {
		injectionId: optionalString(injectionId),
		expectedRunId: optionalString(expectedRunId),
	};
	if (userContext !== undefined) {
		action.payload = {
			case: "userContext",
			value: UserContextInjection.fromBinary(encodeUserContextInjection(userContext)),
		};
	} else if (systemContext !== undefined) {
		action.payload = {
			case: "systemContext",
			value: SystemContextInjection.fromBinary(encodeSystemContextInjection(systemContext)),
		};
	}
	return new ConversationAction({
		action: { case: "injectContextAction", value: new InjectContextAction(action) },
	}).toBinary();
}

/**
 * ConversationAction { async_ask_question_completion_action = 8 }
 * AsyncAskQuestionCompletionAction { original_tool_call_id=1, original_args=2,
 * result=3 } — the protocol-native way to deliver a question answer after the
 * original run is gone ("Contains the original tool call ID and the result
 * from the user").
 */
export function encodeAsyncAskQuestionCompletionAction({ originalToolCallId, originalArgsBytes, resultBytes }: any) {
	const inner = new Writer();
	if (typeof originalToolCallId === "string" && originalToolCallId.length > 0) inner.string(1, originalToolCallId);
	if (originalArgsBytes !== undefined && originalArgsBytes.length > 0) inner.bytes(2, originalArgsBytes);
	inner.bytes(3, resultBytes);
	return new Writer().message(8, inner.finish()).finish();
}

/**
 * ConversationStep { tool_call = 2 } with the MCP variant
 * (ToolCall { mcp_tool_call = 15 } → McpToolCall { args=1, result=2 }).
 * `argsBytes` is the raw McpArgs captured from the exec frame; `resultBytes`
 * is a McpToolResult (McpSuccess/McpError).
 */
export function encodeMcpToolCallStep(argsBytes, resultBytes) {
	const call = new Writer();
	if (argsBytes !== undefined && argsBytes.length > 0) call.bytes(1, argsBytes);
	if (resultBytes !== undefined && resultBytes.length > 0) call.bytes(2, resultBytes);
	const tool = new Writer().message(15, call.finish()).finish(); // ToolCall
	return new Writer().message(2, tool).finish(); // ConversationStep
}

/**
 * Build one replayed turn whose steps carry paired tool calls + results, and
 * return the blob id to append to `ConversationStateStructure.turns` (field 8).
 * Wire chain: turns entry = blob id of ConversationTurnStructure {
 * agent_conversation_turn = 1 { user_message = 1 (blob id), steps = 2 (blob ids) } }.
 */
export function encodeReplayTurnBlob(blobStore, { userText = "", stepBlobs = [] }) {
	const userBlobId = storeBlob(blobStore, encodeUserMessage({ text: userText, messageId: randomUUID() }));
	const stepIds = stepBlobs.map((step) => storeBlob(blobStore, step));
	return storeBlob(blobStore, encodeTurnStructure(encodeAgentTurn(userBlobId, stepIds)));
}

/**
 * Append replayed turn blob ids to a server checkpoint byte-for-byte:
 * every field is re-emitted verbatim except field 8 (turns), which gains the
 * new ids at the end. This preserves todos/fileStates/pendingToolCalls exactly
 * while adding the turns that pair pending calls with their late results.
 */
export function appendTurnsToCheckpoint(checkpointBytes, turnBlobIds) {
	const reader = new Reader(checkpointBytes);
	const writer = new Writer();
	const ids = [];
	while (!reader.done) {
		const start = reader.pos;
		const { field, wireType } = reader.tag();
		if (field === 8 && wireType === 2) {
			ids.push(bytesOf(reader.bytes())); // existing turn blob id — re-appended below
		} else {
			reader.skip(wireType);
			writer.parts.push(reader.data.subarray(start, reader.pos));
		}
	}
	for (const id of [...ids, ...turnBlobIds]) writer.bytes(8, id);
	return writer.finish();
}

/** AgentClientMessage { client_heartbeat = 7 } */
export function encodeHeartbeat() {
	return new AgentClientMessage({
		message: { case: "clientHeartbeat", value: new ClientHeartbeat() },
	}).toBinary();
}

/**
 * KvClientMessage { id=1, get_blob_result=2 { blob_data=1 } }.
 * A miss must omit `blob_data` (opencodex / official client): encoding an
 * empty bytes field looks like a hit with a 0-byte payload, and the server
 * then tries to decode that as a conversation turn and stalls on heartbeats.
 */
export function encodeGetBlobResult(id, blobData) {
	const result = blobData === undefined ? new Uint8Array(0) : new Writer().bytes(1, blobData).finish();
	const writer = new Writer();
	writer.varint(1, id);
	writer.message(2, result);
	return writer.finish();
}

/**
 * Fold `source` into `target` and return the surviving map. Request-time
 * blobs (user/turn ids minted by `storeBlob`) and server `setBlob` writes
 * must share one map: a resume that swaps in a snapshot missing the
 * request-time ids answers getBlob with a miss and the Run heartbeats
 * until the progress timeout.
 */
export function adoptBlobStore(target, source) {
	if (source === undefined || source === target) return target ?? new Map();
	const out = target ?? new Map();
	for (const [key, value] of source) out.set(key, value);
	return out;
}

/** AgentClientMessage { kv_client_message = 3 } */
export function encodeKvClientMessage(kvBytes) {
	return new Writer().message(3, kvBytes).finish();
}

/** KvClientMessage { id=1, set_blob_result=3 } — acknowledge a server blob write. */
export function encodeSetBlobResult(id) {
	const writer = new Writer();
	writer.varint(1, id);
	writer.message(3, new Uint8Array(0)); // set_blob_result (empty success)
	return writer.finish();
}

/** McpResult.success with one text content item. */
export function encodeMcpResult({ content, isError = false }: any) {
	return encodeMcpResultSuccess(String(content ?? ""), isError);
}

/** ExecClientMessage { id=1, exec_id=15, message=... } */
export function encodeExecClientMessage(id, execId, messageField, messageBytes) {
	const writer = new Writer();
	writer.varint(1, id);
	if (typeof execId === "string" && execId.length > 0) writer.string(15, execId);
	if (messageBytes !== undefined) writer.message(messageField, messageBytes);
	return writer.finish();
}

/** AgentClientMessage { exec_client_message = 2 } */
export function encodeExecClientMessageEnvelope(execBytes) {
	return new Writer().message(2, execBytes).finish();
}

/** RequestContextResult { success=1 { request_context=1 } } with tools and Cursor rules. */
export function encodeRequestContextResult(tools, rules = []) {
	const context = new Writer();
	for (const rule of rules) context.message(2, encodeCursorRule(rule)); // RequestContext.rules
	for (const tool of tools) context.message(7, tool); // RequestContext.tools
	const success = new Writer().message(1, context.finish()).finish(); // RequestContextSuccess
	return new Writer().message(1, success).finish(); // RequestContextResult
}

/** McpToolDefinition { name=1, description=2, input_schema=3, provider_identifier=4, tool_name=5 } */
export function encodeMcpToolDefinition({ name, description, inputSchema, providerIdentifier, toolName }: any) {
	const writer = new Writer();
	writer.string(1, name);
	writer.string(2, description ?? "");
	writer.bytes(3, bytesOf(inputSchema));
	writer.string(4, providerIdentifier ?? "dsh");
	writer.string(5, toolName ?? name);
	return writer.finish();
}

/** McpTextContent { text = 1 } */
function encodeMcpTextContent(text) {
	return new Writer().string(1, text).finish();
}

/** McpToolResultContentItem { text = 1 } */
function encodeMcpToolResultContentItem(text) {
	return new Writer().message(1, encodeMcpTextContent(text)).finish();
}

/** McpSuccess { content=1, is_error=2 } */
function encodeMcpSuccess(text, isError) {
	const writer = new Writer();
	writer.message(1, encodeMcpToolResultContentItem(text));
	writer.varint(2, isError ? 1 : 0);
	return writer.finish();
}

/** McpResult { success=1 | error=2 } */
function encodeMcpResultSuccess(text, isError) {
	return new Writer().message(1, encodeMcpSuccess(text, isError)).finish();
}

export function encodeMcpError(error) {
	return new Writer().message(2, new Writer().string(1, error).finish()).finish();
}

/** ReadResult { rejected=3 { path=1, reason=2 } } */
export function encodeReadRejected(path, reason) {
	const rejected = new Writer().string(1, path ?? "").string(2, reason).finish();
	return new Writer().message(3, rejected).finish();
}

/** LsResult { rejected=3 { path=1, reason=2 } } */
export function encodeLsRejected(path, reason) {
	const rejected = new Writer().string(1, path ?? "").string(2, reason).finish();
	return new Writer().message(3, rejected).finish();
}

/** GrepResult { error=2 { error=1 } } */
export function encodeGrepError(error) {
	return new Writer().message(2, new Writer().string(1, error).finish()).finish();
}

/** WriteRejected { path=1, reason=2 } → WriteResult { rejected = 6 } — the user said no to the escalation prompt (oneof: success=1, permission_denied=3, no_space=4, error=5, rejected=6). */
export function encodeWriteRejected({ path, reason }: any) {
	const rejected = new Writer().string(1, path ?? "").string(2, String(reason ?? "")).finish();
	return new Writer().message(6, rejected).finish();
}

/** DeleteRejected { path=1, reason=2 } → DeleteResult { rejected = 6 } (oneof: success=1, file_not_found=2, not_file=3, permission_denied=4, file_busy=5, rejected=6). */
export function encodeDeleteRejected({ path, reason }: any) {
	const rejected = new Writer().string(1, path ?? "").string(2, String(reason ?? "")).finish();
	return new Writer().message(6, rejected).finish();
}

/** ShellRejected { command=1, working_directory=2, reason=3, is_readonly=4 } */
function encodeShellRejected(command, workingDirectory, reason) {
	const writer = new Writer();
	writer.string(1, command ?? "");
	writer.string(2, workingDirectory ?? "");
	writer.string(3, reason);
	writer.varint(4, 0);
	return writer.finish();
}

/** ShellResult { rejected = 4 } (oneof: success=1, failure=2, timeout=3, rejected=4) */
export function encodeShellRejectedResult(command, workingDirectory, reason) {
	return new Writer().message(4, encodeShellRejected(command, workingDirectory, reason)).finish();
}

/**
 * ShellStream { rejected = 5 } — the reply type for `shellStreamArgs` execs
 * (streaming shell), carried by ExecClientMessage.shell_stream (field 14).
 */
export function encodeShellStreamRejected(command, workingDirectory, reason) {
	return new Writer().message(5, encodeShellRejected(command, workingDirectory, reason)).finish();
}

/** BackgroundShellSpawnResult { rejected = 3 } (oneof: success=1, error=2, rejected=3, permission_denied=4) */
export function encodeBackgroundShellRejectedResult(command, workingDirectory, reason) {
	return new Writer().message(3, encodeShellRejected(command, workingDirectory, reason)).finish();
}

/** FetchResult { error=2 { url=1, error=2 } } */
export function encodeFetchError(url, error) {
	const inner = new Writer().string(1, url ?? "").string(2, error).finish();
	return new Writer().message(2, inner).finish();
}

/** WriteShellStdinResult { error=2 { error=1 } } */
export function encodeWriteShellStdinError(error) {
	return new Writer().message(2, new Writer().string(1, error).finish()).finish();
}

/** WriteShellStdinSuccess { shell_id=1, terminal_file_length_before_input_written=2 } → WriteShellStdinResult { success=1 } */
export function encodeWriteShellStdinSuccess({ shellId, terminalFileLengthBeforeInputWritten }: any) {
	const inner = new Writer();
	inner.varint(1, shellId >>> 0);
	inner.varint(2, terminalFileLengthBeforeInputWritten >>> 0);
	return new Writer().message(1, inner.finish()).finish();
}

/**
 * ShellStream { event oneof: stdout=1, stderr=2, exit=3, start=4 } — the
 * field-14 payload streamed for `shellStreamArgs` execs. The frame sequence
 * contract (confirmed by oh-my-pi and opencodex): start → stdout/stderr
 * deltas → exit, then the final structured shellResult (field 2) + stream
 * close. Missing the last two frames leaves the server-side turn pending
 * forever (heartbeat stall → upstream watchdog → 502).
 */
export function encodeShellStreamStart(sandboxPolicyType) {
	// ShellStreamStart { sandbox_policy=1 SandboxPolicy{ type=1 } } — the
	// client echoes the policy it will execute under; we echo the policy the
	// call requested (opencodex echoes args.requestedSandboxPolicy the same way).
	const inner = new Writer();
	if (Number.isSafeInteger(sandboxPolicyType) && sandboxPolicyType > 0) {
		inner.message(1, new Writer().varint(1, sandboxPolicyType).finish());
	}
	return new Writer().message(4, inner.finish()).finish();
}

export function encodeShellStreamStdout(data) {
	return new Writer().message(1, new Writer().string(1, String(data ?? "")).finish()).finish();
}

export function encodeShellStreamStderr(data) {
	return new Writer().message(2, new Writer().string(1, String(data ?? "")).finish()).finish();
}

/** OutputLocation { file_path=1, size_bytes=2, line_count=3 } */
export function encodeOutputLocation({ filePath, sizeBytes, lineCount }: any) {
	const inner = new Writer();
	inner.string(1, filePath ?? "");
	if (Number.isSafeInteger(sizeBytes)) inner.varint(2, sizeBytes);
	if (Number.isSafeInteger(lineCount)) inner.varint(3, lineCount);
	return inner.finish();
}

/** ShellStreamExit { code=1, cwd=2, output_location=3, aborted=4 } */
export function encodeShellStreamExit({ code, cwd, aborted = false, outputLocation }: any) {
	const inner = new Writer();
	inner.varint(1, code >>> 0);
	inner.string(2, cwd ?? "");
	if (outputLocation !== undefined) inner.message(3, encodeOutputLocation(outputLocation));
	if (aborted) inner.varint(4, 1);
	return new Writer().message(3, inner.finish()).finish();
}

/**
 * ShellStreamBackgrounded { shell_id=1, command=2, working_directory=3,
 * pid=4, ms_to_wait=5, reason=6 } → ShellStream { backgrounded=7 } — the
 * block deadline expired with timeout_behavior=BACKGROUND: the command keeps
 * running and the model monitors the terminal file.
 */
export function encodeShellStreamBackgrounded({ shellId, command, workingDirectory, pid, msToWait, reason }: any) {
	const inner = new Writer();
	inner.varint(1, shellId >>> 0);
	inner.string(2, command ?? "");
	inner.string(3, workingDirectory ?? "");
	if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) inner.varint(4, pid >>> 0);
	if (Number.isSafeInteger(msToWait)) inner.varint(5, msToWait);
	if (Number.isSafeInteger(reason)) inner.varint(6, reason);
	return new Writer().message(7, inner.finish()).finish();
}

/**
 * ShellResult { result oneof: success=1, failure=2, timeout=3, rejected=4,
 * spawn_error=5, permission_denied=7; is_background=102, terminals_folder=103,
 * pid=104 }.
 */
function encodeShellResult(resultField, inner, { terminalsFolder, isBackground, pid } : any = {}) {
	const writer = new Writer();
	writer.message(resultField, inner);
	if (isBackground === true) writer.varint(102, 1);
	if (terminalsFolder !== undefined) writer.string(103, terminalsFolder);
	if (pid !== undefined) writer.varint(104, pid >>> 0);
	return writer.finish();
}

/** ShellSuccess { command=1, working_directory=2, exit_code=3, signal=4, stdout=5, stderr=6, execution_time=7, shell_id=9, ms_to_wait=12 } */
export function encodeShellSuccess({ command, workingDirectory, exitCode, stdout = "", stderr = "", executionTime = 0, terminalsFolder, isBackground, pid, shellId, msToWait }: any) {
	const inner = new Writer();
	inner.string(1, command ?? "");
	inner.string(2, workingDirectory ?? "");
	inner.varint(3, exitCode | 0);
	inner.string(4, "");
	inner.string(5, stdout);
	inner.string(6, stderr);
	inner.varint(7, executionTime | 0);
	if (shellId !== undefined) inner.varint(9, shellId >>> 0);
	if (Number.isSafeInteger(msToWait)) inner.varint(12, msToWait);
	return encodeShellResult(1, inner.finish(), { terminalsFolder, isBackground, pid });
}

/** ShellFailure { command=1, working_directory=2, exit_code=3, signal=4, stdout=5, stderr=6, execution_time=7, aborted=11 } */
export function encodeShellFailure({ command, workingDirectory, exitCode, stdout = "", stderr = "", executionTime = 0, aborted = false, terminalsFolder, isBackground, pid }: any) {
	const inner = new Writer();
	inner.string(1, command ?? "");
	inner.string(2, workingDirectory ?? "");
	inner.varint(3, exitCode | 0);
	inner.string(4, "");
	inner.string(5, stdout);
	inner.string(6, stderr);
	inner.varint(7, executionTime | 0);
	if (aborted) inner.varint(11, 1);
	return encodeShellResult(2, inner.finish(), { terminalsFolder, isBackground, pid });
}

/** ShellTimeout { command=1, working_directory=2, timeout_ms=3 } → ShellResult { timeout=3 } */
export function encodeShellTimeout({ command, workingDirectory, timeoutMs }: any) {
	const inner = new Writer();
	inner.string(1, command ?? "");
	inner.string(2, workingDirectory ?? "");
	inner.varint(3, timeoutMs | 0);
	return encodeShellResult(3, inner.finish());
}

/** ShellSpawnError { command=1, working_directory=2, error=3 } → ShellResult { spawn_error=5 } */
export function encodeShellSpawnError({ command, workingDirectory, error }: any) {
	const inner = new Writer();
	inner.string(1, command ?? "");
	inner.string(2, workingDirectory ?? "");
	inner.string(3, String(error ?? ""));
	return encodeShellResult(5, inner.finish());
}

/** ShellPermissionDenied { command=1, working_directory=2, error=3, is_readonly=4 } → ShellResult { permission_denied=7 } */
export function encodeShellPermissionDenied({ command, workingDirectory, error, isReadonly = false }: any) {
	const inner = new Writer();
	inner.string(1, command ?? "");
	inner.string(2, workingDirectory ?? "");
	inner.string(3, String(error ?? ""));
	inner.varint(4, isReadonly ? 1 : 0);
	return encodeShellResult(7, inner.finish());
}

/** BackgroundShellSpawnSuccess { shell_id=1, command=2, working_directory=3, pid=4 opt } → BackgroundShellSpawnResult { success=1 } */
export function encodeBackgroundShellSpawnSuccess({ shellId, command, workingDirectory, pid }: any) {
	const inner = new Writer();
	inner.varint(1, shellId >>> 0);
	inner.string(2, command ?? "");
	inner.string(3, workingDirectory ?? "");
	if (pid !== undefined) inner.varint(4, pid >>> 0);
	return new Writer().message(1, inner.finish()).finish();
}

/** BackgroundShellSpawnError { command=1, working_directory=2, error=3 } → BackgroundShellSpawnResult { error=2 } */
export function encodeBackgroundShellSpawnError({ command, workingDirectory, error }: any) {
	const inner = new Writer();
	inner.string(1, command ?? "");
	inner.string(2, workingDirectory ?? "");
	inner.string(3, String(error ?? ""));
	return new Writer().message(2, inner.finish()).finish();
}

/** DiagnosticsResult { success = 1 } — empty success keeps the exec well-formed. */
export function encodeDiagnosticsResult() {
	return new Writer().message(1, new Uint8Array(0)).finish();
}
//#endregion

//#region cursor native tool support — result encoders, arg decoders, translation (Phase 1)
/**
 * Field numbers follow the reconstructed agent.v1 exec protos
 * (b-nnett/grok-bot-0.18-reconstructed, commit
 * a9f633e09d49a85829b8236331b9e21f7e612634): read_exec_pb.ts,
 * write_exec_pb.ts, grep_exec_pb.ts, delete_exec_pb.ts, agent_pb.ts.
 */

/** ReadSuccess { path=1, content=2 (output oneof), total_lines=3, file_size=4, data=5 (output oneof), truncated=6, output_blob_id=7, range_applied=8 } */
function encodeReadSuccessInner({ path, content, data, totalLines = 0, fileSize = 0, truncated = false, rangeApplied = false }: any) {
	const writer = new Writer();
	writer.string(1, path ?? "");
	if (data instanceof Uint8Array) writer.bytes(5, data);
	else writer.string(2, content ?? "");
	writer.varint(3, totalLines);
	if (fileSize > 0) writer.varint(4, fileSize);
	if (truncated) writer.varint(6, 1);
	if (rangeApplied) writer.varint(8, 1);
	return writer.finish();
}

/** ReadResult { success=1 ReadSuccess } — the full field-7 payload. */
export function encodeReadSuccess(args) {
	return new Writer().message(1, encodeReadSuccessInner(args)).finish();
}

/** ReadError { path=1, error=2 } → ReadResult { error=2 }. */
function encodeReadErrorInner({ path, error }: any) {
	const writer = new Writer();
	writer.string(1, path ?? "");
	writer.string(2, String(error ?? ""));
	return writer.finish();
}

export function encodeReadError(args) {
	return new Writer().message(2, encodeReadErrorInner(args)).finish();
}

/** ReadFileNotFound { path=1 } → ReadResult { file_not_found=4 }. */
function encodeReadFileNotFoundInner({ path }: any) {
	const writer = new Writer();
	writer.string(1, path ?? "");
	return writer.finish();
}

export function encodeReadFileNotFound(args) {
	return new Writer().message(4, encodeReadFileNotFoundInner(args)).finish();
}

/** ReadInvalidFile { path=1, reason=2 } → ReadResult { invalid_file=6 }. */
function encodeReadInvalidFileInner({ path, reason }: any) {
	const writer = new Writer();
	writer.string(1, path ?? "");
	writer.string(2, String(reason ?? ""));
	return writer.finish();
}

export function encodeReadInvalidFile(args) {
	return new Writer().message(6, encodeReadInvalidFileInner(args)).finish();
}

function countLines(content) {
	const text = String(content ?? "");
	if (text.length === 0) return 0;
	return text.split("\n").length;
}

/** WriteSuccess { path=1, lines_created=2, file_size=3, file_content_after_write=4 opt } */
function encodeWriteSuccessInner({ path, content, returnFileContentAfterWrite = false }: any) {
	const writer = new Writer();
	writer.string(1, path ?? "");
	writer.varint(2, countLines(content));
	writer.varint(3, new TextEncoder().encode(content ?? "").length);
	if (returnFileContentAfterWrite) writer.string(4, content ?? "");
	return writer.finish();
}

/** WriteResult { success=1 WriteSuccess } — the full field-3 payload. */
export function encodeWriteSuccess(args) {
	return new Writer().message(1, encodeWriteSuccessInner(args)).finish();
}

/** WriteError { path=1, error=2 } → WriteResult { error=5 }. */
function encodeWriteErrorInner({ path, error }: any) {
	const writer = new Writer();
	writer.string(1, path ?? "");
	writer.string(2, String(error ?? ""));
	return writer.finish();
}

export function encodeWriteError(args) {
	return new Writer().message(5, encodeWriteErrorInner(args)).finish();
}

/** GrepError { error=1 } — the inner message of GrepResult.error = 2. */
function encodeGrepInnerError(error) {
	return new Writer().string(1, String(error ?? "")).finish();
}

/** GrepContentMatch { line_number=1, content=2, content_truncated=3, is_context_line=4 } */
function encodeGrepContentMatch({ lineNumber, content, contentTruncated = false, isContextLine = false }: any) {
	const writer = new Writer();
	writer.varint(1, lineNumber);
	writer.string(2, content ?? "");
	if (contentTruncated) writer.varint(3, 1);
	if (isContextLine) writer.varint(4, 1);
	return writer.finish();
}

/** GrepFileMatch { file=1, matches=2 repeated GrepContentMatch } */
function encodeGrepFileMatch({ file, matches }: any) {
	const writer = new Writer();
	writer.string(1, file ?? "");
	for (const match of matches ?? []) writer.message(2, encodeGrepContentMatch(match));
	return writer.finish();
}

/** GrepContentResult { matches=1 repeated, total_lines=2, total_matched_lines=3, client_truncated=4, ripgrep_truncated=5, offset_applied=7 opt } */
export function encodeGrepContentResult({ matches, totalLines = 0, totalMatchedLines = 0, clientTruncated = false, ripgrepTruncated = false, offsetApplied }: any) {
	const writer = new Writer();
	for (const file of matches ?? []) writer.message(1, encodeGrepFileMatch(file));
	writer.varint(2, totalLines);
	writer.varint(3, totalMatchedLines);
	if (clientTruncated) writer.varint(4, 1);
	if (ripgrepTruncated) writer.varint(5, 1);
	if (Number.isSafeInteger(offsetApplied)) writer.varint(7, offsetApplied);
	return writer.finish();
}

/** GrepFileCount { file=1, count=2 } */
function encodeGrepFileCount({ file, count }: any) {
	const writer = new Writer();
	writer.string(1, file ?? "");
	writer.varint(2, count);
	return writer.finish();
}

/** GrepCountResult { counts=1 repeated, total_files=2, total_matches=3, client_truncated=4, ripgrep_truncated=5, offset_applied=7 opt } */
export function encodeGrepCountResult({ counts, totalFiles = 0, totalMatches = 0, clientTruncated = false, ripgrepTruncated = false, offsetApplied }: any) {
	const writer = new Writer();
	for (const entry of counts ?? []) writer.message(1, encodeGrepFileCount(entry));
	writer.varint(2, totalFiles);
	writer.varint(3, totalMatches);
	if (clientTruncated) writer.varint(4, 1);
	if (ripgrepTruncated) writer.varint(5, 1);
	if (Number.isSafeInteger(offsetApplied)) writer.varint(7, offsetApplied);
	return writer.finish();
}

/** GrepFilesResult { files=1 repeated, total_files=2, client_truncated=3, ripgrep_truncated=4, offset_applied=6 opt } */
export function encodeGrepFilesResult({ files, totalFiles = 0, clientTruncated = false, ripgrepTruncated = false, offsetApplied }: any) {
	const writer = new Writer();
	for (const file of files ?? []) writer.string(1, file);
	writer.varint(2, totalFiles);
	if (clientTruncated) writer.varint(3, 1);
	if (ripgrepTruncated) writer.varint(4, 1);
	if (Number.isSafeInteger(offsetApplied)) writer.varint(6, offsetApplied);
	return writer.finish();
}

/**
 * GrepSuccess { pattern=1, path=2, output_mode=3, workspace_results=4
 * MAP<string, GrepUnionResult> — each map entry is { key=1 string, value=2
 * GrepUnionResult { count=1 | files=2 | content=3 } }, active_editor_result=5 }
 * wrapped in GrepResult { success=1 | error=2 }.
 *
 * A bare union submessage at field 4 decodes as a map entry with neither key
 * nor value: the server sees an empty result and the model re-asks until the
 * turn stalls (the observed grep/glob hang). Real clients key the map by the
 * search path (oh-my-pi: `args.path || "."`).
 */
export function encodeGrepSuccessResult({ pattern, path, outputMode, unionBytes }: any) {
	const entry = new Writer();
	entry.string(1, typeof path === "string" && path.length > 0 ? path : ".");
	entry.message(2, unionBytes);
	const success = new Writer();
	success.string(1, pattern ?? "");
	success.string(2, path ?? "");
	// `||` — never emit an empty string for a mode the server must recognize
	// (an empty output_mode renders as "unknown output mode" upstream; oh-my-pi
	// coerces identically: `args.outputMode || "content"`).
	success.string(3, outputMode || "content");
	success.message(4, entry.finish());
	return new Writer().message(1, success.finish()).finish();
}

export function encodeGrepErrorResult(error) {
	return new Writer().message(2, encodeGrepInnerError(error)).finish();
}

/**
 * Classify a Cursor GrepArgs frame: a glob-shaped call (empty pattern +
 * files_with_matches + glob) becomes the DSH `glob` card; everything else
 * stays `grep`. Display args keep Cursor keys (`glob`, not official `include`).
 */
export function encodeInteractionResponseEnvelope(responseBytes) {
	return new Writer().message(6, responseBytes).finish();
}

/**
 * AgentClientMessage { exec_client_control_message = 5 } →
 * ExecClientControlMessage { stream_close = 1 } → ExecClientStreamClose { id = 1 }.
 * The server waits for this close after every exec result before continuing
 * the run (CCursor execRuntime: waitForExecClientMessageWithHeartbeat then
 * waitForExecStreamCloseWithHeartbeat).
 */
export function encodeExecStreamClose(id) {
	const close = new Writer().varint(1, id).finish();
	const control = new Writer().message(1, close).finish();
	return new Writer().message(5, control).finish();
}

/**
 * AgentClientMessage { exec_client_control_message = 5 { throw = 2
 * ExecClientThrow { id=1, error=2, stack_trace=3, error_code=4 } } } — the
 * protocol's in-band failure channel for an exec frame this client cannot
 * answer at all (opencodex T05): the server unblocks with a known failure
 * instead of waiting forever on silence.
 */
export function encodeExecThrow(id, error, errorCode) {
	const thrown = new Writer();
	thrown.varint(1, id);
	thrown.string(2, String(error ?? ""));
	if (typeof errorCode === "string" && errorCode.length > 0) thrown.string(4, errorCode);
	const control = new Writer().message(2, thrown.finish()).finish();
	return new Writer().message(5, control).finish();
}

/** AskQuestionSuccess.Answer { question_id=1, selected_option_ids=2 repeated, freeform_text=3 } */
function encodeAskQuestionAnswer({ questionId, selectedOptionIds, freeformText }: any) {
	const writer = new Writer();
	writer.string(1, questionId ?? "");
	for (const optionId of selectedOptionIds ?? []) writer.string(2, optionId);
	if (freeformText !== undefined) writer.string(3, freeformText);
	return writer.finish();
}

/** AskQuestionSuccess { answers=1 repeated } */
export function encodeAskQuestionSuccess(answers) {
	const writer = new Writer();
	for (const answer of answers ?? []) writer.message(1, encodeAskQuestionAnswer(answer));
	return writer.finish();
}

/** AskQuestionResult { success=1 | error=2 { error_message=1 } | rejected=3 { reason=1 } } */
export function encodeAskQuestionResultSuccess(answers) {
	return new Writer().message(1, encodeAskQuestionSuccess(answers)).finish();
}

export function encodeAskQuestionResultError(message) {
	return new Writer().message(2, new Writer().string(1, String(message ?? "")).finish()).finish();
}

/**
 * InteractionResponse { id=1, ask_question_interaction_response=3
 * { result=1 AskQuestionResult } }.
 */
export function encodeAskQuestionInteractionResponse({ id, resultBytes }: any) {
	const inner = new Writer().message(1, resultBytes).finish(); // AskQuestionInteractionResponse
	const writer = new Writer();
	writer.varint(1, id);
	writer.message(3, inner);
	return writer.finish();
}

/**
 * Build the AskQuestionResult bytes from a DSH ask_user_question tool result.
 *
 * The DSH result text is `JSON.stringify({ answers: [{ id, selected: [label],
 * custom? }] })`; option picks carry LABELS and are reverse-mapped onto the
 * Cursor option ids. Duplicate labels resolve to the first option id.
 */
export function buildAskQuestionResultBytes(questions, result) {
	if (result === undefined || result.isError) {
		return encodeAskQuestionResultError(String(result?.content ?? "The AskQuestion answer was not provided"));
	}
	let parsed;
	try {
		parsed = JSON.parse(result.content);
	} catch {
		return encodeAskQuestionResultError("The AskQuestion answer could not be parsed");
	}
	const answers = Array.isArray(parsed?.answers) ? parsed.answers : [];
	const mapped = [];
	for (const question of questions ?? []) {
		const questionId = String(question.id ?? "");
		const answer = answers.find((entry) => entry !== null && typeof entry === "object" && String(entry.id ?? "") === questionId);
		const labels = Array.isArray(answer?.selected) ? answer.selected.map((value) => String(value)) : [];
		const selectedOptionIds = [];
		for (const label of labels) {
			const option = (question.options ?? []).find((candidate) => candidate.label === label);
			if (option !== undefined) selectedOptionIds.push(String(option.id));
		}
		const entry: any = { questionId, selectedOptionIds };
		if (answer !== undefined && typeof answer.custom === "string" && answer.custom.length > 0) {
			entry.freeformText = answer.custom;
		}
		mapped.push(entry);
	}
	return encodeAskQuestionResultSuccess(mapped);
}

/** { approved=1 {} } — the empty approved message for request/response pairs. */
function encodeApprovedResult() {
	return new Writer().message(1, new Uint8Array(0)).finish();
}

/**
 * InteractionResponse { id=1, <field> { approved=1 {} } } for the
 * webFetch/webSearch approval handshakes (the server performs the work
 * itself after the client approves).
 */
export function encodeInteractionApproved(id, field) {
	const writer = new Writer();
	writer.varint(1, id);
	writer.message(field, encodeApprovedResult());
	return writer.finish();
}

/** InteractionResponse { id=1, <field> { rejected=2 { reason=1 } } }. */
export function encodeInteractionRejected(id, field, reason) {
	const writer = new Writer();
	writer.varint(1, id);
	writer.message(field, new Writer().message(2, new Writer().string(1, String(reason ?? "")).finish()).finish());
	return writer.finish();
}

/** Message shown for interaction queries that have no DSH counterpart. */
export const INTERACTION_UNAVAILABLE = "Not available in DeepSeek Harness.";

/**
 * Build the in-band rejection reply for interaction queries beyond
 * askQuestion/webFetch/webSearch. Returns undefined for query kinds without a
 * rejection variant (setupVmEnvironmentArgs — today's behavior is the same
 * hang these all had before the bridge, documented limitation).
 */
export function rejectionForInteraction(query) {
	switch (query.case) {
		case "switchModeRequestQuery":
			return { field: 4, payload: encodeInteractionRejected(query.id, 4, INTERACTION_UNAVAILABLE) };
		case "createPlanRequestQuery": {
			// CreatePlanRequestResponse { result=1 CreatePlanResult { error=2 { error=1 } } }
			const result = new Writer().message(2, new Writer().string(1, INTERACTION_UNAVAILABLE).finish()).finish();
			const writer = new Writer();
			writer.varint(1, query.id);
			writer.message(7, new Writer().message(1, result).finish());
			return { field: 7, payload: writer.finish() };
		}
		case "prManagementRequestQuery": {
			// PrManagementResult { rejected=3 { reason=1 } }
			const result = new Writer().message(3, new Writer().string(1, INTERACTION_UNAVAILABLE).finish()).finish();
			const writer = new Writer();
			writer.varint(1, query.id);
			writer.message(10, result);
			return { field: 10, payload: writer.finish() };
		}
		case "mcpAuthRequestQuery":
			return { field: 11, payload: encodeInteractionRejected(query.id, 11, INTERACTION_UNAVAILABLE) };
		case "generateImageRequestQuery":
			return { field: 12, payload: encodeInteractionRejected(query.id, 12, INTERACTION_UNAVAILABLE) };
		case "replaceEnvArgs": {
			// ReplaceEnvResult { failure=2 { error=1 } }
			const result = new Writer().message(2, new Writer().string(1, INTERACTION_UNAVAILABLE).finish()).finish();
			const writer = new Writer();
			writer.varint(1, query.id);
			writer.message(13, result);
			return { field: 13, payload: writer.finish() };
		}
		case "connectScmRequestQuery":
			return { field: 14, payload: encodeInteractionRejected(query.id, 14, INTERACTION_UNAVAILABLE) };
		case "setupVmEnvironmentArgs":
			return undefined;
		default:
			return undefined;
	}
}

/**
 * Map one Cursor todo item onto the DSH todo shape ({content, status});
 * UNSPECIFIED/CANCELLED items are dropped (DSH has no cancelled state).
 */
export function normalizeCursorTodos(items) {
	const todos = [];
	for (const item of items ?? []) {
		if (item === null || typeof item !== "object") continue;
		const content = typeof item.content === "string" ? item.content : undefined;
		if (content === undefined || content.trim().length === 0) continue;
		const status = normalizeTodoStatus(item.status);
		if (status === undefined) continue;
		todos.push({ content, status });
	}
	return todos;
}

function normalizeTodoStatus(status) {
	if (typeof status === "number") {
		return { 0: undefined, 1: "pending", 2: "in_progress", 3: "completed", 4: undefined }[status];
	}
	if (typeof status !== "string") return undefined;
	switch (status.toLowerCase()) {
		case "pending": return "pending";
		case "in_progress": return "in_progress";
		case "completed": return "completed";
		default: return undefined;
	}
}

/** AskQuestionArgs.Question { id=1, prompt=2, options=3 repeated Option { id=1, label=2 }, allow_multiple=4 } */
function decodeAskQuestionArgs(bytes): any {
	const reader = new Reader(bytes);
	const args: any = { title: "", questions: [], runAsync: false };
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) {
			args.title = reader.string();
		} else if (field === 2 && wireType === 2) {
			const inner = new Reader(reader.bytes());
			const question = { id: "", prompt: "", options: [], allowMultiple: false };
			while (!inner.done) {
				const tag = inner.tag();
				if (tag.field === 1 && tag.wireType === 2) question.id = inner.string();
				else if (tag.field === 2 && tag.wireType === 2) question.prompt = inner.string();
				else if (tag.field === 3 && tag.wireType === 2) {
					const optionReader = new Reader(inner.bytes());
					const option = { id: "", label: "" };
					while (!optionReader.done) {
						const optionTag = optionReader.tag();
						if (optionTag.field === 1 && optionTag.wireType === 2) option.id = optionReader.string();
						else if (optionTag.field === 2 && optionTag.wireType === 2) option.label = optionReader.string();
						else optionReader.skip(optionTag.wireType);
					}
					question.options.push(option);
				} else if (tag.field === 4 && tag.wireType === 0) question.allowMultiple = inner.varint() !== 0;
				else inner.skip(tag.wireType);
			}
			args.questions.push(question);
		} else if (field === 5 && wireType === 0) {
			args.runAsync = reader.varint() !== 0;
		} else if (field === 6 && wireType === 2) {
			args.asyncOriginalToolCallId = reader.string();
		} else {
			reader.skip(wireType);
		}
	}
	return args;
}

/** AskQuestionInteractionQuery { args=1 AskQuestionArgs, tool_call_id=2 } */
export function decodeAskQuestionInteractionQuery(bytes): any {
	const reader = new Reader(bytes);
	const value = { args: undefined, rawArgs: undefined, toolCallId: "" };
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) {
			const payload = reader.bytes();
			value.rawArgs = Uint8Array.from(payload);
			value.args = decodeAskQuestionArgs(payload);
		} else if (field === 2 && wireType === 2) value.toolCallId = reader.string();
		else reader.skip(wireType);
	}
	return value;
}

/**
 * InteractionQuery { id=1, oneof: web_search=2, ask_question=3, switch_mode=4,
 * create_plan=7, setup_vm=8, web_fetch=9, pr_management=10, mcp_auth=11,
 * generate_image=12, replace_env=13, connect_scm=14 }.
 */
export function decodeInteractionQuery(bytes): any {
	const reader = new Reader(bytes);
	let id = 0;
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 0) {
			id = reader.varint();
		} else if (wireType === 2) {
			const payload = reader.bytes();
			if (field === 2) return { id, case: "webSearchRequestQuery", value: undefined };
			if (field === 3) return { id, case: "askQuestionInteractionQuery", value: decodeAskQuestionInteractionQuery(payload) };
			if (field === 4) return { id, case: "switchModeRequestQuery", value: undefined };
			if (field === 7) return { id, case: "createPlanRequestQuery", value: undefined };
			if (field === 8) return { id, case: "setupVmEnvironmentArgs", value: undefined };
			if (field === 9) return { id, case: "webFetchRequestQuery", value: undefined };
			if (field === 10) return { id, case: "prManagementRequestQuery", value: undefined };
			if (field === 11) return { id, case: "mcpAuthRequestQuery", value: undefined };
			if (field === 12) return { id, case: "generateImageRequestQuery", value: undefined };
			if (field === 13) return { id, case: "replaceEnvArgs", value: undefined };
			if (field === 14) return { id, case: "connectScmRequestQuery", value: undefined };
		} else {
			reader.skip(wireType);
		}
	}
	return { id, case: "unknown", value: undefined };
}

/** ReadArgs { path=1, tool_call_id=2, offset=4 int32, limit=5 uint32, encoding_hint=6 } */
export function decodeReadArgs(bytes): any {
	const reader = new Reader(bytes);
	const args: any = { path: "", toolCallId: "" };
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) args.path = reader.string();
		else if (field === 2 && wireType === 2) args.toolCallId = reader.string();
		else if (field === 4 && wireType === 0) args.offset = reader.varint() | 0; // int32 (may be negative)
		else if (field === 5 && wireType === 0) args.limit = reader.varint();
		else if (field === 6 && wireType === 2) args.encodingHint = reader.string();
		else reader.skip(wireType);
	}
	return args;
}

/** WriteArgs { path=1, file_text=2, tool_call_id=3, return_file_content_after_write=4, file_bytes=5, encoding_hint=6 } */
export function decodeWriteArgs(bytes): any {
	const reader = new Reader(bytes);
	const args: any = { path: "", fileText: "", toolCallId: "" };
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) args.path = reader.string();
		else if (field === 2 && wireType === 2) args.fileText = reader.string();
		else if (field === 3 && wireType === 2) args.toolCallId = reader.string();
		else if (field === 4 && wireType === 0) args.returnFileContentAfterWrite = reader.varint() !== 0;
		else if (field === 5 && wireType === 2) args.fileBytes = reader.bytes();
		else if (field === 6 && wireType === 2) args.encodingHint = reader.string();
		else reader.skip(wireType);
	}
	return args;
}

/** GrepArgs { pattern=1, path=2, glob=3, output_mode=4, case_insensitive=8, type=9, tool_call_id=14, offset=16, ... } */
export function decodeGrepArgs(bytes): any {
	const reader = new Reader(bytes);
	const args: any = { pattern: "", path: "", glob: "", outputMode: "", toolCallId: "" };
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) args.pattern = reader.string();
		else if (field === 2 && wireType === 2) args.path = reader.string();
		else if (field === 3 && wireType === 2) args.glob = reader.string();
		else if (field === 4 && wireType === 2) args.outputMode = reader.string();
		else if (field === 8 && wireType === 0) args.caseInsensitive = reader.varint() !== 0;
		else if (field === 9 && wireType === 2) args.type = reader.string();
		else if (field === 10 && wireType === 0) args.headLimit = reader.varint();
		else if (field === 14 && wireType === 2) args.toolCallId = reader.string();
		else if (field === 16 && wireType === 0) args.offset = reader.varint() | 0;
		else reader.skip(wireType);
	}
	return args;
}

/** DeleteArgs { path=1, tool_call_id=2 } */
export function decodeDeleteArgs(bytes): any {
	const reader = new Reader(bytes);
	const args = { path: "", toolCallId: "" };
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) args.path = reader.string();
		else if (field === 2 && wireType === 2) args.toolCallId = reader.string();
		else reader.skip(wireType);
	}
	return args;
}

/** SandboxPolicy { type=1 int32, network_access=2 bool, additional_readwrite_paths=3 repeated string, block_git_writes=6 bool } — the shell frame's policy request. */
export function decodeSandboxPolicy(bytes): any {
	const reader = new Reader(bytes);
	const policy: any = { type: 0, networkAccess: false, additionalReadwritePaths: [] };
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 0) policy.type = reader.varint();
		else if (field === 2 && wireType === 0) policy.networkAccess = reader.varint() !== 0;
		else if (field === 3 && wireType === 2) policy.additionalReadwritePaths.push(reader.string());
		else if (field === 6 && wireType === 0) policy.blockGitWrites = reader.varint() !== 0;
		else reader.skip(wireType);
	}
	return policy;
}

/** Cursor SandboxPolicy.Type enum (CCursor gen/agent_v1_pb.ts:22718-22742). */
const CURSOR_SANDBOX_TYPES = Object.freeze({
	UNSPECIFIED: 0,
	INSECURE_NONE: 1,
	WORKSPACE_READWRITE: 2,
	WORKSPACE_READONLY: 3,
});

/** ShellArgs { command=1, working_directory=2, timeout=3 (MILLISECONDS), tool_call_id=4, requested_sandbox_policy=9, is_background=11, skip_approval=12, timeout_behavior=13 (0=UNSPECIFIED/1=CANCEL/2=BACKGROUND), hard_timeout=14, description=15 } — the streaming shell channel. */
export function decodeShellArgs(bytes): any {
	const reader = new Reader(bytes);
	const args = {
		command: "",
		workingDirectory: "",
		timeout: undefined,
		toolCallId: "",
		skipApproval: false,
		sandboxPolicy: undefined,
		isBackground: false,
		timeoutBehavior: 0,
		hardTimeout: undefined,
		description: undefined,
	};
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) args.command = reader.string();
		else if (field === 2 && wireType === 2) args.workingDirectory = reader.string();
		else if (field === 3 && wireType === 0) args.timeout = reader.varint();
		else if (field === 4 && wireType === 2) args.toolCallId = reader.string();
		else if (field === 9 && wireType === 2) args.sandboxPolicy = decodeSandboxPolicy(reader.bytes());
		else if (field === 11 && wireType === 0) args.isBackground = reader.varint() !== 0;
		else if (field === 12 && wireType === 0) args.skipApproval = reader.varint() !== 0;
		else if (field === 13 && wireType === 0) args.timeoutBehavior = reader.varint();
		else if (field === 14 && wireType === 0) args.hardTimeout = reader.varint();
		else if (field === 15 && wireType === 2) args.description = reader.string();
		else reader.skip(wireType);
	}
	return args;
}

/** BackgroundShellSpawnArgs { command=1, working_directory=2, tool_call_id=3, sandbox_policy=5, enable_write_shell_stdin_tool=6 } */
export function decodeBackgroundShellSpawnArgs(bytes): any {
	const reader = new Reader(bytes);
	const args = { command: "", workingDirectory: "", toolCallId: "", enableWriteShellStdinTool: false, sandboxPolicy: undefined };
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) args.command = reader.string();
		else if (field === 2 && wireType === 2) args.workingDirectory = reader.string();
		else if (field === 3 && wireType === 2) args.toolCallId = reader.string();
		else if (field === 5 && wireType === 2) args.sandboxPolicy = decodeSandboxPolicy(reader.bytes());
		else if (field === 6 && wireType === 0) args.enableWriteShellStdinTool = reader.varint() !== 0;
		else reader.skip(wireType);
	}
	return args;
}

/** WriteShellStdinArgs { shell_id=1, chars=2 } */
export function decodeWriteShellStdinArgs(bytes): any {
	const reader = new Reader(bytes);
	const args = { shellId: 0, chars: "" };
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 0) args.shellId = reader.varint();
		else if (field === 2 && wireType === 2) args.chars = reader.string();
		else reader.skip(wireType);
	}
	return args;
}

/**
 * ConversationStateStructure.todos (field 3, repeated bytes): each entry is a
 * JSON-serialized Cursor todo item ({id?, content, status, ...}).
 * @returns { present: boolean, items: object[] } — `present` distinguishes an
 * absent todos field (the model never wrote todos) from an empty list.
 */
export function decodeConversationStateTodos(bytes): any {
	const reader = new Reader(bytes);
	let present = false;
	const items = [];
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 3 && wireType === 2) {
			present = true;
			try {
				const item = JSON.parse(new TextDecoder().decode(reader.bytes()));
				if (item !== null && typeof item === "object") items.push(item);
			} catch {
				// A malformed entry is dropped; the rest still sync.
			}
		} else {
			reader.skip(wireType);
		}
	}
	return { present, items };
}

/**
 * ConversationStateStructure.token_details (field 5): Cursor's own context
 * meter (`used_tokens` / `max_tokens`). Present on checkpoint frames.
 */
export function decodeConversationTokenDetails(bytes): any {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 5 && wireType === 2) return decodeTokenDetailsMessage(reader.bytes());
		reader.skip(wireType);
	}
	return undefined;
}

/** ConversationTokenDetails { used_tokens=1, max_tokens=2, breakdown=3, ... }. */
function decodeTokenDetailsMessage(bytes): any {
	const reader = new Reader(bytes);
	const details: any = {};
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 0) details.usedTokens = reader.varint();
		else if (field === 2 && wireType === 0) details.maxTokens = reader.varint();
		else reader.skip(wireType);
	}
	return details;
}
//#endregion

//#region protobuf message parsers (agent.v1 subset)
const decoder = new TextDecoder();

function readTag(reader) {
	if (reader.done) return undefined;
	const { field, wireType } = reader.tag();
	return { field, wireType };
}

/** AgentServerMessage { interaction_update=1, exec_server_message=2, conversation_checkpoint_update=3, ... } */
export function decodeAgentServerMessage(bytes): any {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (wireType !== 2) {
			reader.skip(wireType);
			continue;
		}
		const payload = reader.bytes();
		if (field === 1) return { case: "interactionUpdate", value: decodeInteractionUpdate(payload) };
		if (field === 2) return { case: "execServerMessage", value: decodeExecServerMessage(payload) };
		if (field === 3) return { case: "conversationCheckpointUpdate", value: payload };
		if (field === 4) return { case: "kvServerMessage", value: decodeKvServerMessage(payload) };
		if (field === 5) return { case: "execServerControlMessage", value: payload };
		if (field === 7) return { case: "interactionQuery", value: decodeInteractionQuery(payload) };
	}
	return { case: "unknown", value: undefined };
}

function projectInteractionPayload(kind, payload) {
	if (kind === "textDelta") return { type: "textDelta", text: decodeTextDelta(payload) };
	if (kind === "thinkingDelta") return { type: "thinkingDelta", text: decodeTextDelta(payload) };
	if (kind === "tokenDelta") return { type: "tokenDelta", tokens: decodeTokenDelta(payload) };
	if (kind === "turnEnded") return { type: "turnEnded", ...decodeTurnEndedUpdate(payload) };
	if (kind === "toolCallStarted") return { type: "toolCallStarted", display: decodeToolCallDisplay(payload) };
	if (kind === "toolCallCompleted") return { type: "toolCallCompleted", display: decodeToolCallDisplay(payload) };
	if (kind === "partialToolCall") return { type: "partialToolCall", ...decodePartialToolCall(payload) };
	if (kind === "toolCallDelta") return { type: "toolCallDelta" };
	if (kind === "heartbeat") return { type: "heartbeat" };
	if (kind === "userMessageAppended") return { type: "userMessageAppended" };
	if (kind === "contextInjectionState") return { type: "contextInjectionState", ...decodeContextInjectionStateUpdate(payload) };
	if (kind === "summary") return { type: "summary", text: decodeSummaryUpdate(payload) };
	if (kind === "summaryStarted") return { type: "summaryStarted" };
	if (kind === "summaryCompleted") return { type: "summaryCompleted" };
	return { type: kind };
}

/** InteractionUpdate { text_delta=1, thinking_delta=4, token_delta=8, turn_ended=14, ... } */
export function decodeInteractionUpdate(bytes): any {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (wireType !== 2) {
			reader.skip(wireType);
			continue;
		}
		const payload = reader.bytes();
		const kind = oneofCaseByField(InteractionUpdate, field);
		if (kind) return projectInteractionPayload(kind, payload);
	}
	return { type: "unknown" };
}

/** ContextInjectionStateUpdate { injection_id=1, state=2 } */
export function decodeContextInjectionStateUpdate(bytes): any {
	const reader = new Reader(bytes);
	let injectionId = "";
	let state = "unknown";
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) injectionId = reader.string();
		else if (field === 2 && wireType === 2) state = decodeContextInjectionState(reader.bytes());
		else reader.skip(wireType);
	}
	return { injectionId, state };
}

/** ContextInjectionState oneof: queued=1, delivered=2, queued_for_next_turn=3, cancelled=4, rejected=5 */
function decodeContextInjectionState(bytes): any {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		reader.skip(wireType);
		if (field === 1) return "queued";
		if (field === 2) return "delivered";
		if (field === 3) return "queued_for_next_turn";
		if (field === 4) return "cancelled";
		if (field === 5) return "rejected";
	}
	return "unknown";
}

function decodeTextDelta(bytes): any {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) return reader.string();
		reader.skip(wireType);
	}
	return "";
}

/** TodoItem { id=1, content=2, status=3 } (TodoStatus: 0 UNSPECIFIED / 1 PENDING / 2 IN_PROGRESS / 3 COMPLETED / 4 CANCELLED) */
function decodeTodoItem(bytes): any {
	const reader = new Reader(bytes);
	const item = { id: "", content: "", status: 0 };
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) item.id = reader.string();
		else if (field === 2 && wireType === 2) item.content = reader.string();
		else if (field === 3 && wireType === 0) item.status = reader.varint();
		else reader.skip(wireType);
	}
	return item;
}

/** Todo success payload { todos=1 repeated TodoItem, total_count=2 int32 } */
function decodeTodoItemsList(bytes): any {
	const reader = new Reader(bytes);
	const items = [];
	let totalCount;
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) items.push(decodeTodoItem(reader.bytes()));
		else if (field === 2 && wireType === 0) totalCount = reader.varint();
		else reader.skip(wireType);
	}
	return { items, totalCount };
}

/** UpdateTodosToolCall { args=1, result=2 UpdateTodosResult { success=1 { todos=1, total_count=2 } / error=2 } } */
function decodeUpdateTodosCall(bytes): any {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 2 && wireType === 2) {
			const result = new Reader(reader.bytes());
			while (!result.done) {
				const tag = result.tag();
				if (tag.field === 1 && tag.wireType === 2) {
					const success = decodeTodoItemsList(result.bytes());
					return { kind: "update", todos: success.items, totalCount: success.totalCount, error: undefined };
				}
				if (tag.field === 2 && tag.wireType === 2) {
					const error = decodeErrorMessage(result.bytes());
					return { kind: "update", todos: undefined, totalCount: undefined, error };
				}
				result.skip(tag.wireType);
			}
			return undefined;
		}
		reader.skip(wireType);
	}
	return undefined;
}

/** ReadTodosToolCall { args=1 { status_filter=1, id_filter=2 }, result=2 ReadTodosResult { success=1 { todos=1, total_count=2 } / error=2 } } */
function decodeReadTodosCall(bytes): any {
	const reader = new Reader(bytes);
	let filtered = false;
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) {
			const args = new Reader(reader.bytes());
			while (!args.done) {
				const tag = args.tag();
				if (tag.field === 1 || tag.field === 2) filtered = true;
				args.skip(tag.wireType);
			}
		} else if (field === 2 && wireType === 2) {
			const result = new Reader(reader.bytes());
			while (!result.done) {
				const tag = result.tag();
				if (tag.field === 1 && tag.wireType === 2) {
					const success = decodeTodoItemsList(result.bytes());
					return { kind: "read", filtered, todos: success.items, totalCount: success.totalCount, error: undefined };
				}
				if (tag.field === 2 && tag.wireType === 2) {
					const error = decodeErrorMessage(result.bytes());
					return { kind: "read", filtered, todos: undefined, totalCount: undefined, error };
				}
				result.skip(tag.wireType);
			}
			return undefined;
		} else reader.skip(wireType);
	}
	return undefined;
}

/** WebSearchToolCall { args=1 { search_term=1, tool_call_id=2 }, result=2 { success=1 { references=1 repeated WebSearchReference{title=1,url=2,chunk=3} } / error=2 / rejected=3 } } */
function decodeWebSearchCall(bytes): any {
	const reader = new Reader(bytes);
	const call = { searchTerm: "", references: [], error: undefined };
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) {
			const args = new Reader(reader.bytes());
			while (!args.done) {
				const tag = args.tag();
				if (tag.field === 1 && tag.wireType === 2) call.searchTerm = args.string();
				else args.skip(tag.wireType);
			}
		} else if (field === 2 && wireType === 2) {
			const result = new Reader(reader.bytes());
			while (!result.done) {
				const tag = result.tag();
				if (tag.field === 1 && tag.wireType === 2) {
					const success = new Reader(result.bytes());
					while (!success.done) {
						const ref = success.tag();
						if (ref.field === 1 && ref.wireType === 2) {
							const reference = new Reader(success.bytes());
							const entry = { title: "", url: "", chunk: "" };
							while (!reference.done) {
								const r = reference.tag();
								if (r.field === 1 && r.wireType === 2) entry.title = reference.string();
								else if (r.field === 2 && r.wireType === 2) entry.url = reference.string();
								else if (r.field === 3 && r.wireType === 2) entry.chunk = reference.string();
								else reference.skip(r.wireType);
							}
							call.references.push(entry);
						} else success.skip(ref.wireType);
					}
				} else if (tag.field === 2 || tag.field === 3) {
					call.error = decodeErrorMessage(result.bytes());
				} else result.skip(tag.wireType);
			}
		} else reader.skip(wireType);
	}
	return call;
}

/** FetchToolCall { args=1 { url=1 }, result=2 { success=1 { url=1, content=2, status_code=3, content_type=4 } / error=2 } } */
function decodeFetchCall(bytes): any {
	const reader = new Reader(bytes);
	const call = { url: "", content: "", statusCode: 0, error: undefined };
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) {
			const args = new Reader(reader.bytes());
			while (!args.done) {
				const tag = args.tag();
				if (tag.field === 1 && tag.wireType === 2) call.url = args.string();
				else args.skip(tag.wireType);
			}
		} else if (field === 2 && wireType === 2) {
			const result = new Reader(reader.bytes());
			while (!result.done) {
				const tag = result.tag();
				if (tag.field === 1 && tag.wireType === 2) {
					const success = new Reader(result.bytes());
					while (!success.done) {
						const f = success.tag();
						if (f.field === 1 && f.wireType === 2) call.url = success.string();
						else if (f.field === 2 && f.wireType === 2) call.content = success.string();
						else if (f.field === 3 && f.wireType === 0) call.statusCode = success.varint();
						else success.skip(f.wireType);
					}
				} else if (tag.field === 2 && tag.wireType === 2) {
					call.error = decodeErrorMessage(result.bytes());
				} else result.skip(tag.wireType);
			}
		} else reader.skip(wireType);
	}
	return call;
}

/** Error variants share { error=1 } — the generic error text. */
function decodeErrorMessage(bytes): any {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) return reader.string();
		reader.skip(wireType);
	}
	return "unknown error";
}

/**
 * ToolCallCompletedUpdate / ToolCallStartedUpdate { call_id=1, tool_call=2
 * ToolCall, model_call_id=3 } — the DISPLAY frames for server-resolved tools.
 * Decodes the tool-call union cases the DSH renderers mirror: update_todos=9,
 * read_todos=10, web_search_tool_call=18, fetch_tool_call=24,
 * web_fetch_tool_call=37. Unknown cases return undefined (dropped).
 */
export function decodeToolCallDisplay(bytes): any {
	const reader = new Reader(bytes);
	let callId = "";
	let toolCall;
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) callId = reader.string();
		else if (field === 2 && wireType === 2) toolCall = Uint8Array.from(reader.bytes());
		else reader.skip(wireType);
	}
	if (toolCall === undefined) return undefined;
	const inner = new Reader(toolCall);
	while (!inner.done) {
		const tag = inner.tag();
		if (tag.wireType !== 2) {
			inner.skip(tag.wireType);
			continue;
		}
		const payload = inner.bytes();
		if (tag.field === 9) return { callId, name: "todo_write", displayKind: "update_todos", call: decodeUpdateTodosCall(payload) };
		if (tag.field === 10) return { callId, name: "todo_write", displayKind: "read_todos", call: decodeReadTodosCall(payload) };
		if (tag.field === 18) return { callId, name: "web_search", displayKind: "web_search", call: decodeWebSearchCall(payload) };
		if (tag.field === 24 || tag.field === 37) return { callId, name: "web_fetch", displayKind: "web_fetch", call: decodeFetchCall(payload) };
	}
	return undefined;
}

function decodeTokenDelta(bytes): any {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 0) return reader.varint();
		reader.skip(wireType);
	}
	return 0;
}

/**
 * TurnEndedUpdate { input_tokens=1, output_tokens=2, cache_read_tokens=3,
 * cache_write_tokens=4, reasoning_tokens=5 } — all optional int64.
 */
export function decodeTurnEndedUpdate(bytes): any {
	const reader = new Reader(bytes);
	const usage: any = {};
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (wireType === 0) {
			const value = reader.varint();
			if (field === 1) usage.inputTokens = value;
			else if (field === 2) usage.outputTokens = value;
			else if (field === 3) usage.cacheReadTokens = value;
			else if (field === 4) usage.cacheWriteTokens = value;
			else if (field === 5) usage.reasoningTokens = value;
		} else {
			reader.skip(wireType);
		}
	}
	return usage;
}

function finiteTokenCount(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Project Cursor's per-turn / checkpoint token fields onto DSH TokenUsage.
 *
 * DSH occupancy is `input + cacheRead + cacheWrite` of the last sample, then
 * plus the assistant surface of this step (`projectedTokens`). Cursor's own
 * meter is checkpoint `token_details.used_tokens` (post-response context).
 * Using `turn_ended`'s billed prompt+cache as the sample overcounts: cache
 * write often overlaps the prompt, and DSH then adds this step's assistant
 * on top. When `used_tokens` is present, the sample is that gauge minus this
 * step's output so the host projection lands back near Cursor's meter.
 */
export function projectCursorTokenUsage({ turnEnded, outputTokens = 0, tokenDetails }: any = {}) {
	const ended = turnEnded ?? {};
	const output = finiteTokenCount(ended.outputTokens) ?? (finiteTokenCount(outputTokens) ?? 0);
	const reasoning = finiteTokenCount(ended.reasoningTokens);
	const used = finiteTokenCount(tokenDetails?.usedTokens);
	if (used !== undefined && used > 0) {
		const inputTokens = Math.max(0, used - output);
		const usage: any = { inputTokens, outputTokens: output, totalTokens: used };
		if (reasoning !== undefined && reasoning > 0) usage.reasoningTokens = reasoning;
		return usage;
	}
	const input = finiteTokenCount(ended.inputTokens) ?? 0;
	const cacheRead = finiteTokenCount(ended.cacheReadTokens) ?? 0;
	// cache_write is billed cache-creation, not extra context. Folding it
	// into pressure made a first-turn write look like 2× the prompt.
	const usage: any = { inputTokens: input, outputTokens: output };
	if (cacheRead > 0) usage.cacheReadTokens = cacheRead;
	if (reasoning !== undefined && reasoning > 0) usage.reasoningTokens = reasoning;
	const total = input + output + cacheRead;
	if (total > 0) usage.totalTokens = total;
	return usage;
}

/** PartialToolCallUpdate { call_id=1, args_text_delta=3 } */
function decodePartialToolCall(bytes): any {
	const reader = new Reader(bytes);
	let callId = "";
	let argsTextDelta = "";
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) callId = reader.string();
		else if (field === 3 && wireType === 2) argsTextDelta = reader.string();
		else reader.skip(wireType);
	}
	return { callId, argsTextDelta };
}

/** KvServerMessage { id=1, get_blob_args=2 { blob_id=1 } | set_blob_args=3 { blob_id=1, blob_data=2 } } */
export function decodeKvServerMessage(bytes): any {
	const reader = new Reader(bytes);
	let id = 0;
	let blobId;
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 0) id = reader.varint();
		else if (field === 2 && wireType === 2) blobId = decodeBlobId(reader.bytes());
		else if (field === 3 && wireType === 2) {
			return { id, case: "setBlobArgs", ...decodeSetBlobArgs(reader.bytes()) };
		} else reader.skip(wireType);
	}
	return blobId === undefined ? { id, case: "unknown" } : { id, case: "getBlobArgs", blobId };
}

/** SetBlobArgs { blob_id=1, blob_data=2 } */
function decodeSetBlobArgs(bytes): any {
	const reader = new Reader(bytes);
	let blobId;
	let blobData;
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) blobId = reader.bytes();
		else if (field === 2 && wireType === 2) blobData = reader.bytes();
		else reader.skip(wireType);
	}
	return { blobId, blobData };
}

function decodeBlobId(bytes): any {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) return reader.bytes();
		reader.skip(wireType);
	}
	return undefined;
}

function oneofCaseByField(type, field) {
	for (const info of type.fields.list()) {
		if (info.no === field && info.oneof) return info.jsonName ?? info.name.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
	}
}

/** ExecServerMessage { id=1, exec_id=15, request_context_args=10, mcp_args=11, ... } */
export function decodeExecServerMessage(bytes): any {
	const reader = new Reader(bytes);
	let id = 0;
	let execId = "";
	let kind;
	let payload;
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 0) id = reader.varint();
		else if (field === 15 && wireType === 2) execId = reader.string();
		else if (wireType === 2) {
			const name = oneofCaseByField(ExecServerMessage, field);
			const data = reader.bytes();
			if (name && kind === undefined) {
				kind = name;
				payload = data;
			}
		} else reader.skip(wireType);
	}
	return projectExecServerMessage(id, execId, kind, payload);
}

function projectExecServerMessage(id, execId, kind, payload) {
	if (kind === undefined) return { id, execId, case: "unknown" };
	if (kind === "requestContextArgs") return { id, execId, case: "requestContextArgs" };
	if (kind === "mcpArgs") return { id, execId, case: "mcpArgs", args: decodeMcpArgs(payload), rawArgs: Uint8Array.from(payload) };
	if (kind === "shellArgs") return { id, execId, case: "shellArgs", path: decodeSinglePathArg(payload) };
	if (kind === "writeArgs") return { id, execId, case: "writeArgs", path: decodeSinglePathArg(payload), args: decodeWriteArgs(payload) };
	if (kind === "deleteArgs") return { id, execId, case: "deleteArgs", path: decodeSinglePathArg(payload), args: decodeDeleteArgs(payload) };
	if (kind === "grepArgs") return { id, execId, case: "grepArgs", args: decodeGrepArgs(payload) };
	if (kind === "readArgs") return { id, execId, case: "readArgs", path: decodeReadArgsPath(payload), args: decodeReadArgs(payload) };
	if (kind === "lsArgs") return { id, execId, case: "lsArgs", path: decodeSinglePathArg(payload) };
	if (kind === "diagnosticsArgs") return { id, execId, case: "diagnosticsArgs" };
	if (kind === "shellStreamArgs") return { id, execId, case: "shellStreamArgs", path: decodeSinglePathArg(payload), args: decodeShellArgs(payload), rawArgs: Uint8Array.from(payload) };
	if (kind === "backgroundShellSpawnArgs") return { id, execId, case: "backgroundShellSpawnArgs", args: decodeBackgroundShellSpawnArgs(payload), rawArgs: Uint8Array.from(payload) };
	if (kind === "listMcpResourcesExecArgs") return { id, execId, case: "listMcpResourcesExecArgs" };
	if (kind === "readMcpResourceExecArgs") return { id, execId, case: "readMcpResourceExecArgs" };
	if (kind === "fetchArgs") return { id, execId, case: "fetchArgs", url: decodeFetchUrl(payload) };
	if (kind === "recordScreenArgs") return { id, execId, case: "recordScreenArgs" };
	if (kind === "computerUseArgs") return { id, execId, case: "computerUseArgs" };
	if (kind === "writeShellStdinArgs") return { id, execId, case: "writeShellStdinArgs", args: decodeWriteShellStdinArgs(payload), rawArgs: Uint8Array.from(payload) };
	return { id, execId, case: kind };
}

function decodeSinglePathArg(bytes): any {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) return reader.string();
		reader.skip(wireType);
	}
	return "";
}

function decodeReadArgsPath(bytes): any {
	return decodeSinglePathArg(bytes);
}

function decodeFetchUrl(bytes): any {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) return reader.string();
		reader.skip(wireType);
	}
	return "";
}

/** McpArgs { name=1, args=2 (map<string,bytes>), tool_call_id=3, provider_identifier=4, tool_name=5 } */
export function decodeMcpArgs(bytes): any {
	const reader = new Reader(bytes);
	let name = "";
	let toolCallId = "";
	let providerIdentifier = "";
	let toolName = "";
	const args: any = {};
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) name = reader.string();
		else if (field === 2 && wireType === 2) {
			const entry = new Reader(reader.bytes());
			let key = "";
			let value;
			while (!entry.done) {
				const tag = entry.tag();
				if (tag.field === 1 && tag.wireType === 2) key = entry.string();
				else if (tag.field === 2 && tag.wireType === 2) value = entry.bytes();
				else entry.skip(tag.wireType);
			}
			if (key) args[key] = value;
		} else if (field === 3 && wireType === 2) toolCallId = reader.string();
		else if (field === 4 && wireType === 2) providerIdentifier = reader.string();
		else if (field === 5 && wireType === 2) toolName = reader.string();
		else reader.skip(wireType);
	}
	return { name, toolCallId, providerIdentifier, toolName, args };
}

/** GetUsableModelsResponse { models = 1: repeated ModelDetails } */
export function decodeUsableModels(bytes): any {
	const models = [];
	for (const model of GetUsableModelsResponse.fromBinary(bytes).models ?? []) {
		const id = model.modelId || model.displayModelId;
		if (!id) continue;
		models.push({
			id,
			displayModelId: model.displayModelId || undefined,
			name: model.displayName || undefined,
			displayNameShort: model.displayNameShort || undefined,
		});
	}
	return models;
}

/** NameAgentRequest { string user_message = 1 } */
export function encodeNameAgentRequest(userMessage) {
	return new NameAgentRequest({ userMessage: userMessage ?? "" }).toBinary();
}

/** NameAgentResponse { string name = 1 } */
export function decodeNameAgentResponse(bytes): any {
	return NameAgentResponse.fromBinary(bytes).name ?? "";
}

/**
 * Pull the first human `text` out of a DSH session-title-llm framed prompt,
 * or return the raw text when the caller did not frame it.
 */
export function unwrapSessionTitleFrame(text) {
	const trimmed = typeof text === "string" ? text.trim() : "";
	if (trimmed.length === 0) return "";
	let payload = trimmed;
	if (trimmed.startsWith(DSH_SESSION_TITLE_FRAME_PREFIX)) {
		payload = trimmed.slice(DSH_SESSION_TITLE_FRAME_PREFIX.length).trim();
	}
		if (payload.startsWith("[")) {
		try {
			const parsed = JSON.parse(payload);
			if (Array.isArray(parsed)) {
				for (const item of parsed) {
					if (item !== null && typeof item === "object" && typeof item.text === "string" && item.text.trim().length > 0) {
						return item.text;
					}
				}
			}
		} catch {
			// Malformed JSON after the prefix is sent as the raw prompt.
		}
	}
	return trimmed;
}

/** First non-empty user text from a title GenerateOptions, unwrapped if framed. */
export function extractSessionTitleUserMessage(options) {
	for (const message of options.messages ?? []) {
		if (message.role !== "user") continue;
		const content = Array.isArray(message.content) ? message.content : [];
		const text = content
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");
		const userMessage = unwrapSessionTitleFrame(text);
		if (userMessage.length > 0) return userMessage;
	}
	return "";
}

/** ModelDetails { model_id=1, display_model_id=3, display_name=4, display_name_short=5, aliases=6 } */
function decodeModelDetails(bytes): any {
	const reader = new Reader(bytes);
	const model: any = { id: "", name: "" };
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (wireType === 2) {
			if (field === 1) model.id = reader.string();
			else if (field === 3) model.displayModelId = reader.string();
			else if (field === 4) model.name = reader.string();
			else if (field === 5) model.displayNameShort = reader.string();
			else if (field === 6) reader.bytes(); // aliases
			else reader.bytes();
		} else {
			reader.skip(wireType);
		}
	}
	return model;
}
