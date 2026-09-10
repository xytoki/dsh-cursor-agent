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
import { encodeValue, decodeValue, Reader, Writer } from "./proto";
import {
	catalogFromAvailableModels,
	decodeAvailableModels,
	encodeAvailableModelsRequest,
	encodeRequestedModel,
	FALLBACK_CONTEXT_WINDOW,
	inputModalitiesFromCatalog,
	reasoningFromCatalogEntry,
	resolveCursorModelSelection,
} from "./models";
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
} from "./exec-plane";
import {
	failCursorJoin,
	openCursorJoin,
	settleCursorJoin,
} from "./joins";
import { registerCursorShims } from "./shims";
import { collectCursorRules, encodeCursorRule, mergeDshSystemRule } from "./rules";
import {
	collectImageBlocks,
	contentHasImages,
	encodeSelectedContext,
	formatImageReadJoinText,
	resolveSelectedImages,
} from "./images";
import { CHECKPOINT_OBJECTS_SEGMENTS, createCheckpointStore, createLocalObjectStore } from "./checkpoint-store";
import {
	CURSOR_CHECKPOINT_SCHEMA_VERSION,
	appendCursorCheckpointEvent,
	listCursorCheckpointEvents,
	pickCursorCheckpointEvent,
} from "./checkpoint-log";
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
} from "./compaction";

export { createStreamBlocks, emitToolCall } from "./stream";
import { createStreamBlocks, emitToolCall } from "./stream";
export { nativeFetch } from "./fetch";
import { nativeFetch } from "./fetch";
export { name, inject, PROVIDER, CREDENTIAL_REF, CHANNEL, CURSOR_BASE_URL, CURSOR_LOGIN_URL, CURSOR_AUTH_ORIGIN, CURSOR_POLL_PATH, CURSOR_REFRESH_PATH, CURSOR_RUN_PATH, CURSOR_MODELS_PATH, CURSOR_NAME_AGENT_PATH, CURSOR_AVAILABLE_MODELS_PATH, DSH_SESSION_TITLE_FRAME_PREFIX, CURSOR_DASHBOARD_SERVICE, CURSOR_DASHBOARD_RPC, CURSOR_GET_ME_PATH, CURSOR_GET_PLAN_INFO_PATH, CURSOR_GET_CURRENT_PERIOD_USAGE_PATH, CURSOR_GET_SAND_USAGE_STATUS_PATH, USAGE_TTL_MS, CURSOR_CLIENT_VERSION, HEARTBEAT_INTERVAL_MS, STREAM_IDLE_TIMEOUT_MS, STREAM_PROGRESS_TIMEOUT_MS, SESSION_STATE_TTL_MS, MAX_TOOL_ROUNDS, DEFAULT_RETRY_COUNT, DEFAULT_RETRY_INTERVAL_MS, DEFAULT_RETRY_HTTP_STATUS_CODES, PARKED_BRIDGE_TIMEOUT_MS, SETTINGS_NAMESPACE, CURSOR_PRESET_ID, DEFAULT_REQUIRE_CURSOR_PRESET, REFRESH_AHEAD_MS, DEFAULT_TOKEN_LIFETIME_MS, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, CURSOR_NATIVE_TOOL_NAMES, isCursorNativeTool, FALLBACK_MODELS, CURSOR_AGENT_DEBUG_ENV, isCursorAgentDebugEnabled, cursorAgentDebug } from "./constants";
import { name, inject, PROVIDER, CREDENTIAL_REF, CHANNEL, CURSOR_BASE_URL, CURSOR_LOGIN_URL, CURSOR_AUTH_ORIGIN, CURSOR_POLL_PATH, CURSOR_REFRESH_PATH, CURSOR_RUN_PATH, CURSOR_MODELS_PATH, CURSOR_NAME_AGENT_PATH, CURSOR_AVAILABLE_MODELS_PATH, DSH_SESSION_TITLE_FRAME_PREFIX, CURSOR_DASHBOARD_SERVICE, CURSOR_DASHBOARD_RPC, CURSOR_GET_ME_PATH, CURSOR_GET_PLAN_INFO_PATH, CURSOR_GET_CURRENT_PERIOD_USAGE_PATH, CURSOR_GET_SAND_USAGE_STATUS_PATH, USAGE_TTL_MS, CURSOR_CLIENT_VERSION, HEARTBEAT_INTERVAL_MS, STREAM_IDLE_TIMEOUT_MS, STREAM_PROGRESS_TIMEOUT_MS, SESSION_STATE_TTL_MS, MAX_TOOL_ROUNDS, DEFAULT_RETRY_COUNT, DEFAULT_RETRY_INTERVAL_MS, DEFAULT_RETRY_HTTP_STATUS_CODES, PARKED_BRIDGE_TIMEOUT_MS, SETTINGS_NAMESPACE, CURSOR_PRESET_ID, DEFAULT_REQUIRE_CURSOR_PRESET, REFRESH_AHEAD_MS, DEFAULT_TOKEN_LIFETIME_MS, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, CURSOR_NATIVE_TOOL_NAMES, isCursorNativeTool, FALLBACK_MODELS, cursorAgentDebug } from "./constants";
export { Config, resolveCursorSettings, resolveCursorApiBaseUrl, shouldRetryHttpStatus, isSuccessfulAgentResponse, abortableDelay } from "./settings";
import { Config, resolveCursorSettings, shouldRetryHttpStatus, isSuccessfulAgentResponse, abortableDelay } from "./settings";
export { CursorCredentialStore, classifyCursorSecret, getTokenExpiry, readJwtExpiry, maskApiKey, buildLoginUrl, assertCursorAuthUrl, commandForCursorAuthUrl, openCursorAuthUrl, CursorAuthService, CursorLoginCoordinator, createCursorRpcHandler, createCursorRpcHttpHandler } from "./auth";
import { CursorCredentialStore, getTokenExpiry, maskApiKey, buildLoginUrl, assertCursorAuthUrl, commandForCursorAuthUrl, openCursorAuthUrl, CursorAuthService, CursorLoginCoordinator, createCursorRpcHandler, createCursorRpcHttpHandler } from "./auth";
export { storeBlob, encodeResumeAction, encodeConversationActionMessage, encodeUserContextInjection, encodeSystemContextInjection, encodeInjectContextAction, encodeAsyncAskQuestionCompletionAction, encodeMcpToolCallStep, encodeReplayTurnBlob, appendTurnsToCheckpoint, encodeGetBlobResult, adoptBlobStore, encodeKvClientMessage, encodeSetBlobResult, encodeMcpResult, encodeExecClientMessage, encodeExecClientMessageEnvelope, encodeRequestContextResult, encodeMcpToolDefinition, encodeWriteRejected, encodeDeleteRejected, encodeWriteShellStdinError, encodeWriteShellStdinSuccess, encodeShellStreamStart, encodeShellStreamStdout, encodeShellStreamStderr, encodeOutputLocation, encodeShellStreamExit, encodeShellStreamBackgrounded, encodeShellSuccess, encodeShellFailure, encodeShellTimeout, encodeShellSpawnError, encodeShellPermissionDenied, encodeBackgroundShellSpawnSuccess, encodeBackgroundShellSpawnError, encodeReadSuccess, encodeReadError, encodeReadFileNotFound, encodeReadInvalidFile, encodeWriteSuccess, encodeWriteError, encodeInteractionResponseEnvelope, encodeExecStreamClose, encodeExecThrow, encodeAskQuestionSuccess, encodeAskQuestionResultSuccess, encodeAskQuestionResultError, encodeAskQuestionInteractionResponse, buildAskQuestionResultBytes, encodeInteractionApproved, encodeInteractionRejected, INTERACTION_UNAVAILABLE, rejectionForInteraction, normalizeCursorTodos, decodeAskQuestionInteractionQuery, decodeInteractionQuery, decodeReadArgs, decodeWriteArgs, decodeGrepArgs, decodeDeleteArgs, decodeSandboxPolicy, decodeShellArgs, decodeBackgroundShellSpawnArgs, decodeWriteShellStdinArgs, decodeConversationStateTodos, decodeConversationTokenDetails, decodeAgentServerMessage, decodeInteractionUpdate, decodeContextInjectionStateUpdate, decodeToolCallDisplay, decodeTurnEndedUpdate, projectCursorTokenUsage, decodeKvServerMessage, decodeExecServerMessage, decodeMcpArgs, decodeUsableModels, encodeNameAgentRequest, decodeNameAgentResponse, unwrapSessionTitleFrame, extractSessionTitleUserMessage } from "./wire/codec";
import { storeBlob, encodeResumeAction, encodeConversationActionMessage, encodeUserContextInjection, encodeSystemContextInjection, encodeInjectContextAction, encodeAsyncAskQuestionCompletionAction, encodeMcpToolCallStep, encodeReplayTurnBlob, appendTurnsToCheckpoint, encodeGetBlobResult, adoptBlobStore, encodeKvClientMessage, encodeSetBlobResult, encodeMcpResult, encodeExecClientMessage, encodeExecClientMessageEnvelope, encodeRequestContextResult, encodeMcpToolDefinition, encodeWriteRejected, encodeDeleteRejected, encodeWriteShellStdinError, encodeWriteShellStdinSuccess, encodeShellStreamStart, encodeShellStreamStdout, encodeShellStreamStderr, encodeOutputLocation, encodeShellStreamExit, encodeShellStreamBackgrounded, encodeShellSuccess, encodeShellFailure, encodeShellTimeout, encodeShellSpawnError, encodeShellPermissionDenied, encodeBackgroundShellSpawnSuccess, encodeBackgroundShellSpawnError, encodeReadSuccess, encodeReadError, encodeReadFileNotFound, encodeReadInvalidFile, encodeWriteSuccess, encodeWriteError, encodeInteractionResponseEnvelope, encodeExecStreamClose, encodeExecThrow, encodeAskQuestionSuccess, encodeAskQuestionResultSuccess, encodeAskQuestionResultError, encodeAskQuestionInteractionResponse, buildAskQuestionResultBytes, encodeInteractionApproved, encodeInteractionRejected, INTERACTION_UNAVAILABLE, rejectionForInteraction, normalizeCursorTodos, decodeAskQuestionInteractionQuery, decodeInteractionQuery, decodeReadArgs, decodeWriteArgs, decodeGrepArgs, decodeDeleteArgs, decodeSandboxPolicy, decodeShellArgs, decodeBackgroundShellSpawnArgs, decodeWriteShellStdinArgs, decodeConversationStateTodos, decodeConversationTokenDetails, decodeAgentServerMessage, decodeInteractionUpdate, decodeContextInjectionStateUpdate, decodeToolCallDisplay, decodeTurnEndedUpdate, projectCursorTokenUsage, decodeKvServerMessage, decodeExecServerMessage, decodeMcpArgs, decodeUsableModels, encodeNameAgentRequest, decodeNameAgentResponse, unwrapSessionTitleFrame, extractSessionTitleUserMessage } from "./wire/codec";
export { frameEncode, CONNECT_END_STREAM_FLAG, CONNECT_COMPRESSED_FLAG, MAX_CONNECT_FRAME_BYTES, ConnectFrameReader, AGENT_HEADERS } from "./wire/frames";
import { frameEncode, CONNECT_END_STREAM_FLAG, CONNECT_COMPRESSED_FLAG, MAX_CONNECT_FRAME_BYTES, ConnectFrameReader, AGENT_HEADERS } from "./wire/frames";
export { splitShellDelta, BACKGROUND_PID_MARKER, BACKGROUND_PID_PROLOGUE, createPidProbe, formatCursorTerminalHeader, formatCursorTerminalFooter, createCursorTerminalLog, parseJobIdN } from "./exec/shell";
import { splitShellDelta, BACKGROUND_PID_MARKER, BACKGROUND_PID_PROLOGUE, createPidProbe, formatCursorTerminalHeader, formatCursorTerminalFooter, createCursorTerminalLog, parseJobIdN } from "./exec/shell";
export { classifyCursorSearch, encodeGrepSearchResult, searchMetaFromResult, searchResultSummary, encodeDeleteSuccess, encodeDeleteError, encodeWritePermissionDenied, encodeDeletePermissionDenied, READ_CONTENT_CHAR_CAP, readPresentationMeta, formatReadJoinText, composeReadWindow, EXEC_REPLY_FIELDS } from "./exec/search";
import { classifyCursorSearch, encodeGrepSearchResult, searchMetaFromResult, searchResultSummary, encodeDeleteSuccess, encodeDeleteError, encodeWritePermissionDenied, encodeDeletePermissionDenied, READ_CONTENT_CHAR_CAP, readPresentationMeta, formatReadJoinText, composeReadWindow, EXEC_REPLY_FIELDS } from "./exec/search";
export { translateNativeExec } from "./exec/translate";
import { translateNativeExec } from "./exec/translate";
export { rejectionFor } from "./exec/rejection";
import { rejectionFor } from "./exec/rejection";
export { decodeCurrentPeriodUsage, decodeSandUsageStatus, decodeGetMe, decodeGetPlanInfo, projectCurrentPeriodUsage, projectSandUsageStatus, projectGetMe, projectGetPlanInfo, callDashboardRpc, CursorUsageReader } from "./usage";
import { decodeCurrentPeriodUsage, decodeSandUsageStatus, decodeGetMe, decodeGetPlanInfo, projectCurrentPeriodUsage, projectSandUsageStatus, projectGetMe, projectGetPlanInfo, callDashboardRpc, CursorUsageReader } from "./usage";
export { parseEndStream, classifyCursorError, finishChunkForStreamError } from "./errors";
import { parseEndStream, classifyCursorError, finishChunkForStreamError } from "./errors";
export { parseCursorWebSearchChunk, displayJoinResult, rememberDisplayCompletion, bindDisplayCallId, rendererToolArgs } from "./display";
import { parseCursorWebSearchChunk, displayJoinResult, rememberDisplayCompletion, bindDisplayCallId, rendererToolArgs as mapRendererToolArgs } from "./display";
import {
	encodeHeartbeat,
	encodeUserMessage,
	encodeAssistantStep,
	encodeAgentTurn,
	encodeTurnStructure,
	encodeModelDetails,
	encodeUserMessageAction,
	encodeConversationState,
	encodeRunRequest,
	encodeRunMessage,
} from "./wire/codec";

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AgentRun {
	accessToken: any;
	baseUrl: any;
	session: any;
	frames: any;
	responseStatus: any;
	responseContentType: any;
	trailers: any;
	finished: any;
	originalRequestId: any;
	responsePromise: any;
	resolveResponse: any;
	rejectResponse: any;
	stream: any;
	heartbeat: any;

	constructor(accessToken, options: any = {}) {
		this.accessToken = accessToken;
		this.baseUrl = options.baseUrl ?? CURSOR_BASE_URL;
		this.session = undefined;
		this.frames = new ConnectFrameReader();
		this.responseStatus = undefined;
		this.responseContentType = undefined;
		this.trailers = {};
		this.finished = false;
	}

	async start() {
		const url = new URL(CURSOR_RUN_PATH, this.baseUrl);
		const requestId = randomUUID();
		const headers = {
			":method": "POST",
			":path": url.pathname,
			authorization: `Bearer ${this.accessToken}`,
			...AGENT_HEADERS,
			"x-request-id": requestId,
			"x-original-request-id": this.originalRequestId ?? requestId,
		};
		this.responsePromise = new Promise((resolve, reject) => {
			this.resolveResponse = resolve;
			this.rejectResponse = reject;
		});
		// The original promise remains rejectable for waitForResponse(); this
		// observer only prevents a close-before-wait race from becoming unhandled.
		void this.responsePromise.catch(() => {});
		this.session = http2.connect(this.baseUrl);
		this.stream = this.session.request(headers);
		// NOTE: never call stream.setEncoding() here — Node's setEncoding(null)
		// still decodes binary frames as UTF-8, corrupting any non-UTF-8 byte
		// (e.g. blob ids) into U+FFFD replacement characters.
		this.stream.on("response", (headers) => {
			this.responseStatus = Number(headers[":status"]);
			this.responseContentType = typeof headers["content-type"] === "string" ? headers["content-type"] : undefined;
			this.#resolveResponse(this.responseStatus);
		});
		this.stream.on("data", (chunk) => this.frames.push(Buffer.from(chunk)));
		this.stream.on("trailers", (trailers) => {
			this.trailers = trailers;
		});
		this.stream.on("end", () => this.frames.finish());
		this.stream.on("close", () => {
			if (this.responseStatus === undefined) this.#rejectResponse(new Error("Cursor HTTP stream closed before response"));
		});
		this.stream.on("error", (error) => {
			this.#rejectResponse(error);
			this.frames.fail(error);
		});
		this.session.on("error", (error) => {
			this.#rejectResponse(error);
			this.frames.fail(error);
		});
	}

	#resolveResponse(status) {
		const resolve = this.resolveResponse;
		this.resolveResponse = undefined;
		this.rejectResponse = undefined;
		resolve?.(status);
	}

	#rejectResponse(error) {
		const reject = this.rejectResponse;
		this.resolveResponse = undefined;
		this.rejectResponse = undefined;
		reject?.(error);
	}

	waitForResponse(timeoutMs) {
		if (this.responsePromise === undefined) throw new Error("Cursor AgentRun has not started");
		if (timeoutMs === undefined) return this.responsePromise;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Cursor HTTP response timeout")), timeoutMs);
			timer.unref?.();
			this.responsePromise.then(resolve, reject).finally(() => clearTimeout(timer));
		});
	}

	write(payload) {
		if (this.finished || this.stream === undefined || this.stream.destroyed) return false;
		try {
			this.stream.write(Buffer.from(payload));
			return true;
		} catch {
			return false;
		}
	}

	writeMessage(bytes) {
		return this.write(frameEncode(bytes));
	}

	startHeartbeat() {
		this.heartbeat = setInterval(() => {
			this.writeMessage(encodeHeartbeat());
		}, HEARTBEAT_INTERVAL_MS);
		this.heartbeat.unref?.();
	}

	/** Fail the run with a terminal error and tear down the connection. */
	abort(error) {
		if (this.finished) return;
		this.#rejectResponse(error);
		this.frames.fail(error);
		this.close();
	}

	close() {
		if (this.finished) return;
		this.#rejectResponse(new Error("Cursor AgentRun closed before response"));
		this.finished = true;
		if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
		if (!this.frames.ended) this.frames.finish();
		try {
			this.stream?.close();
		} catch {}
		// Force-destroy the session so no socket keeps the process alive after a
		// completed run; the agent response is fully consumed by then.
		try {
			this.session.destroy();
		} catch {}
	}
}

//#endregion

//#region agent pump
/**
 * A background frame pump owning one live AgentRun across `stream()` calls.
 *
 * The Cursor protocol expects a client whose frame-processing loop never
 * stops while the run is open: housekeeping requests (KV blobs, request
 * context, interaction approvals) must be answered as they arrive, even while
 * DSH executes a tool between two `stream()` invocations. The pump keeps
 * reading and answering for the run's whole lifetime; content frames
 * (checkpoints, updates, exec calls, question queries) are routed to the
 * consumer queue the active `stream()` drains.
 */
/**
 * Split a ShellProcess output delta on the shell service's stderr marker
 * (`\n[stderr]\n`, bash-local/src/index.ts:304). Segments before the first
 * marker are stdout; everything after is stderr (a delta may carry several
 * stderr sections — they re-join as stderr text).
 */
export class CursorRunPump {
	run: any;
	persisted: any;
	sessionKey: any;
	mcpTools: any;
	parkedTimeoutMs: any;
	syncTodos: any;
	debug: any;
	shellService: any;
	jobs: any;
	terminalsFolder: any;
	sessionCwd: any;
	sandboxPolicy: any;
	agent: any;
	generationId: any;
	systemText: any;
	attachments: any;
	persistCheckpoint: any;
	summarizeKeepTail: any;
	summaryBuffer: any;
	summarySeen: any;
	injectedIds: any;
	inboxDispose: any;
	stopped: any;
	terminalError: any;
	bridge: any;
	blobStore: any;
	activityHook: any;
	consumerFrames: any;
	consumerWaiters: any;
	parkedTimer: any;

	constructor({ run, persisted, sessionKey, mcpTools, parkedTimeoutMs, syncTodos, debug, shellService, jobs, terminalsFolder, sessionCwd, sandboxPolicy, agent, systemText, generationId, attachments, persistCheckpoint }: any) {
		this.run = run;
		this.persisted = persisted;
		this.sessionKey = sessionKey;
		this.mcpTools = mcpTools;
		this.parkedTimeoutMs = parkedTimeoutMs;
		this.syncTodos = syncTodos;
		this.debug = debug;
		this.shellService = shellService;
		this.jobs = jobs;
		this.terminalsFolder = terminalsFolder;
		this.sessionCwd = sessionCwd;
		this.sandboxPolicy = sandboxPolicy;
		this.agent = agent;
		this.generationId = generationId ?? persisted?.generationId;
		this.systemText = systemText ?? "";
		this.attachments = attachments;
		this.persistCheckpoint = persistCheckpoint;
		/** false = manual /summarize (no DSH tail); true = Cursor auto-compact. */
		this.summarizeKeepTail = true;
		this.summaryBuffer = "";
		this.summarySeen = false;
		this.injectedIds = new Set();
		this.inboxDispose = undefined;
		this.stopped = false;
		this.terminalError = undefined;
		this.bridge = undefined;
		this.blobStore = new Map();
		this.activityHook = undefined;
		this.consumerFrames = [];
		this.consumerWaiters = [];
		this.parkedTimer = undefined;
		this.#bindInbox();
		// A server RST after the response headers never surfaces through
		// AgentRun (its `close` handler only guards the pre-response window),
		// so the pump owns post-response close detection.
		this.run.stream?.once?.("close", () => {
			if (!this.stopped && this.run.responseStatus !== undefined && !this.run.frames.ended) {
				this.#terminate(new Error("Cursor agent stream closed unexpectedly"));
			}
		});
		void this.#loop();
	}

	/** The consumer side of the routed frame queue: yields frames until the run ends. */
	async next() {
		for (;;) {
			if (this.consumerFrames.length > 0) return this.consumerFrames.shift();
			if (this.terminalError !== undefined) throw this.terminalError;
			if (this.stopped) return undefined;
			// The pump resolves this waiter with the routed frame, or with no
			// value on termination (the loop then re-checks terminal state).
			const frame = await new Promise((resolve, reject) => this.consumerWaiters.push({ resolve, reject }));
			if (frame !== undefined) return frame;
		}
	}

	/** Push a frame back so the next `stream()` sees the next-round content. */
	unread(frame) {
		if (frame === undefined) return;
		this.consumerFrames.unshift(frame);
	}

	/**
	 * A stream() started consuming; cancel the parked hard cap if armed and
	 * drop the previous bridge so a finished resume cannot re-arm its cap.
	 */
	attach() {
		this.bridge = undefined;
		this.#clearParkedTimer();
	}

	/**
	 * A stream() stopped consuming. If a bridge with pending MCP work was
	 * stored, arm the parked hard cap; it fires silently (no error replies —
	 * late results are delivered through the replay path instead).
	 */
	detach() {
		if (this.bridge === undefined || this.bridge.pendingExecs.length === 0) return;
		// Native exec calls finish in seconds; only pure-MCP parks are capped,
		// because their late results have a protocol-native replay channel.
		if (!this.bridge.pendingExecs.every((entry) => entry.kind === "mcp")) return;
		this.#clearParkedTimer();
		this.parkedTimer = setTimeout(() => {
			this.parkedTimer = undefined;
			if (this.stopped) return;
			this.debug(`parked bridge timeout after ${this.parkedTimeoutMs}ms: closing run (late results will replay)`);
			this.#terminate(new Error("Cursor parked bridge timeout"));
		}, this.parkedTimeoutMs);
		this.parkedTimer.unref?.();
	}

	/** Stop the pump and tear the run down; idempotent, safe on any path. */
	terminate(error) {
		this.#terminate(error);
	}

	#terminate(error) {
		if (this.stopped) return;
		this.stopped = true;
		this.terminalError = error;
		this.#clearParkedTimer();
		this.#unbindInbox();
		this.#failOpenDisplayJoins(error);
		for (const waiter of this.consumerWaiters.splice(0)) waiter.resolve();
		try {
			this.run.close();
		} catch {}
	}

	#failOpenDisplayJoins(error) {
		const detail = error instanceof Error && error.message.length > 0 ? error.message : "";
		const text = detail.length > 0
			? `Cursor run ended before this tool completed: ${detail}`
			: "Cursor run ended before this tool completed";
		for (const id of this.persisted?.displayCallIds?.values() ?? []) {
			settleCursorJoin(id, { text, isError: true });
		}
	}

	#bindInbox() {
		const ctx = this.agent?.ctx;
		if (ctx === undefined || typeof ctx.on !== "function") return;
		try {
			this.inboxDispose = ctx.on("agent/inbox/inserted", (payload) => {
				const message = payload?.message;
				if (message === undefined || this.stopped) return;
				if (this.#isFollowup(message)) return;
				void this.injectDshMessage(message);
			});
		} catch (error) {
			this.debug(`inbox bind failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#unbindInbox() {
		try {
			this.inboxDispose?.();
		} catch {}
		this.inboxDispose = undefined;
	}

	#isFollowup(message) {
		const nextTurn = this.agent?.inbox?.nextTurn;
		if (!Array.isArray(nextTurn) || message?.id === undefined) return false;
		return nextTurn.some((entry) => entry.id === message.id);
	}

	/**
	 * Mid-run steer (`user_context`) or plugin inject (`system_context`).
	 * Deduped by message id so inbox events and the next `stream()` agree.
	 */
	async injectDshMessage(message) {
		if (this.stopped || message == null) return false;
		if (isToolResultMessage(message)) return false;
		const text = flattenBlocks(message.content).trim();
		const imageBlocks = message.source?.kind === "plugin" ? [] : collectImageBlocks([message]);
		if (text.length === 0 && imageBlocks.length === 0) return false;
		const id = typeof message.id === "string" ? message.id : "";
		const imageKey = imageBlocks.map((block) => block.attachment?.attachmentId).filter(Boolean).join(",");
		const key = id.length > 0 ? id : (text.length > 0 ? `anon:${text}` : `anon-img:${imageKey}`);
		if (this.injectedIds.has(key)) return false;
		this.injectedIds.add(key);
		let images = [];
		if (imageBlocks.length > 0) {
			try {
				images = await resolveSelectedImages(imageBlocks, this.attachments?.());
			} catch (error) {
				this.debug(`inject images failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const injectionId = randomUUID();
		const action = message.source?.kind === "plugin"
			? encodeInjectContextAction({
				injectionId,
				expectedRunId: this.generationId,
				systemContext: { producer: String(message.source.plugin ?? "plugin"), content: text },
			})
			: encodeInjectContextAction({
				injectionId,
				expectedRunId: this.generationId,
				userContext: { text, messageId: id.length > 0 ? id : randomUUID(), images },
			});
		const ok = this.run.writeMessage(encodeConversationActionMessage(action));
		this.debug(`inject ${message.source?.kind === "plugin" ? "system" : "user"} key=${key} images=${images.length} ok=${ok}`);
		return ok;
	}

	/** Send every current-turn ingress that is not already on the wire. */
	async injectTurnIngress(ingress, { includeUsers = false } : any = {}) {
		if (includeUsers) {
			for (const entry of ingress.users ?? []) await this.injectDshMessage(entry.message);
		}
		for (const entry of ingress.injections ?? []) await this.injectDshMessage(entry.message);
	}

	#clearParkedTimer() {
		if (this.parkedTimer !== undefined) {
			clearTimeout(this.parkedTimer);
			this.parkedTimer = undefined;
		}
	}

	#route(frame) {
		if (this.consumerWaiters.length > 0) {
			const waiter = this.consumerWaiters.shift();
			waiter.resolve(frame);
		} else {
			this.consumerFrames.push(frame);
		}
	}

	#answerKv(kv) {
		if (kv.case === "getBlobArgs") {
			const key = Buffer.from(kv.blobId).toString("hex");
			const blob = this.blobStore.get(key);
			this.debug(`pump kv getBlob ${key.slice(0, 16)}… hit=${blob !== undefined} bytes=${blob?.length ?? 0}`);
			this.run.writeMessage(encodeKvClientMessage(encodeGetBlobResult(kv.id, blob)));
		} else if (kv.case === "setBlobArgs") {
			if (kv.blobId !== undefined && kv.blobData !== undefined) {
				const key = Buffer.from(kv.blobId).toString("hex");
				const data = Uint8Array.from(kv.blobData);
				this.blobStore.set(key, data);
				this.persisted.blobs.set(key, data);
			}
			this.run.writeMessage(encodeKvClientMessage(encodeSetBlobResult(kv.id)));
		}
	}

	#answerInteraction(query) {
		if (query.case === "webFetchRequestQuery" || query.case === "webSearchRequestQuery") {
			const field = query.case === "webFetchRequestQuery" ? 9 : 2;
			this.run.writeMessage(encodeInteractionResponseEnvelope(encodeInteractionApproved(query.id, field)));
			return;
		}
		const reply = rejectionForInteraction(query);
		if (reply !== undefined) {
			this.run.writeMessage(encodeInteractionResponseEnvelope(reply.payload));
		}
	}

	/** Live background shells admitted per session (opencodex gates these). */
	static BACKGROUND_SHELL_MAX_LIVE = 16;

	/** Idle (no output activity) and absolute lifetime for one background shell. */
	static BACKGROUND_SHELL_IDLE_MS = 30 * 60 * 1000;
	static BACKGROUND_SHELL_ABSOLUTE_MS = 2 * 60 * 60 * 1000;

	#settleDisplayJoin(display) {
		rememberDisplayCompletion(this.persisted, display);
		if (display.displayKind === "update_todos" && display.call?.error === undefined && display.call?.todos !== undefined
			&& this.sessionKey !== undefined && this.syncTodos !== undefined) {
			this.syncTodos(this.sessionKey, normalizeCursorTodos(display.call.todos));
		}
	}

	#schedulePersist() {
		if (this.persistCheckpoint === undefined) return;
		void Promise.resolve(this.persistCheckpoint(this.persisted)).catch((error) => {
			this.debug(`checkpoint persist failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	#noteSummary(update) {
		if (update.type === "summaryStarted") {
			this.summaryBuffer = "";
			this.summarySeen = true;
			this.debug("summary started");
			return;
		}
		if (update.type === "summary") {
			this.summarySeen = true;
			this.summaryBuffer += update.text ?? "";
			return;
		}
		if (update.type === "summaryCompleted") {
			this.summarySeen = true;
			this.debug(`summary completed chars=${this.summaryBuffer.length}`);
			this.#commitSummary(this.summaryBuffer, this.persisted?.cursorSummary?.windowTail);
		}
	}

	#commitSummary(text, windowTail) {
		try {
			const result = applySummaryFromPump(this.agent, text, {
				keepTail: this.summarizeKeepTail !== false,
				windowTail,
				model: this.agent?.options?.model,
			});
			if (result !== null) this.debug(`summary wrote DSH bracket shadowed=${result.shadowedSeqs.length}`);
		} catch (error) {
			this.debug(`summary write-back failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#answerWriteShellStdin(exec) {
		const args = exec.args ?? {};
		const shellId = Number(args.shellId ?? 0);
		this.debug(`pump writeShellStdin id=${exec.id} shellId=${shellId}`);
		const entry = this.persisted.shells?.get(shellId);
		// Background shells run through the plain subprocess seam, whose stdin
		// is fixed at spawn time (DSH ShellProcess has no post-spawn stdin).
		// Answer the channel honestly so the server never hangs on it.
		if (entry === undefined) {
			this.run.writeMessage(encodeExecClientMessageEnvelope(encodeExecClientMessage(exec.id, exec.execId, 23, encodeWriteShellStdinError(`Unknown shell id ${shellId}`))));
		} else {
			this.run.writeMessage(encodeExecClientMessageEnvelope(encodeExecClientMessage(exec.id, exec.execId, 23, encodeWriteShellStdinError("stdin is not writable after the shell starts; include any stdin in the command (heredoc or pipe)"))));
		}
		this.run.writeMessage(encodeExecStreamClose(exec.id));
	}

	async #loop() {
		try {
			for (;;) {
				const frame = await this.run.frames.next();
				if (frame === undefined) {
					this.#terminate(undefined);
					return;
				}
				this.activityHook?.();
				// End-stream belongs to the consumer (it parses the error JSON
				// and drives the finish decision); the server's 'end' will end
				// the frame reader and this loop exits there.
				if ((frame.flags & CONNECT_END_STREAM_FLAG) !== 0) {
					this.debug("pump frame end-stream");
					this.#route(frame);
					continue;
				}
				const message = decodeAgentServerMessage(frame.payload);
				if (message.case === "kvServerMessage") {
					this.#answerKv(message.value);
					continue;
				}
				if (message.case === "interactionQuery" && message.value?.case !== "askQuestionInteractionQuery") {
					this.debug(`pump interaction ${message.value?.case} id=${message.value?.id} (answered in pump)`);
					this.#answerInteraction(message.value);
					continue;
				}
				if (message.case === "execServerMessage" && message.value?.case === "requestContextArgs") {
					const exec = message.value;
					let rules = [];
					try {
						rules = mergeDshSystemRule(await collectCursorRules({ cwd: this.sessionCwd }), this.systemText);
					} catch (error) {
						this.debug(`requestContext rules failed: ${error instanceof Error ? error.message : String(error)}`);
						rules = mergeDshSystemRule([], this.systemText);
					}
					this.debug(`pump requestContextArgs tools=${this.mcpTools?.length ?? 0} rules=${rules.length}`);
					this.run.writeMessage(encodeExecClientMessageEnvelope(encodeExecClientMessage(exec.id, exec.execId, 10, encodeRequestContextResult(this.mcpTools, rules))));
					continue;
				}
				if (message.case === "interactionUpdate" && message.value?.type === "contextInjectionState") {
					this.debug(`inject ${message.value.injectionId} ${message.value.state}`);
				}
				if (message.case === "execServerMessage" && message.value?.case === "writeShellStdinArgs") {
					this.#answerWriteShellStdin(message.value);
					continue;
				}
				if (message.case === "interactionUpdate" && message.value?.type === "toolCallCompleted"
					&& message.value.display?.displayKind !== undefined) {
					// Display tools are server-resolved. Settle the join here so a
					// parked stream's shim can await the end frame.
					this.#settleDisplayJoin(message.value.display);
				}
				if (message.case === "interactionUpdate" && (message.value?.type === "summary"
					|| message.value?.type === "summaryStarted"
					|| message.value?.type === "summaryCompleted")) {
					this.#noteSummary(message.value);
				}
				if (message.case === "conversationCheckpointUpdate") {
					// Capture and mirror todos the moment the checkpoint lands, so
					// a parked run (no consumer) still keeps state current.
					this.persisted.checkpoint = Uint8Array.from(message.value);
					try {
						const details = decodeConversationTokenDetails(message.value);
						if (details !== undefined) this.persisted.tokenDetails = details;
					} catch {
						// retry on the next checkpoint
					}
					try {
						const decoded = decodeConversationStateSummary(message.value, this.blobStore);
						if (decoded !== undefined) {
							this.persisted.cursorSummary = decoded;
							const text = pickCheckpointSummaryCommit({
								summarySeen: this.summarySeen,
								summarizeKeepTail: this.summarizeKeepTail,
								buffer: this.summaryBuffer,
								checkpointSummary: decoded.summary,
							});
							if (text !== undefined) this.#commitSummary(text, decoded.windowTail);
						}
					} catch {
						// retry on the next checkpoint
					}
					if (this.sessionKey !== undefined && this.syncTodos !== undefined) {
						try {
							const decoded = decodeConversationStateTodos(message.value);
							if (decoded.present) {
								const todos = normalizeCursorTodos(decoded.items);
								const fingerprint = JSON.stringify(todos);
								if (fingerprint !== this.persisted.todosFingerprint) {
									this.syncTodos(this.sessionKey, todos);
									this.persisted.todosFingerprint = fingerprint;
								}
							}
						} catch {
							// retry on the next checkpoint
						}
					}
					this.#schedulePersist();
				}
				this.debug(`pump frame ${message.case}${message.value?.type !== undefined ? `:${message.value.type}` : ""} (routed)`);
				this.#route(frame);
			}
		} catch (error) {
			this.#terminate(error);
		}
	}
}
//#endregion

//#region conversation building
function flattenBlocks(content) {
	let text = "";
	for (const block of content ?? []) {
		if (block.type === "text") text += block.text;
		else if (block.type === "tool-result") {
			const callId = block.toolCallId ? ` for ${block.toolCallId}` : "";
			text += `\n[TOOL RESULT${callId}]\n${flattenBlocks(block.content)}`;
		}
	}
	return text;
}

function renderAssistant(content) {
	let text = "";
	for (const block of content ?? []) {
		if (block.type === "text") text += block.text;
		else if (block.type === "tool-call") {
			text += `\n<tool_call id="${block.id}" name="${block.name}">${block.arguments}</tool_call>`;
		} else if (block.type === "reasoning") {
			text += `\n<thinking>${block.text}</thinking>`;
		}
	}
	return text.trim();
}

function actionBoundary(messages) {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === "assistant") return index + 1;
	}
	return 0;
}

export function isToolResultMessage(message) {
	return (message?.content ?? []).some((block) => block.type === "tool-result");
}

/** DSH system slot plus any system-role history messages. */
export function collectDshSystemText(options) {
	const systemParts = [options.system ?? ""];
	for (const message of options.messages ?? []) {
		if (message.role === "system") systemParts.push(flattenBlocks(message.content));
	}
	return systemParts.filter((part) => part.length > 0).join("\n").trim();
}

/**
 * Split the current DSH turn (after the last assistant) into human steers
 * and plugin injects. Tool-result cards are neither.
 */
export function classifyTurnIngress(options) {
	const messages = options.messages ?? [];
	const boundary = actionBoundary(messages);
	const users = [];
	const injections = [];
	for (let index = boundary; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "user") continue;
		if (isToolResultMessage(message)) continue;
		const text = flattenBlocks(message.content).trim();
		if (text.length === 0 && !contentHasImages(message.content)) continue;
		if (message.source?.kind === "plugin") {
			if (shouldDropCursorInject(message.source.plugin)) continue;
			injections.push({
				id: message.id,
				producer: String(message.source.plugin ?? "plugin"),
				content: text,
				message,
			});
		} else {
			users.push({ id: message.id, text, message });
		}
	}
	return { users, injections, systemText: collectDshSystemText(options) };
}

/**
 * SDK `send()` action text: only this turn's human messages. No history
 * fallback — replaying the previous question is how a reused conversation_id
 * kept serving the last task (session 7db18d90). Empty means resume_action
 * when a checkpoint exists.
 */
function currentActionText(options) {
	const { users } = classifyTurnIngress(options);
	return users.map((entry) => entry.text).filter((text) => text.length > 0).join("\n\n");
}

/**
 * Local DSH tool-call ids are display/match keys only: the wire result
 * frames are matched by exec id and never echo the toolCallId. Cursor's ids
 * embed a literal "\n" (`call-<uuid>-<n>\nfc_oz..._<m>`) which breaks the UI
 * pairing, and the StrReplace flow reuses ONE id for the probe read and its
 * write — so sanitize, then de-duplicate per conversation via `used`.
 */
export function allocateLocalToolCallId(raw, used) {
	const base = String(raw ?? "").replace(/\s+/g, "-");
	if (base.length === 0) return crypto.randomUUID();
	let candidate = base;
	for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
	used.add(candidate);
	return candidate;
}

/** Extract DSH tool-result blocks for resuming a live Cursor exec bridge. */
function collectToolResults(options) {
	const results = [];
	for (const message of options.messages ?? []) {
		for (const block of message.content ?? []) {
			if (block.type !== "tool-result") continue;
			results.push({
				toolCallId: block.toolCallId ?? message.source?.callId,
				content: flattenBlocks(block.content).trim(),
				isError: block.isError === true,
			});
		}
	}
	return results;
}

/**
 * Split a parked exec batch into those this resume can answer and those
 * still running. A half-delivered DSH step used to fake-fail the missing
 * ids (`Tool result not provided` / `spawn failed`) and stream_close them,
 * which left the server waiting on a closed exec.
 */
export function partitionPendingExecs(pendingExecs, toolResults) {
	const byId = new Map();
	for (const result of toolResults ?? []) {
		if (result?.toolCallId !== undefined) byId.set(result.toolCallId, result);
	}
	const ready = [];
	const leftover = [];
	for (const pending of pendingExecs ?? []) {
		const result = byId.get(pending.toolCallId);
		if (result === undefined) leftover.push(pending);
		else ready.push({ pending, result });
	}
	return { ready, leftover };
}

function decodeXmlText(value): any {
	return String(value ?? "")
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&amp;/gi, "&");
}

function parseTagAttributes(source) {
	const attributes: any = {};
	const pattern = /([A-Za-z_][\w-]*)\s*=\s*"([\s\S]*?)"/g;
	for (let match; (match = pattern.exec(source)) !== null;) attributes[match[1]] = decodeXmlText(match[2]);
	return attributes;
}

function resolveTextTool(candidate, tools) {
	const available = tools ?? [];
	const normalized = String(candidate ?? "").toLowerCase();
	let tool = available.find((entry) => {
		const name = String(entry.name).toLowerCase();
		return normalized === name || normalized.endsWith(`_${name}`);
	});
	if (tool !== undefined) return tool;
	const aliases = {
		shell: ["pwsh", "bash"],
		read: ["read"],
		glob: ["glob"],
		grep: ["grep"],
		write: ["write"],
		edit: ["edit"],
	};
	for (const name of aliases[normalized] ?? []) {
		tool = available.find((entry) => String(entry.name).toLowerCase() === name);
		if (tool !== undefined) return tool;
	}
	return undefined;
}

function normalizeTextToolArguments(tool, raw) {
	const args = { ...raw };
	if (tool.name === "read" && args.file_path === undefined && args.path !== undefined) {
		args.file_path = args.path;
		delete args.path;
	}
	if (tool.name === "glob") {
		if (args.pattern === undefined && args.glob_pattern !== undefined) args.pattern = args.glob_pattern;
		if (args.path === undefined && args.target_directory !== undefined) args.path = args.target_directory;
		delete args.glob_pattern;
		delete args.target_directory;
	}
	for (const [key, value] of Object.entries(args)) {
		const type = tool.parameters?.properties?.[key]?.type;
		if ((type === "number" || type === "integer") && typeof value === "string" && value.trim() !== "") {
			const number = Number(value);
			if (Number.isFinite(number)) args[key] = number;
		} else if (type === "boolean" && typeof value === "string") {
			if (value.toLowerCase() === "true") args[key] = true;
			else if (value.toLowerCase() === "false") args[key] = false;
		} else if ((type === "object" || type === "array") && typeof value === "string") {
			try { args[key] = JSON.parse(value); } catch {}
		}
	}
	return args;
}

/**
 * Recover Cursor models that print tool-call XML as text instead of emitting
 * an execServerMessage.mcpArgs frame. This is a fallback for contaminated or
 * compacted conversations; protocol-native MCP calls remain the primary path.
 */
export function parseTextToolCalls(text, tools) {
	const calls = [];
	const pattern = /<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/gi;
	for (let match; (match = pattern.exec(String(text ?? ""))) !== null;) {
		const attributes = parseTagAttributes(match[1]);
		const tool = resolveTextTool(attributes.name ?? attributes.id, tools);
		if (tool === undefined) continue;
		const rawArgs: any = {};
		const parameterPattern = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/gi;
		for (let parameter; (parameter = parameterPattern.exec(match[2])) !== null;) {
			rawArgs[parameter[1]] = decodeXmlText(parameter[2].trim());
		}
		for (const [key, value] of Object.entries(attributes)) {
			if (key !== "id" && key !== "name") rawArgs[key] = value;
		}
		if (Object.keys(rawArgs).length === 0) {
			const body = decodeXmlText(match[2]).trim();
			if (body.startsWith("{")) {
				try { Object.assign(rawArgs, JSON.parse(body)); } catch {}
			}
		}
		calls.push({
			id: `text-tool-${crypto.randomUUID()}`,
			name: tool.name,
			arguments: JSON.stringify(normalizeTextToolArguments(tool, rawArgs)),
		});
	}
	return calls;
}

/**
 * Build a fresh state with no root prompt blobs. Current Cursor servers reject
 * hand-encoded field-8 turns; the SDK likewise starts from an empty
 * ConversationStateStructure plus only this send's text/images.
 *
 * The client system prompt slot (root_prompt_messages_json) REPLACES Cursor's
 * built-in agent prompt — there is no append mode (Cursor SDK semantics). The
 * DSH system text is therefore NOT sent through that slot: it is uploaded as
 * an always-apply RequestContext rule (`dsh://system-prompt`). Workspace
 * AGENTS.md files use the same rules channel. Mid-turn plugin injects use
 * InjectContextAction.system_context, not a user-message wrapper.
 */
export function buildInitialConversationState(options) {
	return {
		conversationState: encodeConversationState({ rootPromptBlobIds: [], turns: [] }),
		blobStore: new Map(),
		systemText: collectDshSystemText(options),
	};
}

/**
 * Fold DSH history into Cursor's turn-based conversation state.
 *
 * The last user message becomes the new `ConversationAction`; everything
 * before it is the durable turn history. Tool results are rendered as user
 * messages so a follow-up run after DSH executes a tool carries the result
 * back to the model. The system prompt travels as a blob referenced by
 * `rootPromptMessagesJson`; the server fetches it through the KV handshake.
 */
export function buildConversationState(options) {
	const systemParts = [options.system ?? ""];
	const turns = [];
	let currentUser = null;
	let currentSteps = [];

	const flushTurn = () => {
		if (currentUser !== null) {
			const userBytes = encodeUserMessage({ text: currentUser, messageId: randomUUID() });
			const turnBytes = encodeAgentTurn(userBytes, currentSteps);
			turns.push(encodeTurnStructure(turnBytes));
		}
		currentUser = null;
		currentSteps = [];
	};

	for (const message of options.messages ?? []) {
		if (message.role === "system") {
			systemParts.push(flattenBlocks(message.content));
			continue;
		}
		if (message.role === "user") {
			flushTurn();
			currentUser = flattenBlocks(message.content);
			continue;
		}
		if (message.role === "assistant") {
			const text = renderAssistant(message.content);
			if (currentUser === null) currentUser = ""; // assistant-first history: implicit turn
			if (text.length > 0) currentSteps.push(encodeAssistantStep(text));
		}
	}

	// The final pending user message is the action, not part of history.
	let actionText = "";
	if (currentUser !== null) {
		actionText = currentUser;
	}
	currentUser = null;
	currentSteps = [];

	const systemText = systemParts.filter((part) => part.length > 0).join("\n").trim();
	// No root prompt blob: the system slot replaces Cursor's built-in prompt
	// (see buildInitialConversationState). System text is a RequestContext rule.
	const conversationState = encodeConversationState({ rootPromptBlobIds: [], turns, systemText });
	const userBytes = encodeUserMessage({ text: actionText, messageId: randomUUID() });
	const action = encodeUserMessageAction(userBytes);
	return { conversationState, action, blobStore: new Map(), systemText };
}

/**
 * Build the full `AgentClientMessage` payload for one run.
 *
 * When a persisted checkpoint for this conversation exists (captured from a
 * previous run's `conversation_checkpoint_update`), it becomes the
 * conversation state and its referenced blobs are served from the persisted
 * blob store. Otherwise the state is built from the DSH message history.
 */
export function buildRunPayload(options, modelId, persisted, conversationId = undefined) {
	const ingress = classifyTurnIngress(options);
	const images = Array.isArray(options.selectedImages) ? options.selectedImages : [];
	let conversationState;
	let blobStore;
	let action;
	// SDK local send: loadLatest(agentId) or empty ConversationStateStructure,
	// plus only this send's text/images. Never reconstruct labeled history
	// into the user action (that hides the current turn and, with a reused
	// conversation_id, lets the server keep serving the previous question).
	const actionText = currentActionText(options);
	if (persisted?.checkpoint !== undefined) {
		conversationState = persisted.checkpoint;
		blobStore = persisted.blobs ?? new Map();
		action = actionText.length > 0 || images.length > 0
			? encodeUserMessageAction(encodeUserMessage({ text: actionText, messageId: randomUUID(), images }))
			: encodeResumeAction();
	} else {
		const built = buildInitialConversationState(options);
		conversationState = built.conversationState;
		blobStore = built.blobStore;
		action = encodeUserMessageAction(encodeUserMessage({ text: actionText, messageId: randomUUID(), images }));
	}
	const requestedModel = encodeRequestedModelForRun(modelId, options);
	const modelDetails = requestedModel ? undefined : encodeModelDetails(modelId);
	const runRequest = encodeRunRequest({
		conversationState,
		action,
		modelDetails,
		requestedModel,
		conversationId: conversationId ?? randomUUID(),
		runId: persisted?.generationId,
	});
	return {
		payload: encodeRunMessage(runRequest),
		blobStore,
		systemText: ingress.systemText,
		injections: ingress.injections,
		users: ingress.users,
	};
}

/**
 * Build a run payload with a prebuilt conversation state and a non-default
 * action (async ask-question completion, resume-with-replay). The blob store
 * is the caller's (checkpoint blobs + any replayed turn blobs).
 */
export function buildCustomRunPayload({ conversationState, actionBytes, modelId, conversationId, blobStore, requestedModel, runId }: any) {
	const runRequest = encodeRunRequest({
		conversationState,
		action: actionBytes,
		modelDetails: requestedModel ? undefined : encodeModelDetails(modelId),
		requestedModel,
		conversationId,
		runId,
	});
	return { payload: encodeRunMessage(runRequest), blobStore: blobStore ?? new Map() };
}

function encodeRequestedModelForRun(modelId, options : any = {}) {
	if (options.requestedModel instanceof Uint8Array) return options.requestedModel;
	if (options.useRequestedModel !== true && !Array.isArray(options.requestedModelParameters)) return undefined;
	const parameters = Array.isArray(options.requestedModelParameters) ? options.requestedModelParameters : [];
	return encodeRequestedModel({
		modelId,
		maxMode: options.requestedMaxMode === true,
		parameters,
	});
}

//#endregion

//#region models discovery
/**
 * Fetch usable models from Cursor's unary `GetUsableModels` endpoint.
 * The request body is the raw (unframed) empty protobuf message.
 */
export async function fetchUsableModels(accessToken, options : any = {}) {
	const fetchImpl = options.fetch ?? nativeFetch;
	const response = await fetchImpl(`${options.baseUrl ?? CURSOR_BASE_URL}${CURSOR_MODELS_PATH}`, {
		method: "POST",
		redirect: "error",
		headers: {
			"content-type": "application/proto",
			authorization: `Bearer ${accessToken}`,
			"x-ghost-mode": "true",
			"x-cursor-client-version": CURSOR_CLIENT_VERSION,
			"x-cursor-client-type": "cli",
			"user-agent": "dsh-cursor-agent/0.1.0",
		},
		body: new Uint8Array(0),
		signal: options.signal,
	});
	if (!response.ok) throw new Error(`Cursor model discovery failed (HTTP ${response.status})`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length === 0) throw new Error("Cursor model discovery returned an empty response");
	// The body may be raw protobuf or Connect-framed; try both.
	const models = decodeUsableModels(bytes);
	if (models.length > 0) return models;
	const frameReader = new ConnectFrameReader();
	frameReader.push(bytes);
	frameReader.finish();
	const framed = [];
	for (;;) {
		const frame = await frameReader.next();
		if (frame === undefined) break;
		if ((frame.flags & CONNECT_END_STREAM_FLAG) !== 0) break;
		framed.push(...decodeUsableModels(frame.payload));
	}
	return framed;
}

/**
 * Fetch the parameterized catalog from `aiserver.v1.AiService/AvailableModels`.
 * Uses the same access token as GetUsableModels (OAuth or API-key exchange).
 */
export async function fetchAvailableModels(accessToken, options : any = {}) {
	const fetchImpl = options.fetch ?? nativeFetch;
	const body = encodeAvailableModelsRequest();
	const response = await fetchImpl(`${options.baseUrl ?? CURSOR_BASE_URL}${CURSOR_AVAILABLE_MODELS_PATH}`, {
		method: "POST",
		redirect: "error",
		headers: {
			"content-type": "application/proto",
			authorization: `Bearer ${accessToken}`,
			"x-ghost-mode": "true",
			"x-cursor-client-version": CURSOR_CLIENT_VERSION,
			"x-cursor-client-type": "cli",
			"user-agent": "dsh-cursor-agent/0.1.0",
		},
		body,
		signal: options.signal,
	});
	if (!response.ok) throw new Error(`Cursor AvailableModels failed (HTTP ${response.status})`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length === 0) throw new Error("Cursor AvailableModels returned an empty response");
	const models = decodeAvailableModels(bytes);
	if (models.length > 0) return models;
	const frameReader = new ConnectFrameReader();
	frameReader.push(bytes);
	frameReader.finish();
	const framed = [];
	for (;;) {
		const frame = await frameReader.next();
		if (frame === undefined) break;
		if ((frame.flags & CONNECT_END_STREAM_FLAG) !== 0) break;
		framed.push(...decodeAvailableModels(frame.payload));
	}
	return framed;
}

/**
 * Ask Cursor to name a session from the first user message.
 * Unary `agent.v1.AgentService/NameAgent`, same auth as GetUsableModels.
 * @throws {Error} when the HTTP status is not 2xx, the body is empty, or neither a raw nor Connect-framed payload yields a name.
 */
export async function fetchNameAgent(accessToken, userMessage, options : any = {}) {
	const fetchImpl = options.fetch ?? nativeFetch;
	const response = await fetchImpl(`${options.baseUrl ?? CURSOR_BASE_URL}${CURSOR_NAME_AGENT_PATH}`, {
		method: "POST",
		redirect: "error",
		headers: {
			"content-type": "application/proto",
			authorization: `Bearer ${accessToken}`,
			"x-ghost-mode": "true",
			"x-cursor-client-version": CURSOR_CLIENT_VERSION,
			"x-cursor-client-type": "cli",
			"user-agent": "dsh-cursor-agent/0.1.0",
		},
		body: encodeNameAgentRequest(userMessage),
		signal: options.signal,
	});
	if (!response.ok) throw new Error(`Cursor NameAgent failed (HTTP ${response.status})`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length === 0) throw new Error("Cursor NameAgent returned an empty response");
	try {
		const name = decodeNameAgentResponse(bytes);
		if (name.length > 0) return name;
	} catch {
		// Connect-framed bodies are not a valid NameAgentResponse on their own.
	}
	const frameReader = new ConnectFrameReader();
	frameReader.push(bytes);
	frameReader.finish();
	for (;;) {
		const frame = await frameReader.next();
		if (frame === undefined) break;
		if ((frame.flags & CONNECT_END_STREAM_FLAG) !== 0) break;
		try {
			const framed = decodeNameAgentResponse(frame.payload);
			if (framed.length > 0) return framed;
		} catch {
			// A non-payload Connect frame is not a NameAgentResponse.
		}
	}
	throw new Error("Cursor NameAgent returned an empty title");
}
//#endregion

function pointerMatchesCheckpoint(ref, bytes) {
	if (ref == null || bytes == null) return false;
	const digest = createHash("sha256").update(bytes).digest("hex");
	const id = String(ref.attachmentId ?? "");
	return id === digest || id === `sha256:${digest}`;
}

const shellStreamChannels = new Map();
const bgShellSpawns = new Map();
let nextBgShellId = 1;

function isJoinBatchFrame(message) {
	if (message.case === "execServerMessage") {
		const kind = message.value?.case;
		return kind === "readArgs" || kind === "writeArgs" || kind === "deleteArgs"
			|| kind === "grepArgs" || kind === "shellStreamArgs" || kind === "backgroundShellSpawnArgs";
	}
	if (message.case !== "interactionUpdate") return false;
	const type = message.value?.type;
	if (type === "tokenDelta" || type === "turnEnded" || type === "partialToolCall" || type === "toolCallDelta") return true;
	if (type === "heartbeat" || type === "contextInjectionState" || type === "userMessageAppended") return true;
	if (type === "summary" || type === "summaryStarted" || type === "summaryCompleted") return true;
	if (type === "toolCallStarted" || type === "toolCallCompleted") {
		return message.value.display?.displayKind !== undefined;
	}
	return false;
}

function isNextRoundContent(message) {
	if (message.case !== "interactionUpdate") return false;
	const type = message.value?.type;
	return (type === "textDelta" || type === "thinkingDelta") && String(message.value.text ?? "").length > 0;
}

export class CursorAdapter extends LlmAdapter {
	auth: any;
	fetchModels: any;
	fetchAvailableModels: any;
	nameAgent: any;
	fallbackModels: any;
	idleTimeoutMs: any;
	progressTimeoutMs: any;
	idleCheckIntervalMs: any;
	modelsCacheTtlMs: any;
	sessionStateTtlMs: any;
	settings: any;
	createAgentRun: any;
	sleep: any;
	now: any;
	gate: any;
	syncTodos: any;
	logger: any;
	shellService: any;
	terminalsRoot: any;
	agents: any;
	agent: any;
	sandboxPolicy: any;
	jobs: any;
	attachments: any;
	checkpointStore: any;
	publishSessionEvent: any;
	sessions: any;
	modelsCache: any;
	availableModelsCache: any;

	constructor(options: any) {
		super();
		this.auth = options.auth;
		this.fetchModels = options.fetchModels ?? fetchUsableModels;
		this.fetchAvailableModels = options.fetchAvailableModels ?? fetchAvailableModels;
		this.nameAgent = options.nameAgent ?? fetchNameAgent;
		this.fallbackModels = options.fallbackModels ?? FALLBACK_MODELS;
		this.idleTimeoutMs = options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
		this.progressTimeoutMs = options.progressTimeoutMs ?? STREAM_PROGRESS_TIMEOUT_MS;
		this.idleCheckIntervalMs = options.idleCheckIntervalMs ?? 15000;
		this.modelsCacheTtlMs = options.modelsCacheTtlMs ?? 5 * 60 * 1000;
		this.sessionStateTtlMs = options.sessionStateTtlMs ?? SESSION_STATE_TTL_MS;
		const fallbackSettings = resolveCursorSettings({
			maxToolRounds: options.maxToolRounds,
			apiBaseUrl: options.apiBaseUrl,
			retryCount: options.retryCount,
			retryIntervalMs: options.retryIntervalMs,
			retryHttpStatusCodes: options.retryHttpStatusCodes,
		});
		this.settings = options.settings ?? (() => fallbackSettings);
		this.createAgentRun = options.createAgentRun ?? ((access) => new AgentRun(access, { baseUrl: this.settings().apiBaseUrl }));
		this.sleep = options.sleep ?? abortableDelay;
		this.now = options.now ?? Date.now;
		/** Optional preset gate: (sessionId) => void, throws LlmError when the session is not on the cursor preset. */
		this.gate = options.gate;
		/** Optional todo sync: (sessionId, todos) => void, mirrors Cursor todos into the DSH todo panel. */
		this.syncTodos = options.syncTodos;
		/** Optional host logger. Stream diagnostics go through CURSOR_AGENT_DEBUG. */
		this.logger = options.logger;
		/** Optional host shell executor for the Phase 2 shell channels. */
		this.shellService = options.shellService;
		/** Optional root under which per-session terminal files live. */
		this.terminalsRoot = options.terminalsRoot;
		/** Optional host agent registry for the shell channels' session cwd. */
		this.agents = options.agents;
		/** Optional host sandbox policy service for the shell channels. */
		this.sandboxPolicy = options.sandboxPolicy;
		/** Host jobs registry for background-shell drain (`read`/`get` only; `start` is session-world). */
		this.jobs = options.jobs;
		this.attachments = options.attachments;
		/** Optional durable checkpoint store (storageDomain + object files). */
		this.checkpointStore = options.checkpointStore;
		/** Optional `session/event` publisher so persistence can enqueue log markers. */
		this.publishSessionEvent = options.publishSessionEvent;
		this.#modelsCache = { at: 0, models: undefined, catalog: undefined };
		/** exec.id → in-flight `#forwardShellStream` promise. Resume waits on this. */
		this.#shellForwarders = new Map();
		/** Last Cursor `token_details.max_tokens` per model id. */
		this.#contextWindowByModel = new Map();
	}

	#modelsCache;
	#shellForwarders;
	#contextWindowByModel;
	/** Persisted conversation checkpoints + referenced blobs per DSH session id. */
	#sessions = new Map();

	/** Kill every live background shell of one session state (eviction/shutdown). */
	#killSessionShells(state) {
		for (const entry of state.shells?.values() ?? []) {
			try {
				if (entry.absoluteTimer !== undefined) clearTimeout(entry.absoluteTimer);
			} catch {}
			try {
				entry.log?.dispose();
			} catch {}
			if (entry.proc?.status === "running") {
				try {
					entry.proc.kill();
				} catch {}
			}
		}
	}

	/**
	 * Stream one shellStream exec's output to the server while the session
	 * exec plane runs the command. The plane pushes deltas + settlement into
	 * `shellStreamChannels` (keyed by the local tool-call id); this forwarder
	 * polls the channel and emits start → stdout/stderr deltas → exit →
	 * shellResult + stream_close.
	 */
	#forwardShellStream(exec, id, run, debug, persisted, terminalsFolder) {
		const task = (async () => {
			const args = exec.args ?? {};
			const command = args.command ?? "";
			const cwd = args.workingDirectory ?? "";
			const title = typeof args.description === "string" && args.description.length > 0 ? args.description : undefined;
			const write = (bytes) => {
				if (!run.writeMessage(bytes)) throw new Error("Cursor shell-stream bridge closed before accepting a frame");
			};
			const openTerminal = (shellId, startedAt) => {
				if (typeof terminalsFolder !== "string" || terminalsFolder.length === 0) return undefined;
				return createCursorTerminalLog(join(terminalsFolder, `${shellId}.txt`), {
					cwd,
					command,
					title,
					startedAtMs: startedAt,
				});
			};
			try {
				debug(`shellStream id=${exec.id} command=${JSON.stringify(command.slice(0, 100))}`);
				write(encodeExecClientMessageEnvelope(encodeExecClientMessage(exec.id, exec.execId, 14, encodeShellStreamStart(args.sandboxPolicy?.type))));
				const started = Date.now();
				let channel = shellStreamChannels.get(id);
				if (channel === undefined) {
					// Wait for the ToolRuntime to start the bash call.
					const deadline = Date.now() + 130_000;
					while (channel === undefined && Date.now() < deadline) {
						await sleep(100);
						channel = shellStreamChannels.get(id);
					}
				}
				if (channel === undefined) {
					const terminal = openTerminal(exec.id, started);
					terminal?.finish({ exitCode: 1, aborted: true });
					write(encodeExecClientMessageEnvelope(encodeExecClientMessage(exec.id, exec.execId, 2, encodeShellFailure({
						command,
						workingDirectory: cwd,
						exitCode: 1,
						stderr: "the shell call never started",
						executionTime: Date.now() - started,
						aborted: true,
						terminalsFolder,
					}))));
					write(encodeExecStreamClose(exec.id));
					return;
				}
				const fileShellId = channel.jobId !== undefined
					? (parseJobIdN(channel.jobId) ?? exec.id)
					: exec.id;
				const terminal = openTerminal(fileShellId, started);
				let stdout = "";
				let stderr = "";
				let sent = 0;
				for (;;) {
					if (channel.pid !== undefined) terminal?.setPid(channel.pid);
					while (sent < channel.chunks.length) {
						const split = splitShellDelta(channel.chunks[sent++]);
						if (split.stdout.length > 0) {
							stdout += split.stdout;
							terminal?.append(split.stdout);
							write(encodeExecClientMessageEnvelope(encodeExecClientMessage(exec.id, exec.execId, 14, encodeShellStreamStdout(split.stdout))));
						}
						if (split.stderr.length > 0) {
							stderr += split.stderr;
							terminal?.append(split.stderr);
							write(encodeExecClientMessageEnvelope(encodeExecClientMessage(exec.id, exec.execId, 14, encodeShellStreamStderr(split.stderr))));
						}
					}
					if (channel.done) break;
					await sleep(100);
				}
				shellStreamChannels.delete(id);
				const error = channel.error;
				const elapsed = Date.now() - started;
				if (channel.backgrounded === true && channel.proc !== undefined) {
					// The block deadline expired with BACKGROUND behavior: the
					// command keeps running. Announce backgrounded, answer the
					// call with an is_background shellResult immediately, and
					// drain the process into the terminals-folder file. The job
					// was registered at spawn (timeout_behavior=2), so its
					// numeric id is the protocol shellId and the Jobs panel
					// already tracks it.
					const proc = channel.proc;
					const shellId = fileShellId;
					if (channel.pid !== undefined) terminal?.setPid(channel.pid);
					write(encodeExecClientMessageEnvelope(encodeExecClientMessage(exec.id, exec.execId, 14, encodeShellStreamBackgrounded({
						shellId,
						command,
						workingDirectory: cwd,
						...(channel.pid !== undefined ? { pid: channel.pid } : {}),
						reason: 1, // ShellBackgroundReason.TIMEOUT
					}))));
					write(encodeExecClientMessageEnvelope(encodeExecClientMessage(exec.id, exec.execId, 2, encodeShellSuccess({
						command,
						workingDirectory: cwd,
						exitCode: 0,
						stdout,
						stderr,
						executionTime: elapsed,
						isBackground: true,
						shellId,
						...(channel.pid !== undefined ? { pid: channel.pid } : {}),
						terminalsFolder,
					}))));
					write(encodeExecStreamClose(exec.id));
					debug(`shellStream id=${exec.id} backgrounded (shellId=${shellId} job=${channel.jobId ?? "none"} pid=${channel.pid ?? "none"})`);
					// Register the live process so eviction/shutdown kills it, and
					// keep draining its output into the terminal file.
					persisted.shells ??= new Map();
					persisted.shells.set(shellId, {
						shellId,
						...(channel.jobId !== undefined ? { jobId: String(channel.jobId) } : {}),
						pid: channel.pid,
						command,
						cwd,
						title,
						proc,
						filePath: terminal?.filePath ?? join(terminalsFolder ?? os.tmpdir(), `${shellId}.txt`),
						log: terminal,
						startedAt: started,
						lastActivityAt: started,
						absoluteTimer: setTimeout(() => {
							try {
								proc.kill();
							} catch {}
						}, CursorRunPump.BACKGROUND_SHELL_ABSOLUTE_MS),
						bytes: terminal?.bytes ?? 0,
					});
					void this.#ensureBackgroundDrain(shellId, persisted, debug);
					return;
				}
				const exitCode = error === undefined ? (channel.exitCode ?? 1) : 1;
				if (channel.pid !== undefined) terminal?.setPid(channel.pid);
				terminal?.finish({ exitCode, aborted: error !== undefined });
				write(encodeExecClientMessageEnvelope(encodeExecClientMessage(exec.id, exec.execId, 14, encodeShellStreamExit({
					code: exitCode,
					cwd,
					aborted: error !== undefined,
					...(terminal !== undefined ? { outputLocation: terminal.stats() } : {}),
				}))));
				if (error !== undefined) {
					stderr = stderr.length > 0 ? `${stderr}\n${error}` : error;
					write(encodeExecClientMessageEnvelope(encodeExecClientMessage(exec.id, exec.execId, 2, encodeShellFailure({ command, workingDirectory: cwd, exitCode, stdout, stderr, executionTime: elapsed, aborted: true, terminalsFolder }))));
				} else if (exitCode === 0) {
					write(encodeExecClientMessageEnvelope(encodeExecClientMessage(exec.id, exec.execId, 2, encodeShellSuccess({ command, workingDirectory: cwd, exitCode, stdout, stderr, executionTime: elapsed, terminalsFolder }))));
				} else {
					write(encodeExecClientMessageEnvelope(encodeExecClientMessage(exec.id, exec.execId, 2, encodeShellFailure({ command, workingDirectory: cwd, exitCode, stdout, stderr, executionTime: elapsed, terminalsFolder }))));
				}
				write(encodeExecStreamClose(exec.id));
				debug(`shellStream id=${exec.id} done code=${exitCode} bytes=${stdout.length + stderr.length}`);
			} catch (forwardError) {
				debug(`shellStream id=${exec.id} forwarder failed: ${forwardError instanceof Error ? forwardError.message : String(forwardError)}`);
			}
		})();
		this.#shellForwarders.set(exec.id, task);
		void task.finally(() => {
			if (this.#shellForwarders.get(exec.id) === task) this.#shellForwarders.delete(exec.id);
		});
		return task;
	}

	/**
	 * Start the single output reader for a background shell. Resume and the
	 * timeout-background path used to both call `readOutput()`; that delta is
	 * destructive, so the pid probe stole bytes the terminal file never saw.
	 */
	#ensureBackgroundDrain(shellId, persisted, debug) {
		const entry = persisted.shells?.get(shellId);
		if (entry === undefined) return undefined;
		entry.drain ??= this.#drainBackgroundedShell(shellId, persisted, debug);
		return entry.drain;
	}

	/** Wait until the drain observes the NSpid line (or the process ends). */
	async #waitForBackgroundPid(entry, timeoutMs = 2000) {
		const deadline = Date.now() + timeoutMs;
		while (entry.pid === undefined && Date.now() < deadline) {
			if (entry.proc?.status !== "running" && entry.proc?.status !== undefined) break;
			await sleep(50);
		}
	}

	/** Drain a backgrounded shell process into its terminal file until it exits (incremental, streaming). */
	async #drainBackgroundedShell(shellId, persisted, debug) {
		const entry = persisted.shells?.get(shellId);
		if (entry === undefined) return;
		// The job registry owns lifecycle (Jobs panel state, agent-disposal
		// cancel); reads prefer the registry's incremental readOutput and fall
		// back to the raw process when no job is registered.
		const readDelta = () => {
			if (entry.jobId !== undefined && this.jobs !== undefined) {
				try {
					// Registry access is owner-fenced: pass the pump's agent.
					return this.jobs.read(entry.jobId, this.agent).text;
				} catch {
					// fall through to the raw process
				}
			}
			return entry.proc.readOutput().delta;
		};
		const settled = () => {
			if (entry.jobId !== undefined && this.jobs !== undefined) {
				try {
					const snapshot = this.jobs.get(entry.jobId, this.agent);
					if (snapshot !== undefined && snapshot.status !== "running" && snapshot.status !== "stopping") return true;
				} catch {
					// fall through to the raw process
				}
			}
			return entry.proc.status !== "running";
		};
		const probe = entry.pidProbe ?? createPidProbe();
		entry.pidProbe = probe;
		try {
			for (;;) {
				const delta = readDelta();
				const probed = probe.consume(delta);
				if (probed.pid !== undefined && entry.pid === undefined) entry.pid = probed.pid;
				if (probed.rest.length > 0) this.#appendTerminalFile(entry, probed.rest);
				if (settled()) break;
				await sleep(100);
			}
		} catch {
			// settle as killed
		}
		const tail = entry.proc.readOutput();
		const tailProbed = probe.consume(tail.delta);
		if (tailProbed.pid !== undefined && entry.pid === undefined) entry.pid = tailProbed.pid;
		if (tailProbed.rest.length > 0) this.#appendTerminalFile(entry, tailProbed.rest);
		const code = entry.proc.exitCode;
		this.#finishTerminalFile(entry, { exitCode: code ?? 1, aborted: code === null });
		debug(`backgrounded shell ${shellId} done code=${code} bytes=${entry.bytes} pid=${entry.pid ?? "none"}`);
	}

	/** Wait for in-flight shellStream writers before tearing the Run down. */
	async #waitForShellForwarders(pendingExecs, debug) {
		const tasks = [];
		for (const pending of pendingExecs ?? []) {
			const task = this.#shellForwarders.get(pending.id);
			if (task !== undefined) tasks.push(task);
		}
		if (tasks.length === 0) return;
		debug(`waiting for ${tasks.length} shell forwarder(s) before replacing the run`);
		await Promise.allSettled(tasks);
	}

	/** Open the Cursor-format terminal file for one shell entry if needed. */
	#ensureTerminalLog(entry) {
		if (entry.log !== undefined) return entry.log;
		if (entry.filePath === undefined) return undefined;
		entry.log = createCursorTerminalLog(entry.filePath, {
			pid: entry.pid,
			cwd: entry.cwd,
			command: entry.command,
			title: entry.title,
			startedAtMs: entry.startedAt,
		});
		return entry.log;
	}

	/** Append text to one shell's terminal file (create dirs as needed). */
	#appendTerminalFile(entry, text) {
		if (text.length === 0) return;
		const log = this.#ensureTerminalLog(entry);
		if (log === undefined) return;
		if (entry.pid !== undefined) log.setPid(entry.pid);
		log.append(text);
		entry.bytes = log.bytes;
	}

	/** Write the Cursor footer and freeze the header once the command settles. */
	#finishTerminalFile(entry, { exitCode, aborted = false } : any = {}) {
		const log = this.#ensureTerminalLog(entry);
		if (log === undefined) return;
		if (entry.pid !== undefined) log.setPid(entry.pid);
		log.finish({ exitCode, aborted });
		entry.bytes = log.bytes;
	}

	#writeExecReply(run, exec, field, payload) {
		if (!run.writeMessage(encodeExecClientMessageEnvelope(encodeExecClientMessage(exec.id, exec.execId, field, payload)))) {
			throw new Error("Cursor tool continuation bridge closed before accepting the result");
		}
		run.writeMessage(encodeExecStreamClose(exec.id));
	}

	async #answerNativeSearch({ world, exec, classified, id, run, debug, signal }) {
		let result;
		try {
			result = await execSearch(world, classified, { signal });
		} catch (error) {
			result = { error: error instanceof Error ? error.message : String(error) };
		}
		this.#writeExecReply(run, exec, EXEC_REPLY_FIELDS.grepArgs, encodeGrepSearchResult(classified, result));
		const meta = searchMetaFromResult(classified, result);
		settleCursorJoin(id, {
			text: searchResultSummary(classified, result),
			isError: result?.error !== undefined,
			...meta !== undefined ? { meta } : {},
		});
		debug(`exec grepArgs id=${exec.id} → ${classified.displayName} (exec-plane)`);
	}

	async #answerNativeFs({ world, exec, id, rawId, run, persisted, debug, signal }) {
		const translated = translateNativeExec(exec);
		if (translated === undefined) {
			failCursorJoin(id, new Error("Cursor exec could not be translated"));
			return;
		}
		if (translated.reject !== undefined) {
			this.#writeExecReply(run, exec, translated.field, translated.reject);
			settleCursorJoin(id, { text: "binary file writes (file_bytes) are not supported", isError: true });
			return;
		}
		persisted.probeReads ??= new Map();
		if (exec.case === "readArgs") {
			try {
				const value = await execRead(world, { path: exec.args?.path, signal });
				const joinPath = exec.args?.path ?? value.path;
				if (value.kind === "image") {
					this.#writeExecReply(run, exec, translated.field, translated.encode("", false, {
						data: value.data,
						fileSize: Number.isSafeInteger(value.fileSize) ? value.fileSize : value.bytes,
					}));
					settleCursorJoin(id, {
						text: formatImageReadJoinText(joinPath, value.mime, value.bytes, {
							width: value.width,
							height: value.height,
							originalDimensions: value.originalDimensions,
						}),
						meta: { path: joinPath, offset: 1, lines: [], totalLines: 0 },
					});
					return;
				}
				const offset = typeof exec.args?.offset === "number" ? exec.args.offset : undefined;
				const limit = typeof exec.args?.limit === "number" ? exec.args.limit : undefined;
				const window = composeReadWindow(value.content, { offset, limit });
				this.#writeExecReply(run, exec, translated.field, translated.encode(value.content, false, { fileSize: value.bytes }));
				noteProbeRead(persisted.probeReads, rawId, { localId: id, path: exec.args?.path ?? value.path, content: value.content });
				settleCursorJoin(id, {
					text: formatReadJoinText(joinPath, window),
					meta: readPresentationMeta(joinPath, window.content, {
						offset: window.startLine,
						totalLines: window.totalLines,
					}),
				});
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				const invalidFile = error?.code === "READ_INVALID_FILE";
				this.#writeExecReply(run, exec, translated.field, translated.encode(text, true, {
					invalidFile,
					reason: text,
				}));
				if (/^(?:Error: )?cannot read ".*": not found$/.test(text)) {
					noteProbeRead(persisted.probeReads, rawId, { localId: id, path: exec.args?.path ?? "", content: "", error: text });
				}
				settleCursorJoin(id, { text, isError: true });
			}
			return;
		}
		if (exec.case === "writeArgs") {
			const probe = takeProbeRead(persisted.probeReads, rawId);
			const newText = exec.args?.fileText ?? "";
			try {
				const value = await execWrite(world, {
					path: exec.args?.path,
					content: newText,
					signal,
					callId: id,
				});
				this.#writeExecReply(run, exec, translated.field, translated.encode("ok", false));
				const paired = probe !== undefined && probe.error === undefined;
				settleCursorJoin(id, {
					text: `${value.operation === "create" ? "Created" : paired ? "Edited" : "Updated"} ${value.path}`,
					meta: {
						path: value.path,
						oldText: paired ? String(probe.content ?? "") : null,
						newText,
					},
				});
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				this.#writeExecReply(run, exec, translated.field, translated.encode(text, true));
				settleCursorJoin(id, { text, isError: true });
			}
			return;
		}
		if (exec.case === "deleteArgs") {
			try {
				const value = await execDelete(world, { path: exec.args?.path, signal, callId: id });
				const text = `Deleted ${value.path} (${value.fileSize} bytes)`;
				this.#writeExecReply(run, exec, translated.field, translated.encode(text, false));
				settleCursorJoin(id, { text });
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				this.#writeExecReply(run, exec, translated.field, translated.encode(text, true));
				settleCursorJoin(id, { text, isError: true });
			}
		}
	}

	async #answerNativeShell({ world, exec, id, run, persisted, terminalsFolder, debug, signal }) {
		const args = exec.args ?? {};
		const command = args.command ?? "";
		const workdir = args.workingDirectory ?? "";
		const timeoutMs = Number.isSafeInteger(args.timeout) && args.timeout > 0 ? args.timeout : 120_000;
		const timeoutBehavior = Number.isSafeInteger(args.timeoutBehavior) ? args.timeoutBehavior : 0;
		try {
			const started = await startCursorShell(world, {
				command,
				workdir,
				timeoutMs,
				timeoutBehavior,
				sandboxPolicy: args.sandboxPolicy,
				signal,
				callId: id,
			});
			shellStreamChannels.set(id, started.channel);
			void pumpCursorShell(started, { sleep, createPidProbe }).catch((error) => {
				started.channel.error = error instanceof Error ? error.message : String(error);
				started.channel.exitCode = 1;
				started.channel.done = true;
			});
			void this.#forwardShellStream(exec, id, run, debug, persisted, terminalsFolder).then(() => {
				const channel = started.channel;
				const failed = channel.error !== undefined || (channel.exitCode !== 0 && channel.exitCode !== null && channel.backgrounded !== true);
				const text = channel.backgrounded === true
					? `${channel.stdout}\nstarted background job ${channel.jobId ?? `bash-${channel.pid ?? id}`}`
					: `${channel.stdout}${channel.exitCode === 0 ? "" : `\n[exit code: ${channel.exitCode}]`}`;
				settleCursorJoin(id, { text, isError: failed });
			});
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			shellStreamChannels.set(id, { chunks: [], stdout: "", done: true, exitCode: 1, error: text });
			void this.#forwardShellStream(exec, id, run, debug, persisted, terminalsFolder);
			settleCursorJoin(id, { text, isError: true });
		}
	}

	async #answerNativeBgShell({ world, exec, id, run, persisted, terminalsFolder, debug, signal }) {
		const args = exec.args ?? {};
		const command = args.command ?? "";
		const workdir = args.workingDirectory ?? "";
		try {
			const started = await startCursorShell(world, {
				command,
				workdir,
				background: true,
				sandboxPolicy: args.sandboxPolicy,
				signal,
				callId: id,
			});
			const shellId = started.shellId ?? nextBgShellId++;
			persisted.shells ??= new Map();
			const startedAt = Date.now();
			const filePath = join(terminalsFolder ?? os.tmpdir(), `${shellId}.txt`);
			const entry = {
				shellId,
				...(started.jobId !== undefined ? { jobId: String(started.jobId) } : {}),
				pid: undefined,
				pidProbe: createPidProbe(),
				command,
				cwd: workdir,
				title: args.description,
				proc: started.proc,
				filePath,
				log: typeof terminalsFolder === "string" && terminalsFolder.length > 0
					? createCursorTerminalLog(filePath, {
						cwd: workdir,
						command,
						title: args.description,
						startedAtMs: startedAt,
					})
					: undefined,
				startedAt,
				lastActivityAt: startedAt,
				absoluteTimer: setTimeout(() => {
					try { started.proc.kill(); } catch { /* already gone */ }
				}, CursorRunPump.BACKGROUND_SHELL_ABSOLUTE_MS),
				bytes: 0,
			};
			entry.absoluteTimer.unref?.();
			persisted.shells.set(shellId, entry);
			void this.#ensureBackgroundDrain(shellId, persisted, debug);
			await this.#waitForBackgroundPid(entry);
			this.#writeExecReply(run, exec, 16, encodeBackgroundShellSpawnSuccess({
				shellId,
				command,
				workingDirectory: workdir,
				...(entry.pid !== undefined ? { pid: entry.pid } : {}),
			}));
			settleCursorJoin(id, { text: `started background job ${started.jobId ?? `bash-${shellId}`}` });
			debug(`exec backgroundShellSpawnArgs id=${exec.id} shellId=${shellId} job=${started.jobId ?? "none"}`);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			this.#writeExecReply(run, exec, 16, encodeBackgroundShellSpawnError({
				command,
				workingDirectory: workdir,
				error: text,
			}));
			settleCursorJoin(id, { text, isError: true });
		}
	}

	async #waitForAllShellForwarders(debug) {
		const tasks = [...this.#shellForwarders.values()];
		if (tasks.length === 0) return;
		debug?.(`waiting for ${tasks.length} shell forwarder(s)`);
		await Promise.allSettled(tasks);
	}

	#evictStaleSessions() {
		const now = this.now();
		for (const [key, state] of this.#sessions) {
			if (now - (state.lastAccessMs ?? now) <= this.sessionStateTtlMs) continue;
			state.bridge?.pump?.terminate(new Error("Cursor session state expired"));
			state.bridge?.run.close();
			this.#killSessionShells(state);
			this.#sessions.delete(key);
		}
	}

	#sessionIdentity(sessionId) {
		if (sessionId === undefined) return undefined;
		try {
			const header = this.agents?.get(sessionId)?.session?.header;
			if (header == null || !Number.isInteger(header.createdAt) || header.createdAt < 0) {
				return undefined;
			}
			return {
				createdAt: header.createdAt,
				...(typeof header.cwd === "string" && header.cwd.length > 0 ? { cwd: header.cwd } : {}),
			};
		} catch {
			return undefined;
		}
	}

	#liveSession(sessionKey) {
		if (sessionKey === undefined) return undefined;
		try {
			return this.agents?.get(sessionKey)?.session;
		} catch {
			return undefined;
		}
	}

	#appendCheckpointMarker(sessionKey, record) {
		const session = this.#liveSession(sessionKey);
		if (session == null) return;
		try {
			appendCursorCheckpointEvent(session, {
				schemaVersion: CURSOR_CHECKPOINT_SCHEMA_VERSION,
				conversationId: record.conversationId,
				checkpoint: record.checkpoint,
				blobs: record.blobs ?? {},
				...(record.tokenDetails === undefined ? {} : { tokenDetails: record.tokenDetails }),
			}, this.publishSessionEvent);
		} catch (error) {
			cursorAgentDebug(`checkpoint log event failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#persistCheckpoint(sessionKey, persisted) {
		if (sessionKey === undefined || this.checkpointStore === undefined) return undefined;
		return this.checkpointStore.persist(sessionKey, persisted, this.#sessionIdentity(sessionKey)).then((record) => {
			if (record != null) this.#appendCheckpointMarker(sessionKey, record);
			return record;
		});
	}

	#sessionEvents(sessionKey) {
		const session = this.#liveSession(sessionKey);
		if (session == null) return { session, events: [] };
		const events = typeof session.snapshotEvents === "function"
			? session.snapshotEvents()
			: Array.isArray(session.log) ? session.log : [];
		return { session, events };
	}

	#copyPersisted(source, prior, keepLive) {
		return {
			checkpoint: source?.checkpoint === undefined ? undefined : Uint8Array.from(source.checkpoint),
			blobs: new Map(source?.blobs ?? (keepLive ? prior?.blobs : undefined) ?? []),
			todosFingerprint: keepLive ? prior?.todosFingerprint : undefined,
			conversationId: source?.conversationId ?? (keepLive ? prior?.conversationId : undefined) ?? randomUUID(),
			generationId: randomUUID(),
			pendingQuestions: keepLive && prior?.pendingQuestions !== undefined ? [...prior.pendingQuestions] : [],
			shells: keepLive ? prior?.shells : undefined,
			probeReads: new Map(),
			tokenDetails: source?.tokenDetails ?? (keepLive ? prior?.tokenDetails : undefined),
		};
	}

	/**
	 * Session log first when it has markers (rewind / edit / fork). Same pointer
	 * as the in-memory cache keeps live shells. No markers → cache, then the
	 * latest storageDomain row. Live shells / pending questions stay memory-only
	 * unless the log names a different checkpoint.
	 */
	async #hydratePersisted(sessionKey, prior) {
		let loaded;
		let logDecided = false;
		if (this.checkpointStore !== undefined) {
			try {
				const { session, events } = this.#sessionEvents(sessionKey);
				if (session != null && listCursorCheckpointEvents(events).length > 0) {
					logDecided = true;
					const picked = pickCursorCheckpointEvent(events, session.surface?.nodes);
					if (picked != null && prior?.checkpoint !== undefined
						&& pointerMatchesCheckpoint(picked.data.checkpoint, prior.checkpoint)) {
						return this.#copyPersisted(prior, prior, true);
					}
					if (picked != null) {
						loaded = await this.checkpointStore.loadPointers(picked.data);
					}
				} else if (prior?.checkpoint === undefined && sessionKey !== undefined) {
					loaded = await this.checkpointStore.load(sessionKey, this.#sessionIdentity(sessionKey));
				}
			} catch (error) {
				cursorAgentDebug(`checkpoint load failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (logDecided) return this.#copyPersisted(loaded, undefined, false);
		const source = prior?.checkpoint !== undefined ? prior : (loaded ?? prior);
		return this.#copyPersisted(source, prior, true);
	}

	invalidateDiscovery() {
		this.#modelsCache = { at: 0, models: undefined, catalog: undefined };
	}

	async #discoverModels(force = false) {
		const now = this.now();
		if (!force && this.#modelsCache.models !== undefined && now - this.#modelsCache.at < this.modelsCacheTtlMs) {
			return this.#modelsCache.models;
		}
		let catalog = [];
		try {
			const access = await this.auth.accessToken();
			try {
				catalog = catalogFromAvailableModels(await this.fetchAvailableModels(access, { baseUrl: this.settings().apiBaseUrl }));
			} catch {}
			if (catalog.length === 0) {
				let models = [];
				try {
					models = await this.fetchModels(access, { baseUrl: this.settings().apiBaseUrl });
				} catch {
					models = [];
				}
				const source = models.length > 0 ? models : this.fallbackModels;
				catalog = source.map((model) => ({
					id: model.id,
					name: model.name || model.id,
					aliases: [],
					efforts: [],
					contextWindow: Number.isFinite(model.contextWindow) && model.contextWindow > 0
						? model.contextWindow
						: DEFAULT_CONTEXT_WINDOW,
					supportsImages: false,
				}));
			}
		} catch {
			catalog = this.fallbackModels.map((model) => ({
				id: model.id,
				name: model.name || model.id,
				aliases: [],
				efforts: [],
				contextWindow: model.contextWindow,
				supportsImages: false,
			}));
		}
		const result = catalog.map((entry) => ({
			id: entry.id,
			name: entry.name || entry.id,
			inputModalities: inputModalitiesFromCatalog(entry),
			contextWindow: Number.isFinite(entry.contextWindow) && entry.contextWindow > 0
				? entry.contextWindow
				: DEFAULT_CONTEXT_WINDOW,
		}));
		this.#modelsCache = { at: now, models: result, catalog };
		return result;
	}

	async #resolveActionImages(options, persisted, selection, signal) {
		void persisted;
		const blocks = collectImageBlocks(classifyTurnIngress(options).users.map((entry) => entry.message));
		if (blocks.length === 0) return [];
		const entry = (this.#modelsCache.catalog ?? []).find((candidate) => candidate.id === selection.modelId);
		if (entry !== undefined && entry.supportsImages !== true) {
			throw new LlmError(`Cursor model "${selection.modelId}" does not accept image input`, "UNSUPPORTED_CONTENT");
		}
		return resolveSelectedImages(blocks, this.attachments?.(), signal);
	}

	#runSelection(options) {
		return resolveCursorModelSelection(this.#modelsCache.catalog ?? [], options.model, options.reasoningEffort);
	}

	#runModelOptions(options, selection = this.#runSelection(options)) {
		if (selection.fromCatalog !== true) return options;
		return {
			...options,
			useRequestedModel: true,
			requestedModelParameters: selection.parameters,
			requestedMaxMode: selection.maxMode,
		};
	}

	providerInfo(provider) {
		return { id: provider, name: "Cursor Agent" };
	}

	async listModels(provider) {
		const models = await this.#discoverModels();
		return models.map((model) => ({ provider, ...model }));
	}

	/** RPC-facing model listing; `force` bypasses the discovery cache. */
	async listModelsForRpc({ force = false, signal } : any = {}) {
		const models = await this.#discoverModels(force);
		if (signal?.aborted) throw new LlmError("Cursor model listing aborted", "ABORTED");
		return models;
	}

	async resolveModel(provider: any, model: any, _signal?: any): Promise<any> {
		let name = model;
		let reasoning;
		let catalog = [];
		try {
			await this.#discoverModels();
			catalog = this.#modelsCache.catalog ?? [];
			const listed = this.#modelsCache.models ?? [];
			const found = listed.find((entry) => entry.id === model);
			if (found !== undefined) name = found.name;
			const match = catalog.find((entry) => entry.id === model)
				?? catalog.find((entry) => entry.aliases.includes(model))
				?? catalog.find((entry) => entry.efforts.some((effort) =>
					effort.id === model
					|| effort.legacySlug === model
					|| effort.variantStringRepresentation === model
					|| model === `${entry.id}-${effort.id}`));
			if (match !== undefined) {
				if (found === undefined) name = match.name || match.id;
				reasoning = reasoningFromCatalogEntry(match);
			}
		} catch {}
		const selection = resolveCursorModelSelection(catalog, model);
		const catalogEntry = catalog.find((entry) => entry.id === selection.modelId);
		const catalogWindow = Number.isFinite(selection.contextWindow) && selection.contextWindow > 0
			? selection.contextWindow
			: undefined;
		return {
			provider,
			id: model,
			name,
			inputModalities: inputModalitiesFromCatalog(catalogEntry),
			context: {
				contextWindow: this.#contextWindowByModel.get(model) ?? catalogWindow ?? DEFAULT_CONTEXT_WINDOW,
			},
			defaultMaxTokens: DEFAULT_MAX_TOKENS,
			...reasoning === undefined ? {} : { reasoning },
		};
	}

	/**
	 * Yields one text block so session-title-llm's BlockAssembler can accept the NameAgent name.
	 */
	async *#emitSessionTitle(options, upstream) {
		const userMessage = extractSessionTitleUserMessage(options);
		if (userMessage.length === 0) {
			throw new LlmError("Cursor NameAgent requires a non-empty user message", "INVALID_REQUEST");
		}
		const access = await this.auth.accessToken({ signal: upstream });
		const named = await this.nameAgent(access, userMessage, { signal: upstream, baseUrl: this.settings().apiBaseUrl });
		const title = typeof named === "string" ? named.trim() : "";
		if (title.length === 0) {
			throw new LlmError("Cursor NameAgent returned an empty title", "CURSOR_ERROR");
		}
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text: title };
		yield { type: "block-end", index: 0, block: { type: "text", text: title } };
		yield { type: "finish", reason: { kind: "stop" } };
	}

	/**
	 * Idle `/compact`: a summarize_action Run (or a live-run write) that
	 * collects Cursor's summary text. Pump write-back is the DSH bracket.
	 */
	async summarizeConversation({ sessionId, model, signal } : any = {}) {
		let summary = "";
		for await (const chunk of this.stream({
			purpose: "cursor-summarize",
			sessionId,
			model,
			provider: PROVIDER,
			signal,
			messages: [],
		})) {
			if (chunk.type === "text-delta") summary += chunk.text;
			if (chunk.type === "finish" && chunk.reason?.kind === "error") {
				const failure = chunk.reason.failure ?? {};
				throw new LlmError(failure.message ?? "Cursor summarize failed", failure.code ?? "CURSOR_ERROR");
			}
		}
		return { summary };
	}

	async *stream(options: any): AsyncGenerator<any> {
		const consumer = new AbortController();
		const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
		const sessionKey = options.sessionId === undefined ? undefined : String(options.sessionId);
		// Title streams use NameAgent. A Run here would start a second billed agent conversation.
		if (options.purpose === "session-title") {
			try {
				this.gate?.(sessionKey);
				if (options.stop !== undefined) {
					throw new LlmError("cursor-agent does not support GenerateOptions.stop", "UNSUPPORTED_OPTION");
				}
				yield* this.#emitSessionTitle(options, upstream);
			} catch (error) {
				yield finishChunkForStreamError(error, upstream);
			} finally {
				consumer.abort("cursor stream consumer stopped");
			}
			return;
		}
		if (options.purpose === "compaction") {
			try {
				throw new LlmError(
					"cursor-agent does not support GenerateOptions.purpose \"compaction\"; Cursor summarizes on the server.",
					"UNSUPPORTED_OPTION",
				);
			} catch (error) {
				yield finishChunkForStreamError(error, upstream);
			} finally {
				consumer.abort("cursor stream consumer stopped");
			}
			return;
		}
		let run;
		let abortRun;
		let pump;
		let bridgeStored = false;
		let leftoverPending = [];
		let waitWork = async () => {};
		// Per-session terminal files root, used by the shell channels and the
		// background-shell registry (defined up front: the resume path needs it).
		const terminalsFolder = this.terminalsRoot !== undefined && sessionKey !== undefined
			? join(this.terminalsRoot, sessionKey)
			: undefined;
		this.#evictStaleSessions();
		const prior = sessionKey === undefined ? undefined : this.#sessions.get(sessionKey);
		const liveBridge = prior?.bridge;
		const livePump = liveBridge?.pump;
		const bridgeAlive = liveBridge !== undefined && livePump !== undefined && !livePump.stopped
			&& !liveBridge.run.finished && !liveBridge.run.stream?.destroyed;
		const toolResults = collectToolResults(options);
		const ingress = classifyTurnIngress(options);
		// SDK: a new user turn is always send() (checkpoint + this text).
		// Only resume the HTTP/2 Run to deliver tool results. A follow-up
		// human message on a still-open stream is a new Run, not InjectContext
		// (steer is inbox-only; rejected injects used to drop the user turn).
		const summarizeOnly = options.purpose === "cursor-summarize";
		const canResume = bridgeAlive && toolResults.length > 0 && !summarizeOnly;
		const writeSummarizeOnLive = summarizeOnly && bridgeAlive;
		// Persisted conversation state per session: the server's checkpoint,
		// referenced blobs, and (while an MCP tool runs) the live HTTP/2 bridge.
		// Resume must keep the pump's session object. Cloning checkpoint/blobs/
		// shells here (then later `pump.persisted = clone`) is the same class of
		// bug as swapping blobStore: the shell forwarder still mutates the old
		// object, and a checkpoint/setBlob that lands between the clone and the
		// re-point is dropped. A new turn snapshots; a resume reuses.
		let persisted = canResume && livePump.persisted !== undefined
			? livePump.persisted
			: await this.#hydratePersisted(sessionKey, prior);
		persisted.pendingQuestions ??= [];
		persisted.probeReads ??= new Map();
		persisted.displayCallIds ??= liveBridge?.displayCallIds ?? prior?.displayCallIds ?? new Map();
		persisted.pendingDisplayCalls ??= liveBridge?.pendingDisplayCalls ?? prior?.pendingDisplayCalls ?? new Map();
		const debug = cursorAgentDebug;
		try {
			// Preset gate: cursor-agent only answers sessions running the
			// cursor-agent preset. Runs before any network I/O; nothing is charged.
			this.gate?.(sessionKey);
			if (options.stop !== undefined) throw new LlmError("cursor-agent does not support GenerateOptions.stop", "UNSUPPORTED_OPTION");
			const requestSettings = resolveCursorSettings(this.settings());
			// Injection filter: exclude every DSH tool whose name collides with a
			// Cursor-native tool (both the natively-bridged set and the official
			// tools reused as execution backends). Cursor already knows those
			// tools from its own system prompt.
			const mcpTools = (options.tools ?? [])
				.filter((tool) => !isCursorNativeTool(tool.name) && !isDeniedCursorMcpTool(tool.name))
				.map((tool) =>
					encodeMcpToolDefinition({
						name: tool.name,
						description: tool.description,
						inputSchema: encodeValue(tool.parameters ?? {}),
					}),
				);
			// The StrReplace probe read and its write share one wire toolCallId
			// but arrive in DIFFERENT stream() calls, so the de-dupe set must
			// outlive a single stream — carry it on the live bridge.
			const usedToolCallIds = liveBridge?.usedToolCallIds ?? new Set();
			const displayCallIds = persisted.displayCallIds;
			const pendingDisplayCalls = persisted.pendingDisplayCalls;
			// A question answer arriving after its original run was cancelled.
			const questionMatch = (() => {
				for (const question of persisted.pendingQuestions) {
					const result = toolResults.find((entry) => entry.toolCallId === question.toolCallId);
					if (result !== undefined) return { question, result };
				}
				return undefined;
			})();
			let toolRoundCount = canResume || writeSummarizeOnLive ? (liveBridge.toolRoundCount ?? 0) : 0;
			let blobStore;
			let parkForLeftovers = false;
			if (writeSummarizeOnLive) {
				run = liveBridge.run;
				pump = livePump;
				blobStore = livePump.blobStore;
				persisted.blobs = livePump.blobStore;
				abortRun = () => run.abort(new Error("Cursor request aborted by caller"));
				upstream.addEventListener("abort", abortRun, { once: true });
				if (upstream.aborted) abortRun();
				if (!run.writeMessage(encodeConversationActionMessage(encodeSummarizeAction()))) {
					throw new Error("Cursor agent bridge closed before accepting summarize");
				}
				debug("summarize on live run");
			} else if (canResume) {
				// Live bridge: write the DSH tool results into the still-open run.
				run = liveBridge.run;
				pump = livePump;
				blobStore = livePump.blobStore;
				persisted.blobs = livePump.blobStore;
				abortRun = () => run.abort(new Error("Cursor request aborted by caller"));
				upstream.addEventListener("abort", abortRun, { once: true });
				if (upstream.aborted) abortRun();
				const partitioned = partitionPendingExecs(liveBridge.pendingExecs, toolResults);
				leftoverPending = partitioned.leftover;
				parkForLeftovers = leftoverPending.some((entry) => entry.kind !== "shell" && entry.kind !== "join");
				if (leftoverPending.length > 0) {
					debug(`resume leftover ${leftoverPending.length} exec(s) (${leftoverPending.map((entry) => entry.kind).join(",")}); park=${parkForLeftovers}`);
				}
				for (const { pending, result } of partitioned.ready) {
					if (pending.kind === "join") {
						debug(`resume join toolCallId=${pending.toolCallId} (wire already answered)`);
						continue;
					}
					if (pending.kind === "shell") {
						// The forwarder answers start → deltas → exit →
						// shellResult + stream_close from the tool's live
						// channel. Resume used to assume that work was already
						// on the wire; the bash tool can settle (and DSH call
						// stream() again) up to one poll tick before the
						// forwarder writes the close. Wait, then never answer
						// twice.
						const forwarded = this.#shellForwarders.get(pending.id);
						if (forwarded !== undefined) {
							debug(`resume shell id=${pending.id} waiting for stream task`);
							await forwarded;
						} else {
							debug(`resume shell id=${pending.id} (result already forwarded by the stream task)`);
						}
						continue;
					}
					if (pending.kind === "bgshell") {
						// Background bash: the tool spawned the process and handed
						// it over through the module map; answer the spawn result
						// and register the live process for drain/eviction. The
						// map is written before execute() returns, but a
						// same-tick resume can still observe a hole — wait briefly
						// instead of answering "spawn failed" and closing the exec.
						let bg = bgShellSpawns.get(pending.toolCallId);
						if (bg === undefined) {
							const deadline = Date.now() + 2000;
							while (bg === undefined && Date.now() < deadline) {
								await sleep(20);
								bg = bgShellSpawns.get(pending.toolCallId);
							}
						}
						bgShellSpawns.delete(pending.toolCallId);
						if (bg?.proc !== undefined) {
							const shellId = bg.shellId;
							persisted.shells ??= new Map();
							const startedAt = Date.now();
							const filePath = join(terminalsFolder ?? os.tmpdir(), `${shellId}.txt`);
							const entry = {
								shellId,
								...(bg.jobId !== undefined ? { jobId: String(bg.jobId) } : {}),
								pid: undefined,
								pidProbe: createPidProbe(),
								command: pending.command,
								cwd: pending.cwd,
								title: pending.description,
								proc: bg.proc,
								filePath,
								log: typeof terminalsFolder === "string" && terminalsFolder.length > 0
									? createCursorTerminalLog(filePath, {
										cwd: pending.cwd,
										command: pending.command,
										title: pending.description,
										startedAtMs: startedAt,
									})
									: undefined,
								startedAt,
								lastActivityAt: startedAt,
								absoluteTimer: setTimeout(() => {
									try {
										bg.proc.kill();
									} catch {}
								}, CursorRunPump.BACKGROUND_SHELL_ABSOLUTE_MS),
								bytes: 0,
							};
							entry.absoluteTimer.unref?.();
							persisted.shells.set(shellId, entry);
							// Drain is the only reader. Waiting here for pid
							// must not call readOutput() or the terminal file
							// loses the probe line and early output.
							void this.#ensureBackgroundDrain(shellId, persisted, debug);
							await this.#waitForBackgroundPid(entry);
							debug(`resume bgshell id=${pending.id} shellId=${shellId} job=${bg.jobId ?? "none"} pid=${entry.pid ?? "none"} spawned`);
							run.writeMessage(encodeExecClientMessageEnvelope(encodeExecClientMessage(pending.id, pending.execId, 16, encodeBackgroundShellSpawnSuccess({
								shellId,
								command: pending.command,
								workingDirectory: pending.cwd,
								...(entry.pid !== undefined ? { pid: entry.pid } : {}),
							}))));
						} else {
							debug(`resume bgshell id=${pending.id} failed: ${bg?.error ?? "spawn failed"}`);
							run.writeMessage(encodeExecClientMessageEnvelope(encodeExecClientMessage(pending.id, pending.execId, 16, encodeBackgroundShellSpawnError({
								command: pending.command,
								workingDirectory: pending.cwd,
								error: bg?.error ?? "spawn failed",
							}))));
						}
						run.writeMessage(encodeExecStreamClose(pending.id));
						continue;
					}
					if (pending.kind === "exec") {
						// Native Cursor tool: encode the DSH tool result into the
						// tool's native result message (Read/Write/Delete).
						debug(`resume exec id=${pending.id} toolCallId=${pending.toolCallId} result=${result.isError ? "error" : "ok"}:${result.content.length} chars`);
						const payload = pending.encode(result.content, result.isError);
						if (!run.writeMessage(encodeExecClientMessageEnvelope(encodeExecClientMessage(pending.id, pending.execId, pending.field, payload)))) {
							throw new Error("Cursor tool continuation bridge closed before accepting the result");
						}
						debug(`stream_close id=${pending.id}`);
						run.writeMessage(encodeExecStreamClose(pending.id));
					} else if (pending.kind === "mcp") {
						debug(`resume mcp id=${pending.id} toolCallId=${pending.toolCallId} result=${result.isError ? "error" : "ok"}:${result.content.length} chars`);
						const payload = encodeMcpResult(result);
						if (!run.writeMessage(encodeExecClientMessageEnvelope(encodeExecClientMessage(pending.id, pending.execId, 11, payload)))) {
							throw new Error("Cursor tool continuation bridge closed before accepting the result");
						}
						debug(`stream_close id=${pending.id}`);
						run.writeMessage(encodeExecStreamClose(pending.id));
					}
				}
			} else {
				if (liveBridge !== undefined) {
					await this.#waitForShellForwarders(liveBridge.pendingExecs, debug);
					livePump?.terminate(new Error("Cursor conversation bridge replaced by a new turn"));
					liveBridge.run.close();
				}
				const access = await this.auth.accessToken({ signal: upstream });
				await this.#discoverModels();
				const selection = this.#runSelection(options);
				const selectedImages = await this.#resolveActionImages(options, persisted, selection, upstream);
				const runOptions = { ...this.#runModelOptions(options, selection), selectedImages };
				const requestedModel = selection.fromCatalog === true ? encodeRequestedModel(selection) : undefined;
				let built;
				let replayingQuestion = false;
				if (summarizeOnly) {
					const conversationState = persisted.checkpoint ?? encodeConversationState({ rootPromptBlobIds: [], turns: [] });
					built = buildCustomRunPayload({
						conversationState,
						actionBytes: encodeSummarizeAction(),
						modelId: selection.modelId,
						conversationId: persisted.conversationId,
						blobStore: persisted.blobs,
						requestedModel,
						runId: persisted.generationId,
					});
					debug(`summarize run checkpoint=${persisted.checkpoint !== undefined} conversation=${persisted.conversationId}`);
				} else if (questionMatch !== undefined) {
					// The answer to a cancelled-run question: deliver it through
					// the protocol-native async completion action on a fresh run.
					const { question, result } = questionMatch;
					replayingQuestion = true;
					debug(`async ask-question completion toolCallId=${question.toolCallId} result=${result.isError ? "error" : "ok"}`);
					const resultBytes = buildAskQuestionResultBytes(question.questions, result);
					const actionBytes = encodeAsyncAskQuestionCompletionAction({
						originalToolCallId: question.toolCallId,
						originalArgsBytes: question.rawArgs,
						resultBytes,
					});
					const conversationState = persisted.checkpoint ?? encodeConversationState({ rootPromptBlobIds: [], turns: [] });
					built = buildCustomRunPayload({
						conversationState,
						actionBytes,
						modelId: selection.modelId,
						conversationId: persisted.conversationId,
						blobStore: persisted.blobs,
						requestedModel,
						runId: persisted.generationId,
					});
				} else if (liveBridge !== undefined && (liveBridge.pendingExecs?.length ?? 0) > 0 && toolResults.length > 0) {
					// The dying pump still holds request-time blobs the
					// checkpoint refers to; fold them in before replay.
					persisted.blobs = adoptBlobStore(persisted.blobs, livePump?.blobStore);
					// The bridge died while MCP tools ran: replay the paired
					// calls + results as turn steps on a resume run.
					const stepBlobs = [];
					for (const pending of liveBridge.pendingExecs) {
						if (pending.kind !== "mcp") {
							debug(`replay skip ${pending.kind} id=${pending.id} (no replay channel)`);
							continue;
						}
						const result = toolResults.find((entry) => entry.toolCallId === pending.toolCallId);
						if (result === undefined) {
							debug(`replay skip mcp id=${pending.id} (result not yet available)`);
							continue;
						}
						stepBlobs.push(encodeMcpToolCallStep(pending.rawArgs, encodeMcpResult(result)));
					}
					if (stepBlobs.length === 0) {
						built = buildRunPayload(runOptions, selection.modelId, persisted, persisted.conversationId);
					} else {
						debug(`replay run: ${stepBlobs.length} MCP step(s)`);
						blobStore = persisted.blobs;
						const turnId = encodeReplayTurnBlob(blobStore, { stepBlobs });
						const conversationState = persisted.checkpoint !== undefined
							? appendTurnsToCheckpoint(persisted.checkpoint, [turnId])
							: encodeConversationState({ rootPromptBlobIds: [], turns: [turnId] });
						built = buildCustomRunPayload({
							conversationState,
							actionBytes: encodeResumeAction(),
							modelId: selection.modelId,
							conversationId: persisted.conversationId,
							blobStore,
							requestedModel,
							runId: persisted.generationId,
						});
					}
				} else {
					built = buildRunPayload(runOptions, selection.modelId, persisted, persisted.conversationId);
					debug(`new run checkpoint=${persisted.checkpoint !== undefined} conversation=${persisted.conversationId}`);
				}
				// One map for request-time storeBlob ids and later setBlob
				// writes. A parked resume that swapped these used to drop the
				// request blobs and stall the next getBlob.
				blobStore = adoptBlobStore(persisted.blobs, built.blobStore);
				persisted.blobs = blobStore;
				let retriesUsed = 0;
				for (;;) {
					run = this.createAgentRun(access);
					await run.start();
					abortRun = () => run.abort(new Error("Cursor request aborted by caller"));
					upstream.addEventListener("abort", abortRun, { once: true });
					if (upstream.aborted) abortRun();
					if (!run.writeMessage(built.payload)) throw new Error("Cursor agent bridge closed before accepting the request");
					const status = await run.waitForResponse(this.idleTimeoutMs);
					if (isSuccessfulAgentResponse(status, run.responseContentType)) {
						run.startHeartbeat();
						break;
					}
					upstream.removeEventListener("abort", abortRun);
					abortRun = undefined;
					run.close();
					if (status === 200) {
						throw new LlmError(
							`Cursor agent returned an unexpected content type: ${run.responseContentType ?? "missing"}`,
							"CURSOR_PROTOCOL",
						);
					}
					if (!shouldRetryHttpStatus(status, retriesUsed, requestSettings)) {
						const message = `Cursor agent returned HTTP ${status}`;
						throw new LlmError(message, classifyCursorError(message));
					}
					retriesUsed++;
					await this.sleep(requestSettings.retryIntervalMs, upstream);
				}
				// The run accepted the answer; consume the pending question so a
				// later stream does not deliver it twice.
				if (replayingQuestion) {
					persisted.pendingQuestions = persisted.pendingQuestions.filter((entry) => entry.toolCallId !== questionMatch.question.toolCallId);
				}
			}
			// A resumed bridge keeps its existing pump (one pump per run — a
			// second reader on the same frame queue would steal frames).
			if (pump === undefined) {
				pump = new CursorRunPump({
					run,
					persisted,
					sessionKey,
					mcpTools,
					parkedTimeoutMs: requestSettings.parkedBridgeTimeoutMs,
					syncTodos: this.syncTodos !== undefined ? this.syncTodos.bind(this) : undefined,
					debug,
					shellService: this.shellService,
					jobs: this.jobs,
					terminalsFolder,
					sessionCwd: this.agents?.get(sessionKey)?.session?.header?.cwd,
					sandboxPolicy: this.sandboxPolicy,
					agent: this.agents?.get(sessionKey),
					systemText: ingress.systemText,
					generationId: persisted.generationId,
					attachments: this.attachments,
					persistCheckpoint: sessionKey === undefined || this.checkpointStore === undefined
						? undefined
						: (state) => this.#persistCheckpoint(sessionKey, state),
				});
			}
			pump.mcpTools = mcpTools;
			pump.blobStore = blobStore;
			pump.systemText = ingress.systemText;
			pump.generationId = persisted.generationId ?? pump.generationId;
			pump.summarizeKeepTail = !summarizeOnly;
			// New runs attach the snapshot. A resume already holds this object
			// (forwarder + KV + checkpoint writes); do not replace it.
			if (pump.persisted !== persisted) pump.persisted = persisted;
			// Live resume: human steers + plugin injects go on the open Run.
			// New run: only plugin injects (the human text is the action).
			// Summarize carries no DSH ingress — Cursor already has the checkpoint.
			if (!summarizeOnly) await pump.injectTurnIngress(ingress, { includeUsers: canResume });

			const started = this.now();
			let lastActivity = started;
			let lastProgress = started;
			let workInFlight = 0;
			const workTasks = [];
			const trackWork = (promise) => {
				workInFlight += 1;
				const tracked = Promise.resolve(promise).finally(() => {
					workInFlight -= 1;
					lastProgress = this.now();
					lastActivity = this.now();
				});
				workTasks.push(tracked);
				return tracked;
			};
			waitWork = async () => {
				if (workTasks.length === 0) return;
				await Promise.allSettled(workTasks.splice(0, workTasks.length));
			};
			const hasNativeWork = () => workInFlight > 0 || this.#shellForwarders.size > 0;
			const idleCheck = setInterval(() => {
				const now = this.now();
				if (now - lastActivity > this.idleTimeoutMs) {
					run.abort(new Error("Cursor stream idle timeout"));
				} else if (!hasNativeWork() && now - lastProgress > this.progressTimeoutMs) {
					run.abort(new Error(`Cursor stream progress timeout: no content for ${this.progressTimeoutMs}ms`));
				}
			}, this.idleCheckIntervalMs);
			idleCheck.unref?.();

			// The pump owns frame reads from here on; housekeeping frames it
			// answers still count as activity for the idle watchdog.
			pump.activityHook = () => {
				lastActivity = this.now();
			};
			pump.attach();

			let emittedToolCall = false;
			let toolCallBuffer = undefined;
			let textOutput = "";
			let outputTokens = 0;
			let turnUsage;
			let streamClosed = false;
			let terminalErrorEmitted = false;
			let toolCallPending = false;
			let toolRoundCounted = false;
			const pendingExecs = [];
			// One DSH step per Cursor tool batch. Thinking after a yielded
			// join is unread onto the next stream() so the assembler never
			// concatenates rounds.
			const streamBlocks = createStreamBlocks();
			let execBatchPending = false;
			const beginJoin = (id) => {
				openCursorJoin(id);
				pendingExecs.push({ kind: "join", toolCallId: id });
				emittedToolCall = true;
				toolCallPending = true;
				execBatchPending = true;
			};

			try {
				if (parkForLeftovers) {
					// A half-delivered step: answering the missing execs would
					// close them. Return so DSH can finish the rest and resume.
					debug("resume parked for leftover execs (partial tool results)");
					emittedToolCall = true;
					toolCallPending = true;
					streamClosed = true;
				}
				for (;;) {
					if (parkForLeftovers) break;
					const frame = await pump.next();
					if (frame === undefined) {
						break;
					}
					lastActivity = this.now();
					if ((frame.flags & CONNECT_END_STREAM_FLAG) !== 0) {
						debug("frame end-stream");
						const end = parseEndStream(frame.payload);
						if (end !== undefined) {
							terminalErrorEmitted = true;
							yield {
								type: "finish",
								reason: {
									kind: "error",
									failure: {
										message: end.message,
										code: classifyCursorError(`${end.code} ${end.debugCode ?? ""} ${end.message}`),
									},
								},
							};
							streamClosed = true;
							break;
						}
						break;
					}
					const message = decodeAgentServerMessage(frame.payload);
					// Full frame trace: every message that arrives is logged, so
					// a heartbeat-only silence window is visible as a run of
					// heartbeat lines instead of an unexplained gap.
					debug(`frame ${message.case}${message.value?.type !== undefined ? `:${message.value.type}` : ""}${message.case === "unknown" ? " (unparsed)" : ""}`);
					// Heartbeats keep the connection alive but are not content
					// progress; a server that only pings us (e.g. after an empty
					// partialToolCall placeholder) must still hit the stall timeout
					// instead of leaving the UI spinning forever.
					if (!(message.case === "interactionUpdate" && message.value?.type === "heartbeat")) {
						lastProgress = this.now();
					}
					if (execBatchPending && isNextRoundContent(message)) {
						debug("drain closed by next-round content");
						pump.unread(frame);
						streamClosed = true;
						break;
					}
					if (message.case === "conversationCheckpointUpdate") {
						// Capture + todo mirroring happen in the pump the moment the
						// frame lands (so parked runs stay current too); the consumer
						// only decides when to hand the batched tool calls to DSH.
						debug(`checkpoint bytes=${message.value.length}`);
						if (toolCallPending) {
							// Cursor emits this checkpoint after mcpArgs (and after an
							// exec batch). Keep the same Run alive; the next DSH step
							// resumes it with the tool results.
							streamClosed = true;
							break;
						}
					} else if (message.case === "interactionUpdate") {
						const update = message.value;
						if (update.type === "textDelta") {
							if (update.text.length > 0) {
								textOutput += update.text;
								for (const chunk of streamBlocks.text(update.text)) yield chunk;
							}
						} else if (update.type === "thinkingDelta") {
							if (update.text.length > 0) {
								for (const chunk of streamBlocks.reasoning(update.text)) yield chunk;
							}
						} else if (update.type === "tokenDelta") {
							if (Number.isFinite(update.tokens) && update.tokens > 0) outputTokens = update.tokens;
						} else if (update.type === "turnEnded") {
							turnUsage = {
								inputTokens: update.inputTokens,
								outputTokens: update.outputTokens,
								cacheReadTokens: update.cacheReadTokens,
								cacheWriteTokens: update.cacheWriteTokens,
								reasoningTokens: update.reasoningTokens,
							};
							debug(`turnEnded tokens in=${update.inputTokens ?? 0} out=${update.outputTokens ?? 0} cacheRead=${update.cacheReadTokens ?? 0} cacheWrite=${update.cacheWriteTokens ?? 0}`);
						} else if (update.type === "partialToolCall") {
							// Cursor's internal tool-call announcements: buffered
							// only. The DSH tool-call blocks come from the exec
							// translations (real name + arguments); yielding
							// announcement blocks here collided with them at the
							// same block index, dropping or hanging every tool
							// call after the first in a stream.
							if (toolCallBuffer === undefined || toolCallBuffer.id !== update.callId) {
								toolCallBuffer = { id: update.callId, name: "", arguments: "" };
							}
							if (update.argsTextDelta.length > 0) {
								toolCallBuffer.arguments += update.argsTextDelta;
							}
						} else if (update.type === "toolCallCompleted" && update.display !== undefined && update.display.displayKind !== undefined) {
							// Pump also settles (including while parked). Replay here
							// is idempotent; if completed raced ahead of started the
							// stash is flushed when the id is bound.
							const display = update.display;
							rememberDisplayCompletion(persisted, display);
							if (display.displayKind === "update_todos" && display.call?.error === undefined && display.call?.todos !== undefined) {
								this.syncTodos?.(sessionKey, normalizeCursorTodos(display.call.todos));
							}
							debug(`display ${display.displayKind} completed id=${displayCallIds.get(display.callId) ?? display.callId}`);
						} else if (update.type === "toolCallStarted" && update.display !== undefined && update.display.displayKind !== undefined) {
							const display = update.display;
							const toolArgs = mapRendererToolArgs(display);
							if (toolArgs !== undefined && !displayCallIds.has(display.callId)) {
								const id = allocateLocalToolCallId(display.callId, usedToolCallIds);
								beginJoin(id);
								bindDisplayCallId(persisted, display, id, { runEnded: pump.stopped });
								for (const chunk of emitToolCall(streamBlocks, { id, name: display.name, args: toolArgs })) yield chunk;
								debug(`display ${display.displayKind} → join ${display.name} id=${id}`);
							}
						} else if (update.type === "toolCallStarted" || update.type === "toolCallCompleted" || update.type === "toolCallDelta") {
							emittedToolCall = true;
						} else if (update.type === "summary") {
							if (summarizeOnly && update.text.length > 0) {
								for (const chunk of streamBlocks.text(update.text)) yield chunk;
							}
						} else if (update.type === "summaryStarted" || update.type === "summaryCompleted") {
							debug(`summary ${update.type}`);
						}
					} else if (message.case === "interactionQuery") {
						const query = message.value;
						debug(`interaction ${query.case} id=${query.id}`);
						if (query.case === "askQuestionInteractionQuery") {
							if (!toolRoundCounted) {
								toolRoundCount++;
								toolRoundCounted = true;
							}
							if (toolRoundCount > requestSettings.maxToolRounds) {
								throw new LlmError(
									`Cursor tool-call safety limit reached after ${requestSettings.maxToolRounds} rounds. The run was stopped to prevent an infinite loop; send a new message to continue if needed.`,
									"TOOL_LIMIT",
								);
							}
							const interaction = query.value ?? {};
							const questions = interaction.args?.questions ?? [];
							// AskQuestionArgs → DSH ask_user_question params. Option
							// picks come back as labels and are reverse-mapped onto
							// the Cursor option ids in buildAskQuestionResultBytes.
							const dshQuestions = questions.map((question) => {
								const mapped: any = { id: String(question.id ?? ""), question: String(question.prompt ?? "") };
								if (interaction.args?.title) mapped.header = interaction.args.title;
								if (Array.isArray(question.options) && question.options.length > 0) {
									mapped.options = question.options.map((option) => ({ label: String(option.label ?? "") }));
								}
								if (question.allowMultiple === true) mapped.multi_select = true;
								return mapped;
							});
							if (dshQuestions.length === 0) {
								run.writeMessage(encodeInteractionResponseEnvelope(encodeAskQuestionInteractionResponse({
									id: query.id,
									resultBytes: encodeAskQuestionResultError("The AskQuestion query carried no questions"),
								})));
								continue;
							}
							await waitWork();
							emittedToolCall = true;
							const id = interaction.toolCallId || crypto.randomUUID();
							const argsText = JSON.stringify({ questions: dshQuestions });
							const blockIndex = streamBlocks.toolCall();
							yield { type: "block-start", index: blockIndex, blockType: "tool-call" };
							yield {
								type: "tool-call-delta",
								index: blockIndex,
								id: ToolCallId(id),
								name: "ask_user_question",
								argumentsDelta: argsText,
							};
							yield {
								type: "block-end",
								index: blockIndex,
								block: {
									type: "tool-call",
									id: ToolCallId(id),
									name: "ask_user_question",
									arguments: argsText,
								},
							};
							// Questions never park the run. The server-side run is
							// cancelled when this stream ends; the answer arrives on a
							// later stream and is delivered through the protocol-native
							// AsyncAskQuestionCompletionAction (fresh run).
							persisted.pendingQuestions.push({
								id: query.id,
								toolCallId: id,
								rawArgs: interaction.rawArgs,
								questions,
							});
							toolCallPending = true;
							streamClosed = true;
							break;
						}
					} else if (message.case === "execServerMessage") {
						const exec = message.value;
						if (exec.case === "mcpArgs") {
							if (!toolRoundCounted) {
								toolRoundCount++;
								toolRoundCounted = true;
							}
							if (toolRoundCount > requestSettings.maxToolRounds) {
								throw new LlmError(
									`Cursor tool-call safety limit reached after ${requestSettings.maxToolRounds} rounds. The run was stopped to prevent an infinite loop; send a new message to continue if needed.`,
									"TOOL_LIMIT",
								);
							}
							await waitWork();
							emittedToolCall = true;
							// decodeExecServerMessage nests the parsed McpArgs under
							// `exec.args`: { name, toolCallId, providerIdentifier, toolName, args }.
							const mcp = exec.args ?? {};
							const args: any = {};
							for (const [key, value] of Object.entries(mcp.args ?? {})) {
								try {
									args[key] = decodeValue(value);
								} catch {
									args[key] = null;
								}
							}
							const id = allocateLocalToolCallId(mcp.toolCallId || exec.execId, usedToolCallIds);
							const name = mcp.toolName || mcp.name;
							const blockIndex = streamBlocks.toolCall();
							yield { type: "block-start", index: blockIndex, blockType: "tool-call" };
							yield {
								type: "tool-call-delta",
								index: blockIndex,
								id: ToolCallId(id),
								name,
								argumentsDelta: JSON.stringify(args),
							};
							yield {
								type: "block-end",
								index: blockIndex,
								block: {
									type: "tool-call",
									id: ToolCallId(id),
									name,
									arguments: JSON.stringify(args),
								},
							};
							pendingExecs.push({ id: exec.id, execId: exec.execId, toolCallId: id, kind: "mcp", rawArgs: exec.rawArgs });
							toolCallPending = true;
							// Do not close the Run. Cursor sends blob writes + a checkpoint
							// immediately after mcpArgs; once captured, return tool-calls to DSH
							// while preserving this bridge for the result.
							streamClosed = true;
						} else if (exec.case === "shellStreamArgs") {
							toolRoundCount++;
							if (toolRoundCount > requestSettings.maxToolRounds) {
								throw new LlmError(
									`Cursor tool-call safety limit reached after ${requestSettings.maxToolRounds} rounds. The run was stopped to prevent an infinite loop; send a new message to continue if needed.`,
									"TOOL_LIMIT",
								);
							}
							const shellArgs = exec.args ?? {};
							const id = allocateLocalToolCallId(shellArgs.toolCallId || exec.execId, usedToolCallIds);
							const world = worldFromAgent(this.agents?.get(sessionKey));
							const toolArgs: any = { command: shellArgs.command ?? "" };
							if (shellArgs.workingDirectory) toolArgs.workdir = shellArgs.workingDirectory;
							if (typeof shellArgs.description === "string" && shellArgs.description.length > 0) toolArgs.description = shellArgs.description;
							beginJoin(id);
							for (const chunk of emitToolCall(streamBlocks, { id, name: "bash", args: toolArgs })) yield chunk;
							debug(`exec shellStreamArgs id=${exec.id} → exec-plane bash`);
							trackWork(this.#answerNativeShell({
								world, exec, id, run, persisted, terminalsFolder, debug, signal: upstream,
							}));
							continue;
						} else if (exec.case === "backgroundShellSpawnArgs") {
							toolRoundCount++;
							if (toolRoundCount > requestSettings.maxToolRounds) {
								throw new LlmError(
									`Cursor tool-call safety limit reached after ${requestSettings.maxToolRounds} rounds. The run was stopped to prevent an infinite loop; send a new message to continue if needed.`,
									"TOOL_LIMIT",
								);
							}
							const bgArgs = exec.args ?? {};
							const bgId = allocateLocalToolCallId(bgArgs.toolCallId || exec.execId, usedToolCallIds);
							const world = worldFromAgent(this.agents?.get(sessionKey));
							const toolArgs: any = { command: bgArgs.command ?? "", background: true };
							if (bgArgs.workingDirectory) toolArgs.workdir = bgArgs.workingDirectory;
							beginJoin(bgId);
							for (const chunk of emitToolCall(streamBlocks, { id: bgId, name: "bash", args: toolArgs })) yield chunk;
							debug(`exec backgroundShellSpawnArgs id=${exec.id} → exec-plane bash(background)`);
							trackWork(this.#answerNativeBgShell({
								world, exec, id: bgId, run, persisted, terminalsFolder, debug, signal: upstream,
							}));
							continue;
						} else if (exec.case === "grepArgs") {
							toolRoundCount++;
							if (toolRoundCount > requestSettings.maxToolRounds) {
								throw new LlmError(
									`Cursor tool-call safety limit reached after ${requestSettings.maxToolRounds} rounds. The run was stopped to prevent an infinite loop; send a new message to continue if needed.`,
									"TOOL_LIMIT",
								);
							}
							const classified = classifyCursorSearch(exec.args ?? {});
							const id = allocateLocalToolCallId(exec.args?.toolCallId || exec.execId, usedToolCallIds);
							const world = worldFromAgent(this.agents?.get(sessionKey));
							beginJoin(id);
							for (const chunk of emitToolCall(streamBlocks, { id, name: classified.displayName, args: classified.displayArgs })) yield chunk;
							trackWork(this.#answerNativeSearch({
								world, exec, classified, id, run, debug, signal: upstream,
							}));
							continue;
						} else if (exec.case === "readArgs" || exec.case === "writeArgs" || exec.case === "deleteArgs") {
							toolRoundCount++;
							if (toolRoundCount > requestSettings.maxToolRounds) {
								throw new LlmError(
									`Cursor tool-call safety limit reached after ${requestSettings.maxToolRounds} rounds. The run was stopped to prevent an infinite loop; send a new message to continue if needed.`,
									"TOOL_LIMIT",
								);
							}
							const translated = translateNativeExec(exec);
							if (translated === undefined || translated.reject !== undefined) {
								const reply = translated?.reject !== undefined
									? { field: translated.field, payload: translated.reject }
									: rejectionFor(exec);
								if (reply !== undefined) {
									run.writeMessage(encodeExecClientMessageEnvelope(encodeExecClientMessage(exec.id, exec.execId, reply.field, reply.payload)));
								}
								continue;
							}
							const rawId = exec.args?.toolCallId || exec.execId;
							persisted.probeReads ??= new Map();
							const id = allocateLocalToolCallId(rawId, usedToolCallIds);
							const world = worldFromAgent(this.agents?.get(sessionKey));
							beginJoin(id);
							for (const chunk of emitToolCall(streamBlocks, { id, name: translated.tool, args: translated.args })) yield chunk;
							debug(`exec ${exec.case} id=${exec.id} → exec-plane ${translated.tool}`);
							trackWork(this.#answerNativeFs({
								world, exec, id, rawId, run, persisted, debug, signal: upstream,
							}));
							continue;
						} else {
							const reply = rejectionFor(exec);
							if (reply !== undefined) {
								run.writeMessage(encodeExecClientMessageEnvelope(encodeExecClientMessage(exec.id, exec.execId, reply.field, reply.payload)));
							} else {
								// Unknown exec variant (newer protocol frames: subagent=28,
								// executeHook=27, redactedRead=29, mcpState=36, allowlist
								// prechecks=41-43, Pi=45-51, ...). An unanswered frame
								// leaves the server waiting forever, so fail it in band
								// with the protocol's own failure channel (opencodex T05):
								// ExecClientThrow + stream_close. The server surfaces the
								// error to the model instead of blocking on silence.
								debug(`exec ${exec.case} unsupported → throw+close id=${exec.id}`);
								run.writeMessage(encodeExecThrow(exec.id, "Unknown exec message variant; this client does not implement it.", "exec_variant_unsupported"));
								run.writeMessage(encodeExecStreamClose(exec.id));
							}
						}
					}
					// First non-batch frame (heartbeat, checkpoint already
					// handled above) closes this DSH step so the scheduler
					// can join the already-running execs.
					if (execBatchPending && !isJoinBatchFrame(message)) {
						debug(`drain closed by ${message.case}${message.value?.type !== undefined ? `:${message.value.type}` : ""}`);
						streamClosed = true;
						break;
					}
				}
			} finally {
				clearInterval(idleCheck);
			}

			await waitWork();
			if (!toolCallPending) {
				await this.#waitForAllShellForwarders(debug);
			}
			leftoverPending = leftoverPending.filter((entry) => entry.kind !== "shell");

			if (!terminalErrorEmitted && !toolCallPending) {
				const textToolCalls = parseTextToolCalls(textOutput, options.tools ?? []);
				for (const call of textToolCalls) {
					const blockIndex = streamBlocks.toolCall();
					yield { type: "block-start", index: blockIndex, blockType: "tool-call" };
					yield {
						type: "tool-call-delta",
						index: blockIndex,
						id: ToolCallId(call.id),
						name: call.name,
						argumentsDelta: call.arguments,
					};
					yield {
						type: "block-end",
						index: blockIndex,
						block: { type: "tool-call", id: ToolCallId(call.id), name: call.name, arguments: call.arguments },
					};
				}
				if (textToolCalls.length > 0) {
					emittedToolCall = true;
					streamClosed = true;
				}
			}

			const pendingExecsToStore = leftoverPending.length === 0 ? pendingExecs : [...leftoverPending, ...pendingExecs];
			const liveToolBridge = !run.finished && pendingExecsToStore.length > 0 && (toolCallPending || leftoverPending.length > 0);
			if (sessionKey !== undefined) {
				persisted.lastAccessMs = this.now();
				if (liveToolBridge) {
					persisted.bridge = { run, pump, pendingExecs: pendingExecsToStore, toolRoundCount, usedToolCallIds, displayCallIds, pendingDisplayCalls };
					pump.bridge = persisted.bridge;
					bridgeStored = true;
				} else {
					persisted.bridge = undefined;
				}
				// Refresh insertion order for simple LRU-style eviction. A checkpoint
				// may reference every retained blob, so prune whole sessions rather than
				// individual blobs. Close an evicted live bridge to avoid socket leaks.
				this.#sessions.delete(sessionKey);
				this.#sessions.set(sessionKey, persisted);
				while (this.#sessions.size > 100) {
					const oldest = this.#sessions.keys().next().value;
					if (oldest === undefined) break;
					const evicted = this.#sessions.get(oldest);
					evicted?.bridge?.pump?.terminate(new Error("Cursor session evicted"));
					evicted?.bridge?.run.close();
					this.#killSessionShells(evicted ?? {});
					this.#sessions.delete(oldest);
				}
			}

			if (!terminalErrorEmitted) {
				debug(`finish decision: toolCallPending=${toolCallPending} streamClosed=${streamClosed} emitted=${emittedToolCall} trailers=${JSON.stringify(run.trailers ?? {})}`);
				const tokenDetails = persisted.tokenDetails;
				const maxTokens = tokenDetails?.maxTokens;
				if (Number.isFinite(maxTokens) && maxTokens > 0) {
					this.#contextWindowByModel.set(options.model, maxTokens);
				}
				const usage = projectCursorTokenUsage({ turnEnded: turnUsage, outputTokens, tokenDetails });
				debug(`usage in=${usage.inputTokens} out=${usage.outputTokens} cacheRead=${usage.cacheReadTokens ?? 0} cacheWrite=${usage.cacheWriteTokens ?? 0} used=${tokenDetails?.usedTokens ?? 0} max=${maxTokens ?? 0}`);
				yield { type: "usage", usage };
				if (streamClosed && emittedToolCall) {
					debug("finish → tool-calls");
					yield { type: "finish", reason: { kind: "tool-calls" } };
				} else if (run.trailers && Number(run.trailers["grpc-status"]) > 0) {
					debug("finish → grpc error");
					const message = run.trailers["grpc-message"] ?? "Cursor agent run failed";
					yield { type: "finish", reason: { kind: "error", failure: { message, code: classifyCursorError(message) } } };
				} else {
					debug("finish → stop");
					yield { type: "finish", reason: { kind: "stop" } };
				}
			}
		} catch (error) {
			debug(`stream() error: ${error instanceof Error ? error.message : String(error)}`);
			yield finishChunkForStreamError(error, upstream);
		} finally {
			if (abortRun !== undefined) upstream.removeEventListener("abort", abortRun);
			consumer.abort("cursor stream consumer stopped");
			// Detach BEFORE deciding whether to close: a stored bridge arms the
			// parked hard cap, everything else tears the run down with the pump.
			if (!bridgeStored) {
				await waitWork();
				await this.#waitForAllShellForwarders(cursorAgentDebug);
			}
			pump?.detach();
			if (!bridgeStored) run?.close();
			if (this.checkpointStore !== undefined) {
				try {
					await this.checkpointStore.flush();
				} catch {}
			}
		}
	}
}

/**
 * Parse a Connect end-stream frame into a structured error. Cursor's agent
 * errors carry a `debug` payload with a stable code and human-readable
 * `title`/`detail`; extracting those gives the user the real reason instead of
 * a bare `resource_exhausted`.
 * @returns {undefined | {code: string, debugCode?: string, message: string}}
 */
function ensureCursorPresetInstalled(logger) {
	try {
		const targetDir = dshHomePath(".agent-presets", CURSOR_PRESET_ID);
		const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "..", "presets", CURSOR_PRESET_ID);
		const sourceFile = join(sourceDir, "agent.cordis.yml");
		const sourceMeta = join(sourceDir, "preset.yml");
		if (!existsSync(sourceFile)) return;
		const yml = readFileSync(sourceFile, "utf8")
			.replaceAll(PRESET_ROW_ANCHOR, `name: '${import.meta.url.replace(/'/g, "''")}'`);
		const targetFile = join(targetDir, "agent.cordis.yml");
		const targetMeta = join(targetDir, "preset.yml");
		const meta = existsSync(sourceMeta) ? readFileSync(sourceMeta, "utf8") : undefined;
		const ymlUnchanged = existsSync(targetFile) && readFileSync(targetFile, "utf8") === yml;
		const metaUnchanged = meta === undefined
			|| (existsSync(targetMeta) && readFileSync(targetMeta, "utf8") === meta);
		if (ymlUnchanged && metaUnchanged) return;
		mkdirSync(targetDir, { recursive: true });
		if (!ymlUnchanged) writeFileSync(targetFile, yml);
		if (meta !== undefined && !metaUnchanged) writeFileSync(targetMeta, meta);
		logger?.info(`cursor-agent: installed the "${CURSOR_PRESET_ID}" agent preset at ${targetFile}`);
	} catch (error) {
		logger?.warn(`cursor-agent: could not install the "${CURSOR_PRESET_ID}" agent preset: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** The placeholder row name the in-package preset file uses; replaced with a file:// URL at install time. */
const PRESET_ROW_ANCHOR = "name: ../../lib/index.js";

/**
 * Build the stream()-time preset gate: rejects cursor-agent calls from
 * sessions not running the cursor-agent preset, before any network I/O.
 */
function makePresetGate(ctx, readSettings) {
	return (sessionId) => {
		if (!readSettings().requireCursorPreset) return;
		if (sessionId === undefined) return;
		const agents = ctx.get("agents");
		const agentPresets = ctx.get("agentPresets");
		if (agents === undefined || agentPresets === undefined) return;
		const agent = agents.get(sessionId);
		if (agent === undefined) {
			throw new LlmError(
				`Cursor Agent requires the "${CURSOR_PRESET_ID}" agent preset, but the session is not registered.`,
				"CURSOR_PRESET_MISMATCH",
			);
		}
		const presetId = agentPresets.composedPreset(agent.ctx);
		if (presetId !== CURSOR_PRESET_ID) {
			const current = presetId === undefined ? "no preset" : `the "${presetId}" preset`;
			throw new LlmError(
				`Cursor Agent requires the "${CURSOR_PRESET_ID}" agent preset. This session uses ${current}; switch the session's preset to use a Cursor model.`,
				"CURSOR_PRESET_MISMATCH",
			);
		}
	};
}

/**
 * Build the todo sync callback: mirrors Cursor's todo list into the DSH todo
 * panel by appending `todo/write` snapshots to the session (the exact write
 * path dsh-tool-todo uses; the cursor preset mounts it for its projection).
 */
function makeTodoSync(ctx) {
	const agents = ctx.get("agents");
	if (agents === undefined) return undefined;
	return (sessionId, todos) => {
		const agent = agents.get(sessionId);
		if (agent === undefined) return;
		agent.session.append("todo/write", { todos });
	};
}


async function applyCursorPresetTools(ctx) {
	const systemPrompt = ctx.get("systemPrompt");
	if (systemPrompt !== undefined) {
		ctx.effect(() => systemPrompt.section({
			name: "harness:identity",
			order: systemPrompt.getSectionOrder("HARNESS_IDENTITY"),
			text: "You are an AI Agent running in Cursor managed by DeepSeek Harness.",
		}), "cursor-agent: harness identity section");
		ctx.effect(() => systemPrompt.section({
			name: ACP_SYSTEM_SECTION,
			order: 0,
			text: "",
		}), "cursor-agent: hide ACP system section");
	}
	ctx.effect(() => ctx.jobs.attachController("cursor-agent"), "cursor-agent: jobs controller");
	registerCursorShims(ctx);
	let zod;
	try {
		({ z: zod } = await import("zod"));
	} catch (error) {
		ctx.logger?.warn(`cursor-agent: the preset branch could not load zod: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	const todosProjectionSchema = zod.union([
		zod.array(zod.object({
			content: zod.string(),
			status: zod.union([zod.literal("pending"), zod.literal("in_progress"), zod.literal("completed")]),
		})),
		zod.null(),
	]);
	ctx.sessionProjections.register({
		key: "todos",
		stateSchema: todosProjectionSchema,
		init: () => null,
		apply: (state, event) => {
			if (event.type === "todo/write") return event.data.todos;
			if (event.type === "turn/start") return null;
			return state;
		},
		wire: { viewSchema: todosProjectionSchema, view: (state) => state },
		stateVersion: 2,
	});
}

export function apply(ctx, config : any = {}) {
	// One plugin, two mounts: the preset row declares `config.plane: preset`
	// in its agent.cordis.yml. A config flag is used instead of scopeOf(ctx)
	// because a second resolved copy of @deepseek-ai/dsh-scope would make
	// scopeOf silently return undefined and the preset row would re-register
	// the host-only services; the row's own config cannot fail that way.
	if (config.plane === "preset") {
		return applyCursorPresetTools(ctx);
	}
	if (config.plane === "compaction") {
		return applyCursorCompaction(ctx);
	}
	cursorAgentDebug("plugin loaded");
	let currentSettings = () => config;
	let refreshRuntime = () => {};
	ctx.get("settings").installSection(ctx, SETTINGS_NAMESPACE, Config, config, {
		setSource: (source) => {
			currentSettings = source;
		},
		onChange: () => refreshRuntime(),
		validate: (value) => {
			resolveCursorSettings(value);
		},
	});
	const readSettings = () => resolveCursorSettings(currentSettings());
	const readSettingsView = () => {
		const value = readSettings();
		const descriptor = ctx.get("settings")?.describe({ redactSecrets: true })
			.find((entry) => entry.ns === SETTINGS_NAMESPACE);
		return { ...value, revision: descriptor?.revision ?? 0 };
	};
	const settingsController = {
		read: readSettingsView,
		update: async (patch, expectedRevision) => {
			resolveCursorSettings({ ...readSettings(), ...patch });
			const service = ctx.get("settings");
			if (service === undefined) throw new Error("Cursor settings storage is unavailable");
			await service.update(SETTINGS_NAMESPACE, patch, expectedRevision);
			return readSettingsView();
		},
	};
	const store = new CursorCredentialStore(ctx.credentials, CREDENTIAL_REF);
	const auth = new CursorAuthService(store, {
		logger: ctx.logger,
		resolveBaseUrl: () => readSettings().apiBaseUrl,
	});
	const checkpointStore = createCheckpointStore({
		storageDomain: ctx.get("storageDomain"),
		files: createLocalObjectStore(dshHomePath(...CHECKPOINT_OBJECTS_SEGMENTS)),
	});
	ctx.effect(
		() => () => {
			void checkpointStore.close();
		},
		"cursor-agent: checkpoint domain",
	);
	const adapter = new CursorAdapter({
		auth,
		settings: readSettings,
		gate: makePresetGate(ctx, readSettings),
		syncTodos: makeTodoSync(ctx),
		logger: ctx.logger,
		shellService: ctx.get("shell"),
		jobs: ctx.get("jobs"),
		terminalsRoot: dshHomePath("terminals"),
		agents: ctx.get("agents"),
		sandboxPolicy: ctx.get("sandboxPolicy"),
		attachments: () => ctx.get("attachments"),
		checkpointStore,
		publishSessionEvent: (session, event) => {
			ctx.emit("session/event", session, event);
		},
	});
	ctx.llm.registerAdapter([PROVIDER], adapter);
	registerCursorSummarize((args) => adapter.summarizeConversation(args));
	ctx.effect(
		() => () => registerCursorSummarize(undefined),
		"cursor-agent: summarize hand-off",
	);
	const usageReader = new CursorUsageReader(auth, {
		logger: ctx.logger,
		resolveBaseUrl: () => readSettings().apiBaseUrl,
	});
	refreshRuntime = () => {
		adapter.invalidateDiscovery();
		usageReader.forget();
	};

	const coordinator = new CursorLoginCoordinator(auth, { logger: ctx.logger });
	const handler = createCursorRpcHandler(coordinator, {
		openExternal: openCursorAuthUrl,
		usageReader,
		modelsProvider: adapter,
		settings: settingsController,
		auth,
	});
	ctx.effect(
		() => ctx.webServer.register({
			kind: "prefix",
			path: CHANNEL,
			handler: createCursorRpcHttpHandler(handler, {
				requestRejection: (req) => ctx.connection.requestRejection?.(req),
			}),
		}),
		"cursor-agent: loopback account RPC",
	);

	// Publish the cursor preset into the user discovery root so sessions can
	// switch to it. Discovery re-reads the roots on every resolve, so a preset
	// written here is visible to sessions created afterwards.
	ensureCursorPresetInstalled(ctx.logger);
}
//#endregion
