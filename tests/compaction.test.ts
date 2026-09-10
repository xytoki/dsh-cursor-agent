/**
 * Cursor-owned compaction: summarize_action wire, denylist, DSH write-back.
 */
import { test } from "@rstest/core";
import assert from "node:assert/strict";

import { Writer, Reader } from "../src/proto";
import {
	ACP_SYSTEM_SECTION,
	applyCursorSummaryToSession,
	buildCustomRunPayload,
	classifyTurnIngress,
	compactCheckpointSource,
	decodeAgentServerMessage,
	decodeConversationStateSummary,
	decodeConversationSummaryArchive,
	sanitizeConversationStateForSend,
	decodeInteractionUpdate,
	encodeConversationActionMessage,
	encodeSummarizeAction,
	findLatestCursorSummaryResult,
	frameCursorSummary,
	isDeniedCursorMcpTool,
	pickCheckpointSummaryCommit,
	registerCursorSummarize,
	getCursorSummarize,
	selectCompactableHead,
	shouldDropCursorInject,
	ConnectFrameReader,
	CursorAdapter,
	frameEncode,
	resolveCursorSettings,
} from "../src/index";

function fieldBytesOf(bytes, wanted) {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === wanted && wireType === 2) return reader.bytes();
		reader.skip(wireType);
	}
	return undefined;
}

function fieldVarintOf(bytes, wanted) {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === wanted && wireType === 0) return reader.varint();
		reader.skip(wireType);
	}
	return undefined;
}

function mockSession(events) {
	const bySeq = new Map();
	const surfaceNodes = [];
	let next = 0;
	for (const event of events) {
		bySeq.set(event.seq, event);
		if (event.surface !== false) surfaceNodes.push(event.seq);
		next = Math.max(next, event.seq + 1);
	}
	const appended = [];
	return {
		appended,
		get seq() { return next; },
		surface: { nodes: surfaceNodes, replaceGeneration: 0 },
		eventAt(seq) { return bySeq.get(seq); },
		append(type, data, meta) {
			const event = { seq: next++, type, data, meta };
			bySeq.set(event.seq, event);
			appended.push(event);
			if (type === "user/message" && meta?.surfaceOp?.op === "replace") {
				const startIdx = surfaceNodes.indexOf(meta.surfaceOp.start);
				const endIdx = surfaceNodes.indexOf(meta.surfaceOp.end);
				if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
					surfaceNodes.splice(startIdx, endIdx - startIdx + 1, event.seq);
				}
			}
			return event;
		},
	};
}

function surfaceEvents() {
	return [
		{ seq: 0, type: "turn/start", data: { turn: 1 }, surface: false },
		{ seq: 1, type: "user/message", data: { message: { content: [{ type: "text", text: "old question about the repo layout" }] } } },
		{ seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "here is the layout" }] } } },
		{ seq: 3, type: "user/message", data: { message: { content: [{ type: "text", text: "now continue" }] } } },
	];
}

test("encodeSummarizeAction is the empty ConversationAction field 4", () => {
	const action = encodeSummarizeAction();
	const reader = new Reader(action);
	assert.deepEqual(reader.tag(), { field: 4, wireType: 2 });
	assert.deepEqual([...reader.bytes()], []);
	assert.equal(reader.done, true);
});

test("encodeConversationActionMessage wraps summarize_action for a live Run", () => {
	const envelope = encodeConversationActionMessage(encodeSummarizeAction());
	const reader = new Reader(envelope);
	assert.deepEqual(reader.tag(), { field: 4, wireType: 2 });
	const inner = new Reader(reader.bytes());
	assert.deepEqual(inner.tag(), { field: 4, wireType: 2 });
	assert.deepEqual([...inner.bytes()], []);
});

test("decodeInteractionUpdate reads summary / started / completed", () => {
	const summary = decodeInteractionUpdate(new Writer().message(9, new Writer().string(1, "condensed").finish()).finish());
	assert.deepEqual(summary, { type: "summary", text: "condensed" });
	assert.deepEqual(decodeInteractionUpdate(new Writer().message(10, new Uint8Array(0)).finish()), { type: "summaryStarted" });
	assert.deepEqual(decodeInteractionUpdate(new Writer().message(11, new Uint8Array(0)).finish()), { type: "summaryCompleted" });
});

test("decodeAgentServerMessage surfaces summary frames", () => {
	const interaction = new Writer().message(9, new Writer().string(1, "head").finish()).finish();
	const decoded = decodeAgentServerMessage(new Writer().message(1, interaction).finish());
	assert.equal(decoded.case, "interactionUpdate");
	assert.equal(decoded.value.type, "summary");
	assert.equal(decoded.value.text, "head");
});

test("decodeConversationSummaryArchive reads summary and window_tail", () => {
	const archive = decodeConversationSummaryArchive(new Writer()
		.string(2, "archived")
		.varint(3, 2)
		.finish());
	assert.equal(archive.summary, "archived");
	assert.equal(archive.windowTail, 2);
});

test("decodeConversationStateSummary prefers archive window_tail", () => {
	const archiveId = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
	const archive = new Writer().string(2, "from-archive").varint(3, 3).finish();
	const blobs = new Map([[Buffer.from(archiveId).toString("hex"), archive]]);
	const state = new Writer()
		.message(6, new Writer().string(1, "from-summary").finish())
		.bytes(11, archiveId)
		.finish();
	const decoded = decodeConversationStateSummary(state, blobs);
	assert.equal(decoded.summary, "from-archive");
	assert.equal(decoded.windowTail, 3);
});

test("decodeConversationStateSummary reads field 13 archives and ignores workspace uris", () => {
	const archiveId = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
	const archive = new Writer().string(2, "tail-archive").varint(3, 4).finish();
	const blobs = new Map([[Buffer.from(archiveId).toString("hex"), archive]]);
	const state = new Writer()
		.string(9, "/old/workspace")
		.bytes(13, archiveId)
		.finish();
	const decoded = decodeConversationStateSummary(state, blobs);
	assert.equal(decoded.summary, "tail-archive");
	assert.equal(decoded.windowTail, 4);
});

test("decodeConversationStateSummary does not parse a blob id as archive text", () => {
	const archiveId = Uint8Array.from({ length: 32 }, (_, i) => i + 3);
	const state = new Writer().bytes(11, archiveId).finish();
	assert.equal(decodeConversationStateSummary(state), undefined);
	assert.equal(decodeConversationStateSummary(state, new Map()), undefined);
});

test("sanitizeConversationStateForSend drops prompt_context_usage_tree", () => {
	const tree = new Writer().varint(1, 99).finish();
	const details = new Writer().varint(1, 10).varint(2, 20).message(4, tree).finish();
	const nested = new Writer().message(5, details).finish();
	const child = new Writer().message(1, nested).finish();
	const entry = new Writer().string(1, "sub").message(2, child).finish();
	const state = new Writer().message(5, details).message(16, entry).bytes(8, Uint8Array.of(1, 2, 3)).finish();
	const cleaned = sanitizeConversationStateForSend(state);
	const rootDetails = fieldBytesOf(cleaned, 5);
	assert.equal(fieldBytesOf(rootDetails, 4), undefined);
	assert.equal(fieldVarintOf(rootDetails, 1), 10);
	assert.equal(fieldVarintOf(rootDetails, 2), 20);
	const mapEntry = fieldBytesOf(cleaned, 16);
	const nestedState = fieldBytesOf(fieldBytesOf(mapEntry, 2), 1);
	assert.equal(fieldBytesOf(fieldBytesOf(nestedState, 5), 4), undefined);
	assert.equal(fieldVarintOf(fieldBytesOf(nestedState, 5), 1), 10);
	assert.deepEqual([...fieldBytesOf(cleaned, 8)], [1, 2, 3]);
});

test("denylist matches ACP MCP names after hyphen/snake normalize", () => {
	assert.equal(isDeniedCursorMcpTool("compress"), true);
	assert.equal(isDeniedCursorMcpTool("search-context"), true);
	assert.equal(isDeniedCursorMcpTool("acp_status"), true);
	assert.equal(isDeniedCursorMcpTool("decompress"), true);
	assert.equal(isDeniedCursorMcpTool("web_search"), false);
	assert.equal(isDeniedCursorMcpTool("annotate"), false);
	assert.equal(shouldDropCursorInject("acp-nudge"), true);
	assert.equal(shouldDropCursorInject(ACP_SYSTEM_SECTION), true);
	assert.equal(shouldDropCursorInject("compact"), true);
	assert.equal(shouldDropCursorInject("dsh-time"), false);
});

test("classifyTurnIngress drops ACP and compact injects, keeps other host plugins", () => {
	const classified = classifyTurnIngress({
		system: "sys",
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
			{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hello" }] },
			{ role: "user", source: { kind: "plugin", plugin: "acp-nudge" }, content: [{ type: "text", text: "compress now" }] },
			{ role: "user", source: { kind: "plugin", plugin: "billion-context-dsh" }, content: [{ type: "text", text: "nudge" }] },
			{ role: "user", source: { kind: "plugin", plugin: "compact" }, content: [{ type: "text", text: "checkpoint" }] },
			{ role: "user", source: { kind: "plugin", plugin: "dsh-time" }, content: [{ type: "text", text: "Tuesday" }] },
		],
	});
	assert.deepEqual(classified.users.map((entry) => entry.text), ["hello"]);
	assert.deepEqual(classified.injections.map((entry) => entry.producer), ["dsh-time"]);
});

test("buildCustomRunPayload accepts summarize_action with no user text", () => {
	const built = buildCustomRunPayload({
		conversationState: new Uint8Array(0),
		actionBytes: encodeSummarizeAction(),
		modelId: "test-model",
		conversationId: "c1",
	});
	const envelope = new Reader(built.payload);
	assert.deepEqual(envelope.tag(), { field: 1, wireType: 2 });
	const runRequest = envelope.bytes();
	const action = fieldBytesOf(runRequest, 2);
	assert.ok(action !== undefined);
	const actionReader = new Reader(action);
	assert.deepEqual(actionReader.tag(), { field: 4, wireType: 2 });
	assert.deepEqual([...actionReader.bytes()], []);
});

test("selectCompactableHead keeps the last assistant on auto, all nodes on manual", () => {
	const session = mockSession(surfaceEvents());
	const auto = selectCompactableHead(session, { keepTail: true });
	assert.deepEqual(auto.shadowedSeqs, [1]);
	assert.equal(auto.start, 1);
	assert.equal(auto.end, 1);
	const manual = selectCompactableHead(session, { keepTail: false });
	assert.deepEqual(manual.shadowedSeqs, [1, 2, 3]);
});

test("selectCompactableHead refuses to cut into an open tool pair", () => {
	const session = mockSession([
		{ seq: 1, type: "assistant/message", data: { message: { content: [{ type: "tool-call", id: "c1" }] } } },
		{ seq: 2, type: "user/message", data: { message: { content: [{ type: "text", text: "now" }] } } },
	]);
	assert.equal(selectCompactableHead(session, { keepTail: true }), null);
	const withHead = mockSession([
		{ seq: 1, type: "user/message", data: { message: { content: [{ type: "text", text: "go" }] } } },
		{ seq: 2, type: "assistant/message", data: { message: { content: [{ type: "tool-call", id: "c1" }] } } },
		{ seq: 3, type: "user/message", data: { message: { content: [{ type: "text", text: "now" }] } } },
	]);
	assert.deepEqual(selectCompactableHead(withHead, { keepTail: true })?.shadowedSeqs, [1]);
});

test("applyCursorSummaryToSession writes the official bracket without llmStreamCall", () => {
	const session = mockSession(surfaceEvents());
	const result = applyCursorSummaryToSession({
		session,
		summary: "Repo layout is src/ plus tests.",
		keepTail: true,
		owner: "current-turn",
		provider: "cursor-agent",
		model: "grok-4.6",
	});
	assert.ok(result !== null);
	assert.deepEqual(result.shadowedSeqs, [1]);
	assert.equal(result.summary[0].text, "Repo layout is src/ plus tests.");
	const types = session.appended.map((event) => event.type);
	assert.deepEqual(types, ["compaction/start", "compaction/summary", "user/message", "compaction/end"]);
	const summaryEvent = session.appended[1];
	assert.equal(summaryEvent.data.llmStreamCall, undefined);
	assert.equal(summaryEvent.data.provider, "cursor-agent");
	assert.equal(summaryEvent.data.model, "grok-4.6");
	const replace = session.appended[2];
	assert.deepEqual(replace.meta.surfaceOp, { op: "replace", start: 1, end: 1 });
	assert.equal(replace.data.source.kind, "plugin");
	assert.equal(replace.data.source.plugin, "compact");
	assert.equal(replace.data.source.compactionId, result.compactionId);
	assert.match(replace.data.content[0].text, /<compacted-summary>/);
	assert.match(replace.data.content[0].text, /Repo layout is src\/ plus tests\./);
	assert.equal(session.surface.nodes.includes(1), false);
	assert.deepEqual(session.surface.nodes.slice(-2), [2, 3]);
	assert.equal(session.surface.nodes.length, 3);
});

test("applyCursorSummaryToSession closes the lock if commit throws", () => {
	const session = mockSession(surfaceEvents());
	const inner = session.append.bind(session);
	session.append = (type, data, meta) => {
		if (type === "user/message") throw new Error("boom");
		return inner(type, data, meta);
	};
	assert.throws(
		() => applyCursorSummaryToSession({
			session,
			summary: "partial",
			keepTail: true,
			owner: "current-turn",
			model: "m",
		}),
		/boom/,
	);
	const types = session.appended.map((event) => event.type);
	assert.deepEqual(types, ["compaction/start", "compaction/summary", "compaction/end"]);
	assert.equal(session.appended.at(-1).data.error, "boom");
	session.append = inner;
	const retry = applyCursorSummaryToSession({
		session,
		summary: "retry after failed lock",
		keepTail: true,
		owner: "current-turn",
		model: "m",
	});
	assert.ok(retry !== null);
	assert.equal(retry.summary[0].text, "retry after failed lock");
});

test("pickCheckpointSummaryCommit ignores leftover checkpoint text on an ordinary run", () => {
	assert.equal(pickCheckpointSummaryCommit({
		summarySeen: false,
		summarizeKeepTail: true,
		buffer: "",
		checkpointSummary: "old server summary",
	}), undefined);
	assert.equal(pickCheckpointSummaryCommit({
		summarySeen: true,
		summarizeKeepTail: true,
		buffer: "live",
		checkpointSummary: "old server summary",
	}), "live");
	assert.equal(pickCheckpointSummaryCommit({
		summarySeen: true,
		summarizeKeepTail: true,
		buffer: "",
		checkpointSummary: "from archive",
	}), "from archive");
	assert.equal(pickCheckpointSummaryCommit({
		summarySeen: false,
		summarizeKeepTail: false,
		buffer: "",
		checkpointSummary: "manual summarize",
	}), "manual summarize");
});

test("applyCursorSummaryToSession is idempotent on the same summary fingerprint", () => {
	const session = mockSession(surfaceEvents());
	const first = applyCursorSummaryToSession({
		session,
		summary: "same",
		keepTail: true,
		owner: "current-turn",
		model: "m",
	});
	const second = applyCursorSummaryToSession({
		session,
		summary: "same",
		keepTail: true,
		owner: "current-turn",
		model: "m",
	});
	assert.deepEqual(second, first);
	assert.equal(session.appended.filter((event) => event.type === "compaction/start").length, 1);
	assert.deepEqual(findLatestCursorSummaryResult(session, "same")?.compactionId, first.compactionId);
});

test("compactCheckpointSource and frameCursorSummary match the DSH basic shape", () => {
	const source = compactCheckpointSource("cid-1", "cmd-1");
	assert.equal(source.kind, "plugin");
	assert.equal(source.plugin, "compact");
	assert.equal(source.compactionId, "cid-1");
	assert.equal(source.sourceCommandId, "cmd-1");
	const framed = frameCursorSummary("body");
	assert.match(framed, /^This is an automatically generated checkpoint/);
	assert.match(framed, /<compacted-summary>\nbody\n<\/compacted-summary>$/);
});

test("purpose compaction fails fast without opening a Run", async () => {
	const adapter = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		createAgentRun: () => {
			throw new Error("compaction purpose must not open AgentService/Run");
		},
	});
	const chunks = [];
	for await (const chunk of adapter.stream({
		purpose: "compaction",
		provider: "cursor-agent",
		model: "test-model",
		messages: [{ role: "user", content: [{ type: "text", text: "summarize" }] }],
	})) {
		chunks.push(chunk);
	}
	const finish = chunks.at(-1);
	assert.equal(finish.type, "finish");
	assert.equal(finish.reason.kind, "error");
	assert.equal(finish.reason.failure.code, "UNSUPPORTED_OPTION");
	assert.match(finish.reason.failure.message, /compaction/);
});

test("cursor-summarize opens a Run with summarize_action and no user text", async () => {
	const created = [];
	const summaryInteraction = new Writer().message(9, new Writer().string(1, "short").finish()).finish();
	const completed = new Writer().message(11, new Uint8Array(0)).finish();
	const adapter = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		createAgentRun: () => {
			const run = {
				finished: false,
				responseStatus: 200,
				responseContentType: "application/connect+proto",
				trailers: {},
				writes: [],
				stream: { destroyed: false, once: () => {} },
				frames: new ConnectFrameReader(),
				async start() {},
				write(payload) {
					this.writes.push(Uint8Array.from(payload));
					return true;
				},
				writeMessage(bytes) {
					return this.write(frameEncode(bytes));
				},
				async waitForResponse() { return 200; },
				startHeartbeat() {},
				abort() { this.close(); },
				close() {
					this.finished = true;
					this.stream.destroyed = true;
					if (!this.frames.ended) this.frames.finish();
				},
			};
			run.frames.push(frameEncode(new Writer().message(1, summaryInteraction).finish()));
			run.frames.push(frameEncode(new Writer().message(1, completed).finish()));
			run.frames.finish();
			created.push(run);
			return run;
		},
	});
	const session = mockSession(surfaceEvents());
	session.header = { cwd: "/tmp" };
	adapter.agents = { get: () => ({ session, options: { model: "test-model" } }) };
	const chunks = [];
	for await (const chunk of adapter.stream({
		purpose: "cursor-summarize",
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "s1",
		messages: [],
	})) {
		chunks.push(chunk);
	}
	assert.equal(created.length, 1);
	const envelope = new Reader(created[0].writes[0].subarray(5));
	assert.deepEqual(envelope.tag(), { field: 1, wireType: 2 });
	const action = fieldBytesOf(envelope.bytes(), 2);
	const actionReader = new Reader(action);
	assert.deepEqual(actionReader.tag(), { field: 4, wireType: 2 });
	assert.equal(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "short"), true);
	assert.equal(chunks.at(-1).type, "finish");
});

test("registerCursorSummarize is the host-to-isolate hand-off", async () => {
	registerCursorSummarize(undefined);
	assert.equal(getCursorSummarize(), undefined);
	registerCursorSummarize(async () => ({ summary: "x" }));
	assert.equal((await getCursorSummarize()()).summary, "x");
	registerCursorSummarize(undefined);
});
