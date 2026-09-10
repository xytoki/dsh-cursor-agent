/**
 * Cursor-owned compaction for cursor-agent sessions.
 *
 * DSH `compaction-basic` / host ACP summarize a different history than Cursor
 * sees (checkpoint + this turn). This module: denylists those tools and
 * injects on the Cursor wire only, observes Cursor's `/summarize` frames, and
 * writes the official DSH compaction bracket so the UI and token meter stay
 * consistent. `/compact` triggers Cursor's empty `summarize_action`.
 */
import { randomUUID } from "node:crypto";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Reader, Writer } from "./proto";

const PROVIDER = "cursor-agent";

/** Host ACP MCP names that must not reach Cursor's request-context tool list. */
const DENIED_MCP_TOOLS = new Set(["compress", "decompress", "search_context", "acp_status"]);

/** Plugin inject producers that must not ride InjectContext onto Cursor. */
const DENIED_INJECT_PLUGINS = new Set(["acp-nudge", "billion-context-dsh", "compact"]);

/** ACP system-prompt section shadowed empty on the cursor-agent preset. */
export const ACP_SYSTEM_SECTION = "billion-context-dsh";

const SUMMARY_OPEN_TAG = "<compacted-summary>";
const SUMMARY_CLOSE_TAG = "</compacted-summary>";
const CHECKPOINT_PREAMBLE =
	"This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";

/** Same marker `dsh-compaction/checkpoint` uses; constructed here so write-back does not load that package. */
const COMPACT_CHECKPOINT_MARKER = Object.freeze({ kind: "plugin", plugin: "compact" });

/** Host `apply()` registers the adapter method; the isolated engine calls it. */
let cursorSummarize;

export function registerCursorSummarize(fn) {
	cursorSummarize = fn;
}

export function getCursorSummarize() {
	return cursorSummarize;
}

export function normalizeCursorToolName(name) {
	if (typeof name !== "string" || name.length === 0) return "";
	return name.toLowerCase().replace(/-/g, "_");
}

export function isDeniedCursorMcpTool(name) {
	return DENIED_MCP_TOOLS.has(normalizeCursorToolName(name));
}

export function shouldDropCursorInject(plugin) {
	return DENIED_INJECT_PLUGINS.has(String(plugin ?? ""));
}

/**
 * ConversationAction { summarize_action = 4 } — empty SummarizeAction.
 * New Run: pass this as AgentRunRequest.action. Live Run: wrap with
 * encodeConversationActionMessage.
 */
export function encodeSummarizeAction() {
	return new Writer().message(4, new Uint8Array(0)).finish();
}

/** SummaryUpdate { summary = 1 }. */
export function decodeSummaryUpdate(bytes): any {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) return reader.string();
		reader.skip(wireType);
	}
	return "";
}

/**
 * ConversationSummaryArchive { summarized_messages=1, summary=2, window_tail=3, summary_message=4 }.
 */
export function decodeConversationSummaryArchive(bytes): any {
	const reader = new Reader(bytes);
	const archive = { summarizedMessages: [], summary: "", windowTail: 0 };
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) archive.summarizedMessages.push(reader.bytes());
		else if (field === 2 && wireType === 2) archive.summary = reader.string();
		else if (field === 3 && wireType === 0) archive.windowTail = reader.varint();
		else if (field === 4 && wireType === 2) reader.bytes();
		else reader.skip(wireType);
	}
	return archive;
}

/** ConversationSummary { summary = 1 }. */
export function decodeConversationSummary(bytes): any {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) return reader.string();
		reader.skip(wireType);
	}
	return "";
}

function blobIdHex(id) {
	return Buffer.from(id).toString("hex");
}

function readBlob(blobs, id) {
	if (blobs == null || id == null || id.length === 0) return undefined;
	const data = blobs.get?.(blobIdHex(id));
	return data instanceof Uint8Array ? data : undefined;
}

function summaryTextFromBytes(raw, blobs) {
	const inline = decodeConversationSummary(raw);
	if (inline.length > 0) return inline;
	const stored = readBlob(blobs, raw);
	return stored === undefined ? "" : decodeConversationSummary(stored);
}

/**
 * ConversationStateStructure summary fields (SDK 1.0.31):
 * field 6 `summary` — inline ConversationSummary bytes (or a blob id);
 * field 11 `summary_archive` / field 13 `summary_archives` — blob ids.
 * Field 9 is `previous_workspace_uris`, not an archive.
 */
export function decodeConversationStateSummary(bytes, blobs): any {
	const reader = new Reader(bytes);
	let summary = "";
	let windowTail;
	const archiveIds = [];
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 6 && wireType === 2) {
			const text = summaryTextFromBytes(reader.bytes(), blobs);
			if (text.length > 0) summary = text;
		} else if ((field === 11 || field === 13) && wireType === 2) {
			archiveIds.push(reader.bytes());
		} else {
			reader.skip(wireType);
		}
	}
	for (const id of archiveIds) {
		const stored = readBlob(blobs, id);
		if (stored === undefined) continue;
		const archive = decodeConversationSummaryArchive(stored);
		if (archive.summary.length > 0) summary = archive.summary;
		if (Number.isFinite(archive.windowTail) && archive.windowTail > 0) {
			windowTail = archive.windowTail;
		}
	}
	if (summary.length === 0 && windowTail === undefined) return undefined;
	return { summary, windowTail };
}

function stripTokenDetailsUsageTree(bytes) {
	const reader = new Reader(bytes);
	const writer = new Writer();
	while (!reader.done) {
		const start = reader.pos;
		const { field, wireType } = reader.tag();
		if (field === 4) {
			reader.skip(wireType);
			continue;
		}
		reader.skip(wireType);
		writer.parts.push(reader.data.subarray(start, reader.pos));
	}
	return writer.finish();
}

function sanitizeSubagentPersistedState(bytes) {
	const reader = new Reader(bytes);
	const writer = new Writer();
	while (!reader.done) {
		const start = reader.pos;
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) {
			writer.message(1, sanitizeConversationStateForSend(reader.bytes()));
		} else {
			reader.skip(wireType);
			writer.parts.push(reader.data.subarray(start, reader.pos));
		}
	}
	return writer.finish();
}

function sanitizeSubagentMapEntry(bytes) {
	const reader = new Reader(bytes);
	const writer = new Writer();
	while (!reader.done) {
		const start = reader.pos;
		const { field, wireType } = reader.tag();
		if (field === 2 && wireType === 2) {
			writer.message(2, sanitizeSubagentPersistedState(reader.bytes()));
		} else {
			reader.skip(wireType);
			writer.parts.push(reader.data.subarray(start, reader.pos));
		}
	}
	return writer.finish();
}

/**
 * SDK `nJ1`: drop `token_details.prompt_context_usage_tree` (field 4) and
 * recurse into `subagent_states` (field 16) before a Run sees the checkpoint.
 */
export function sanitizeConversationStateForSend(bytes) {
	if (!(bytes instanceof Uint8Array) || bytes.length === 0) return bytes;
	const reader = new Reader(bytes);
	const writer = new Writer();
	while (!reader.done) {
		const start = reader.pos;
		const { field, wireType } = reader.tag();
		if (field === 5 && wireType === 2) {
			writer.message(5, stripTokenDetailsUsageTree(reader.bytes()));
		} else if (field === 16 && wireType === 2) {
			writer.message(16, sanitizeSubagentMapEntry(reader.bytes()));
		} else {
			reader.skip(wireType);
			writer.parts.push(reader.data.subarray(start, reader.pos));
		}
	}
	return writer.finish();
}

export function compactCheckpointSource(compactionId, sourceCommandId) {
	return Object.freeze({
		...COMPACT_CHECKPOINT_MARKER,
		compactionId,
		...sourceCommandId === undefined ? {} : { sourceCommandId },
	});
}

export function frameCursorSummary(text) {
	return `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}\n${text}\n${SUMMARY_CLOSE_TAG}`;
}

function sessionEventAt(session, seq) {
	if (typeof session?.eventAt === "function") return session.eventAt(seq);
	return session?.events?.[seq];
}

function sessionSeqCount(session) {
	if (Number.isSafeInteger(session?.seq)) return session.seq;
	return session?.events?.length ?? 0;
}

function eventToolDelta(event) {
	if (event?.type === "assistant/message") {
		return (event.data?.message?.content ?? []).filter((block) => block.type === "tool-call").length;
	}
	if (event?.type === "tool/result") return -1;
	return 0;
}

function inProgressBefore(session, index) {
	const nodes = session.surface?.nodes ?? [];
	let count = 0;
	for (let i = 0; i < index; i++) count += eventToolDelta(sessionEventAt(session, nodes[i]));
	return count;
}

export function toolPairingBalancedBefore(session, seq) {
	const nodes = session.surface?.nodes ?? [];
	const index = nodes.indexOf(seq);
	if (index === -1) return false;
	return inProgressBefore(session, index) === 0;
}

export function toolPairingBalancedAfter(session, seq) {
	const nodes = session.surface?.nodes ?? [];
	const index = nodes.indexOf(seq);
	if (index === -1) return false;
	return inProgressBefore(session, index) + eventToolDelta(sessionEventAt(session, nodes[index])) === 0;
}

function flattenEventText(event) {
	const content = event?.data?.message?.content ?? event?.data?.content ?? [];
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (block?.type === "text") text += block.text ?? "";
		else if (typeof block?.text === "string") text += block.text;
	}
	return text;
}

function estimateSeqTokens(session, seq) {
	const text = flattenEventText(sessionEventAt(session, seq));
	return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

/**
 * Conservative head before the retained tail. Prefer under-shadowing: keep
 * the last assistant and everything after it on auto; manual replaces the
 * whole balanced surface. `windowTail` (archive) can only grow the kept tail.
 */
export function selectCompactableHead(session, { keepTail = true, windowTail } : any = {}) {
	const nodes = session?.surface?.nodes ?? [];
	if (nodes.length === 0) return null;

	let keepFrom = nodes.length;
	if (keepTail) {
		let lastAssistant = -1;
		for (let index = nodes.length - 1; index >= 0; index--) {
			if (sessionEventAt(session, nodes[index])?.type === "assistant/message") {
				lastAssistant = index;
				break;
			}
		}
		keepFrom = lastAssistant === -1 ? nodes.length : lastAssistant;
		if (Number.isFinite(windowTail) && windowTail > 0) {
			keepFrom = Math.min(keepFrom, Math.max(0, nodes.length - windowTail));
		}
	}
	if (keepFrom <= 0) return null;

	let endIdx = keepFrom - 1;
	while (endIdx >= 0 && !toolPairingBalancedAfter(session, nodes[endIdx])) endIdx--;
	if (endIdx < 0) return null;

	let startIdx = 0;
	while (startIdx <= endIdx && !toolPairingBalancedBefore(session, nodes[startIdx])) startIdx++;
	if (startIdx > endIdx) return null;

	const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);
	return { start: nodes[startIdx], end: nodes[endIdx], shadowedSeqs };
}

export function inspectCompactionEntryState(session) {
	let openTurn = null;
	let openTurnStateKnown = false;
	let unmatchedCompactionStart;
	let compactionEntryStateKnown = false;
	let latestEndSeedSeq;
	for (let seq = sessionSeqCount(session) - 1; seq >= 0; seq--) {
		const event = sessionEventAt(session, seq);
		if (event === undefined) continue;
		if (latestEndSeedSeq === undefined && event.type === "session/end-seed") latestEndSeedSeq = event.seq;
		if (!compactionEntryStateKnown) {
			if (event.type === "compaction/start") {
				unmatchedCompactionStart = event;
				compactionEntryStateKnown = true;
			} else if (event.type === "compaction/end") {
				compactionEntryStateKnown = true;
			}
		}
		if (!openTurnStateKnown) {
			if (event.type === "turn/start") {
				openTurn = event.data?.turn ?? null;
				openTurnStateKnown = true;
			} else if (event.type === "turn/end") {
				openTurnStateKnown = true;
			}
		}
		if (openTurnStateKnown && compactionEntryStateKnown && latestEndSeedSeq !== undefined) break;
	}
	return { openTurn, unmatchedCompactionStart, latestEndSeedSeq };
}

function lockIsActive(entry) {
	if (entry.unmatchedCompactionStart === undefined) return false;
	if (entry.latestEndSeedSeq !== undefined && entry.latestEndSeedSeq > entry.unmatchedCompactionStart.seq) return false;
	return true;
}

function summaryBlocksOf(event) {
	const blocks = event?.data?.summary;
	if (!Array.isArray(blocks)) return "";
	return blocks.map((block) => (block?.type === "text" ? block.text ?? "" : "")).join("");
}

export function findLatestCursorSummaryResult(session, text) {
	const needle = String(text ?? "").trim();
	if (needle.length === 0) return undefined;
	let startEvent;
	let summaryEvent;
	let endEvent;
	const n = sessionSeqCount(session);
	for (let seq = 0; seq < n; seq++) {
		const event = sessionEventAt(session, seq);
		if (event?.type === "compaction/start") startEvent = event;
		else if (event?.type === "compaction/summary" && summaryBlocksOf(event).trim() === needle) summaryEvent = event;
		else if (event?.type === "compaction/end" && event.data?.error === undefined && startEvent !== undefined && summaryEvent !== undefined) {
			endEvent = event;
		}
	}
	if (startEvent === undefined || summaryEvent === undefined || endEvent === undefined) return undefined;
	return {
		compactionId: startEvent.data.compactionId,
		...startEvent.data.sourceCommandId === undefined ? {} : { sourceCommandId: startEvent.data.sourceCommandId },
		startSeq: startEvent.seq,
		summarySeq: summaryEvent.seq,
		endSeq: endEvent.seq,
		summary: summaryEvent.data.summary,
		shadowedRange: summaryEvent.data.shadowedRange,
		shadowedSeqs: summaryEvent.data.shadowedSeqs,
		shadowedTokenCount: summaryEvent.data.shadowedTokenCount,
	};
}

/**
 * Official DSH compaction bracket: start → summary → replace user/message → end.
 * No `llmStreamCall`. Idempotent on the Cursor summary fingerprint.
 */
export function applyCursorSummaryToSession({
	session,
	summary,
	keepTail = true,
	owner = "current-turn",
	provider = PROVIDER,
	model = "",
	sourceCommandId,
	windowTail,
}: any = {}) {
	const text = String(summary ?? "").trim();
	if (text.length === 0 || session === undefined) return null;

	const existing = findLatestCursorSummaryResult(session, text);
	if (existing !== undefined) return existing;

	const entry = inspectCompactionEntryState(session);
	if (lockIsActive(entry)) return null;

	let turn = null;
	if (owner === "current-turn") {
		if (entry.openTurn === null) return null;
		turn = entry.openTurn;
	} else if (entry.openTurn !== null) {
		return null;
	}

	const range = selectCompactableHead(session, { keepTail, windowTail });
	if (range === null) return null;

	const compactionId = randomUUID();
	const lifecycle = {
		compactionId,
		...sourceCommandId === undefined ? {} : { sourceCommandId },
		turn,
	};
	const summaryContent = [{ type: "text", text }];
	const shadowedTokenCount = range.shadowedSeqs.reduce((total, seq) => total + estimateSeqTokens(session, seq), 0);

	const startEvent = session.append("compaction/start", lifecycle);
	try {
		const summaryEvent = session.append("compaction/summary", {
			compactionId,
			...sourceCommandId === undefined ? {} : { sourceCommandId },
			summary: summaryContent,
			shadowedRange: { start: range.start, end: range.end },
			shadowedSeqs: [...range.shadowedSeqs],
			shadowedTokenCount,
			provider,
			model,
		});
		const checkpointMessage = createUserMessage({
			content: [{ type: "text", text: frameCursorSummary(text) }],
			source: compactCheckpointSource(compactionId, sourceCommandId),
		});
		session.append("user/message", checkpointMessage, {
			surfaceOp: { op: "replace", start: range.start, end: range.end },
			sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...range.shadowedSeqs],
		});
		const endEvent = session.append("compaction/end", lifecycle);
		return {
			compactionId,
			...sourceCommandId === undefined ? {} : { sourceCommandId },
			startSeq: startEvent.seq,
			summarySeq: summaryEvent.seq,
			endSeq: endEvent.seq,
			summary: summaryContent,
			shadowedRange: { start: range.start, end: range.end },
			shadowedSeqs: [...range.shadowedSeqs],
			shadowedTokenCount,
		};
	} catch (error) {
		try {
			session.append("compaction/end", {
				...lifecycle,
				error: error instanceof Error ? error.message : String(error),
			});
		} catch {
			// unmatched start remains the detectable lock
		}
		throw error;
	}
}

export function applySummaryFromPump(agent, text, { keepTail = true, windowTail, model } : any = {}) {
	const session = agent?.session;
	if (session === undefined) return null;
	try {
		return applyCursorSummaryToSession({
			session,
			summary: text,
			keepTail,
			owner: keepTail ? "current-turn" : null,
			provider: PROVIDER,
			model: model ?? agent.options?.model ?? "",
			windowTail,
		});
	} catch {
		return null;
	}
}

/**
 * Checkpoint bytes always carry the last Cursor summary. Only project it
 * onto DSH when this Run asked for summarize, or interaction frames already
 * said a summary is in flight.
 */
export function pickCheckpointSummaryCommit({
	summarySeen,
	summarizeKeepTail = true,
	buffer,
	checkpointSummary,
}: any = {}) {
	if (summarySeen !== true && summarizeKeepTail !== false) return undefined;
	const fromBuffer = String(buffer ?? "").trim();
	const fromCheckpoint = String(checkpointSummary ?? "").trim();
	const text = fromBuffer || fromCheckpoint;
	return text.length > 0 ? text : undefined;
}

export async function executeCursorCompactNow(agent, signal, sourceCommandId) {
	signal?.throwIfAborted?.();
	const { ManualCompactionError } = await loadCompactionSeam();
	const summarize = getCursorSummarize();
	if (summarize === undefined) {
		throw new ManualCompactionError("summary", "cursor-agent summarize is not registered");
	}
	let outcome;
	try {
		outcome = await summarize({
			sessionId: agent.session.id,
			model: agent.options?.model,
			signal,
		});
	} catch (error) {
		if (error instanceof ManualCompactionError) throw error;
		throw new ManualCompactionError(
			"summary",
			error instanceof Error ? error.message : "Cursor summarize failed",
			{ cause: error },
		);
	}
	const summary = String(outcome?.summary ?? "").trim();
	if (summary.length === 0) {
		throw new ManualCompactionError("summary", "Cursor summarize returned an empty summary");
	}
	if (outcome?.result !== undefined) return outcome.result;
	try {
		return applyCursorSummaryToSession({
			session: agent.session,
			summary,
			keepTail: false,
			owner: null,
			provider: PROVIDER,
			model: agent.options?.model ?? "",
			sourceCommandId,
		});
	} catch (error) {
		if (error instanceof ManualCompactionError) throw error;
		throw new ManualCompactionError(
			"commit",
			error instanceof Error ? error.message : "Cursor summary did not commit to the DSH session",
			{ cause: error },
		);
	}
}

async function loadCompactionSeam() {
	const mod = await import("@deepseek-ai/dsh-compaction");
	if (mod.CompactionEngine === undefined || mod.ManualCompactionError === undefined) {
		throw new Error("cursor-agent: @deepseek-ai/dsh-compaction is incomplete");
	}
	return mod;
}

/**
 * Isolated `ctx.compaction` for the cursor-agent preset. compactIfNeeded is a
 * no-op (Cursor auto-compacts; we only observe). compactNow triggers
 * summarize_action. compactRegion is rejected.
 */
export async function applyCursorCompaction(ctx) {
	let CompactionEngine;
	let ManualCompactionError;
	try {
		({ CompactionEngine, ManualCompactionError } = await loadCompactionSeam());
	} catch (error) {
		ctx.logger?.warn(`cursor-agent: compaction engine unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	class CursorCompactionEngine extends CompactionEngine {
		constructor(ctx: any) {
			super(ctx);
		}

		async compactIfNeeded() {
			return null;
		}

		async compactRegion() {
			throw new ManualCompactionError(
				"summary",
				"cursor-agent does not support compactRegion; use /compact to trigger Cursor summarize",
			);
		}

		async compactNow(agent, signal, sourceCommandId) {
			return agent.runMaintenance(async (inner) => {
				const merged = signal === undefined
					? inner
					: (typeof AbortSignal.any === "function" ? AbortSignal.any([signal, inner]) : inner);
				return executeCursorCompactNow(agent, merged, sourceCommandId);
			});
		}
	}

	new CursorCompactionEngine(ctx);
}
