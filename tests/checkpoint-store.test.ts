/**
 * Durable Cursor checkpoint store: domain pointers + attachment bytes.
 */
import { test } from "@rstest/core";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Reader, Writer } from "../src/proto";

import {
	CHECKPOINT_OBJECTS_SEGMENTS,
	createCheckpointStore,
	createLocalObjectStore,
	cursorAgentDomainSpec,
	identityMatches,
} from "../src/checkpoint-store";
import {
	CURSOR_CHECKPOINT_EVENT_TYPE,
	CURSOR_CHECKPOINT_SCHEMA_VERSION,
} from "../src/checkpoint-log";
import {
	CursorAdapter,
	frameEncode,
	ConnectFrameReader,
	resolveCursorSettings,
} from "../src/index";

function memoryDomain() {
	const records = new Map();
	return {
		table(name) {
			if (name !== "sessions") throw new Error(`unknown table ${name}`);
			return {
				get(key) {
					return records.get(key);
				},
				async put(key, value) {
					records.set(key, structuredClone(value));
				},
				async delete(key) {
					return records.delete(key);
				},
			};
		},
		async close() {},
	};
}

function memoryAttachments() {
	const files = new Map();
	return {
		async saveFile({ data, name }) {
			const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
			const attachmentId = createHash("sha256").update(bytes).digest("hex");
			files.set(attachmentId, Uint8Array.from(bytes));
			return { attachmentId, name: name ?? "file.bin", bytes: bytes.byteLength };
		},
		async *readFileStream(ref) {
			const data = files.get(ref.attachmentId);
			if (data === undefined) throw new Error(`missing attachment ${ref.attachmentId}`);
			yield data;
		},
	};
}

function memoryFacility(domain = memoryDomain()) {
	return {
		domain,
		async open(spec) {
			assert.equal(spec.name, cursorAgentDomainSpec.name);
			return domain;
		},
	};
}

function fakeRun(frameBytes = [], { endFrames = frameBytes.length === 0 } = {}) {
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
		async waitForResponse() {
			return 200;
		},
		startHeartbeat() {},
		abort(error) {
			this.frames.fail(error);
			this.close();
		},
		close() {
			this.finished = true;
			this.stream.destroyed = true;
			if (!this.frames.ended) this.frames.finish();
		},
	};
	for (const frame of frameBytes) run.frames.push(frame);
	if (endFrames) run.frames.finish();
	return run;
}

async function drainStream(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return chunks;
}

function runRequestOf(write) {
	const envelope = new Reader(write.subarray(5));
	let runRequest;
	while (!envelope.done) {
		const { field, wireType } = envelope.tag();
		if (field === 1 && wireType === 2) runRequest = envelope.bytes();
		else envelope.skip(wireType);
	}
	assert.ok(runRequest !== undefined, "write carries a run_request");
	return runRequest;
}

function fieldBytesOf(bytes, wanted) {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === wanted && wireType === 2) return reader.bytes();
		reader.skip(wireType);
	}
	return undefined;
}

function fieldStringOf(bytes, wanted) {
	const raw = fieldBytesOf(bytes, wanted);
	return raw === undefined ? undefined : new TextDecoder().decode(raw);
}

function userActionText(runRequest) {
	const action = fieldBytesOf(runRequest, 2);
	const userAction = fieldBytesOf(action, 1);
	const user = fieldBytesOf(userAction, 1);
	return fieldStringOf(user, 1) ?? "";
}

test("identityMatches rejects a reused session id", () => {
	assert.equal(identityMatches(undefined, undefined), true);
	assert.equal(identityMatches({ createdAt: 1 }, undefined), true);
	assert.equal(identityMatches(undefined, { createdAt: 1 }), false);
	assert.equal(identityMatches({ createdAt: 1 }, { createdAt: 1 }), true);
	assert.equal(identityMatches({ createdAt: 1, cwd: "/a" }, { createdAt: 1, cwd: "/a" }), true);
	assert.equal(identityMatches({ createdAt: 1 }, { createdAt: 2 }), false);
	assert.equal(identityMatches({ createdAt: 1, cwd: "/a" }, { createdAt: 1, cwd: "/b" }), false);
});

test("checkpoint store round-trips checkpoint bytes and blobs", async () => {
	const facility = memoryFacility();
	const store = createCheckpointStore({
		storageDomain: facility,
		files: memoryAttachments(),
	});
	const checkpoint = Uint8Array.from([1, 2, 3, 4]);
	const blob = Uint8Array.from([9, 8, 7]);
	const hex = "ab".repeat(32);
	await store.persist("sess-1", {
		conversationId: "conv-1",
		checkpoint,
		blobs: new Map([[hex, blob]]),
		tokenDetails: { usedTokens: 10, maxTokens: 100 },
	}, { createdAt: 42, cwd: "/work" });
	const loaded = await store.load("sess-1", { createdAt: 42, cwd: "/work" });
	assert.equal(loaded.conversationId, "conv-1");
	assert.deepEqual([...loaded.checkpoint], [1, 2, 3, 4]);
	assert.deepEqual([...loaded.blobs.get(hex)], [9, 8, 7]);
	assert.deepEqual(loaded.tokenDetails, { usedTokens: 10, maxTokens: 100 });
	await store.close();
});

test("checkpoint store hides a row from a later session lifecycle", async () => {
	const store = createCheckpointStore({
		storageDomain: memoryFacility(),
		files: memoryAttachments(),
	});
	await store.persist("sess-1", {
		conversationId: "conv-1",
		checkpoint: Uint8Array.from([1]),
		blobs: new Map(),
	}, { createdAt: 1 });
	assert.equal(await store.load("sess-1", { createdAt: 2 }), undefined);
	await store.close();
});

test("persist without a checkpoint is a no-op", async () => {
	const store = createCheckpointStore({
		storageDomain: memoryFacility(),
		files: memoryAttachments(),
	});
	await store.persist("sess-1", { conversationId: "conv-1", blobs: new Map() });
	assert.equal(await store.load("sess-1"), undefined);
	await store.close();
});

test("checkpoint object segments sit under the storage-json unit", () => {
	assert.deepEqual([...CHECKPOINT_OBJECTS_SEGMENTS], ["storages", "cursor_agent", "objects"]);
});

test("local object store round-trips bytes", async () => {
	const root = await mkdtemp(join(tmpdir(), "cursor-objects-"));
	try {
		const files = createLocalObjectStore(root);
		const ref = await files.saveFile({ data: Uint8Array.from([4, 5, 6]), name: "ckpt.bin" });
		assert.match(ref.attachmentId, /^sha256:[0-9a-f]{64}$/);
		assert.equal(ref.bytes, 3);
		const again = await files.saveFile({ data: Uint8Array.from([4, 5, 6]), name: "ckpt.bin" });
		assert.equal(again.attachmentId, ref.attachmentId);
		const chunks = [];
		for await (const chunk of files.readFileStream(ref)) chunks.push(chunk);
		assert.deepEqual([...Buffer.concat(chunks)], [4, 5, 6]);
		const store = createCheckpointStore({
			storageDomain: memoryFacility(),
			files: createLocalObjectStore(root),
		});
		await store.persist("sess-1", {
			conversationId: "conv-1",
			checkpoint: Uint8Array.from([1, 2, 3]),
			blobs: new Map(),
		}, { createdAt: 1 });
		const loaded = await store.load("sess-1", { createdAt: 1 });
		assert.deepEqual([...loaded.checkpoint], [1, 2, 3]);
		await store.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("missing storageDomain fails soft", async () => {
	const store = createCheckpointStore({
		files: memoryAttachments(),
	});
	await store.persist("sess-1", {
		conversationId: "conv-1",
		checkpoint: Uint8Array.from([1]),
		blobs: new Map(),
	});
	assert.equal(await store.load("sess-1"), undefined);
	await store.close();
});

test("a new adapter hydrates the checkpoint after a simulated restart", async () => {
	const store = createCheckpointStore({
		storageDomain: memoryFacility(),
		files: memoryAttachments(),
	});
	const checkpoint = new Writer().bytes(4, new TextEncoder().encode("ckpt")).finish();
	const firstRuns = [];
	const first = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		checkpointStore: store,
		createAgentRun: () => {
			const run = fakeRun([
				frameEncode(new Writer().message(3, checkpoint).finish()),
			], { endFrames: true });
			firstRuns.push(run);
			return run;
		},
	});
	await drainStream(first.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "persist-session",
		messages: [{ role: "user", content: [{ type: "text", text: "first" }] }],
	}));
	const conversationId = fieldStringOf(runRequestOf(firstRuns[0].writes[0]), 5);

	const secondRuns = [];
	const second = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		checkpointStore: store,
		createAgentRun: () => {
			const run = fakeRun([], { endFrames: true });
			secondRuns.push(run);
			return run;
		},
	});
	await drainStream(second.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "persist-session",
		messages: [
			{ role: "user", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: [{ type: "text", text: "second" }] },
		],
	}));
	const request = runRequestOf(secondRuns[0].writes[0]);
	assert.deepEqual([...fieldBytesOf(request, 1)], [...checkpoint]);
	assert.equal(fieldStringOf(request, 5), conversationId);
	assert.equal(userActionText(request), "second");
	assert.equal(userActionText(request).includes("Continue the DSH conversation"), false);
	await store.close();
});

function mockLogSession(events = [], { nodes, createdAt = 1, cwd = "/work" } = {}) {
	const log = [...events];
	return {
		log,
		header: { createdAt, cwd },
		get seq() { return log.length; },
		snapshotEvents() { return [...log]; },
		surface: {
			get nodes() {
				if (Array.isArray(nodes)) return nodes;
				return log
					.filter((event) => event.type === "user/message" || event.type === "assistant/message")
					.map((event) => event.seq);
			},
			validateNext() {},
		},
		eventsSnapshot: undefined,
	};
}

function agentsOf(sessionId, session) {
	return {
		get(id) {
			return id === sessionId ? { session } : undefined;
		},
	};
}

test("persist returns pointers that loadPointers can rehydrate", async () => {
	const store = createCheckpointStore({
		storageDomain: memoryFacility(),
		files: memoryAttachments(),
	});
	const hex = "cd".repeat(32);
	const record = await store.persist("sess-1", {
		conversationId: "conv-1",
		checkpoint: Uint8Array.from([7, 8, 9]),
		blobs: new Map([[hex, Uint8Array.from([1])]]),
		tokenDetails: { usedTokens: 3 },
	}, { createdAt: 1 });
	assert.equal(record.conversationId, "conv-1");
	assert.equal(typeof record.checkpoint.attachmentId, "string");
	assert.equal(record.identity, undefined);
	const loaded = await store.loadPointers({
		schemaVersion: CURSOR_CHECKPOINT_SCHEMA_VERSION,
		...record,
	});
	assert.deepEqual([...loaded.checkpoint], [7, 8, 9]);
	assert.deepEqual([...loaded.blobs.get(hex)], [1]);
	assert.deepEqual(loaded.tokenDetails, { usedTokens: 3 });
	await store.close();
});

test("a forked session hydrates from an inherited log marker", async () => {
	const store = createCheckpointStore({
		storageDomain: memoryFacility(),
		files: memoryAttachments(),
	});
	const checkpoint = new Writer().bytes(4, new TextEncoder().encode("ckpt")).finish();
	const parent = mockLogSession();
	const firstRuns = [];
	const first = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		checkpointStore: store,
		agents: agentsOf("parent", parent),
		createAgentRun: () => {
			const run = fakeRun([
				frameEncode(new Writer().message(3, checkpoint).finish()),
			], { endFrames: true });
			firstRuns.push(run);
			return run;
		},
	});
	await drainStream(first.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "parent",
		messages: [{ role: "user", content: [{ type: "text", text: "first" }] }],
	}));
	await store.flush();
	assert.equal(parent.log.at(-1)?.type, CURSOR_CHECKPOINT_EVENT_TYPE);
	assert.equal(parent.log.at(-1)?.ignorable, true);
	const conversationId = fieldStringOf(runRequestOf(firstRuns[0].writes[0]), 5);

	const child = mockLogSession([
		{ type: "user/message", seq: 0, data: { source: { kind: "user" } } },
		parent.log.at(-1),
	], { nodes: [0] });
	const secondRuns = [];
	const second = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		checkpointStore: store,
		agents: agentsOf("child", child),
		createAgentRun: () => {
			const run = fakeRun([], { endFrames: true });
			secondRuns.push(run);
			return run;
		},
	});
	await drainStream(second.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "child",
		messages: [
			{ role: "user", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: [{ type: "text", text: "second" }] },
		],
	}));
	const request = runRequestOf(secondRuns[0].writes[0]);
	assert.deepEqual([...fieldBytesOf(request, 1)], [...checkpoint]);
	assert.equal(fieldStringOf(request, 5), conversationId);
	assert.equal(userActionText(request), "second");
	await store.close();
});

test("same-session rewind hydrates the marker before the withdrawn human", async () => {
	const store = createCheckpointStore({
		storageDomain: memoryFacility(),
		files: memoryAttachments(),
	});
	const firstCkpt = new Writer().bytes(4, new TextEncoder().encode("one")).finish();
	const secondCkpt = new Writer().bytes(4, new TextEncoder().encode("two")).finish();
	const session = mockLogSession([
		{ type: "user/message", seq: 0, data: { source: { kind: "user" } } },
	], { nodes: [0] });
	let turn = 0;
	const adapter = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		checkpointStore: store,
		agents: agentsOf("rewind-session", session),
		createAgentRun: () => {
			turn += 1;
			const bytes = turn === 1 ? firstCkpt : secondCkpt;
			return fakeRun([
				frameEncode(new Writer().message(3, bytes).finish()),
			], { endFrames: true });
		},
	});
	await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "rewind-session",
		messages: [{ role: "user", content: [{ type: "text", text: "first" }] }],
	}));
	await store.flush();
	const firstMarker = session.log.find((event) => event.type === CURSOR_CHECKPOINT_EVENT_TYPE);
	session.log.push({ type: "user/message", seq: session.log.length, data: { source: { kind: "user" } } });
	await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "rewind-session",
		messages: [
			{ role: "user", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: [{ type: "text", text: "second" }] },
		],
	}));
	await store.flush();
	assert.equal(session.log.filter((event) => event.type === CURSOR_CHECKPOINT_EVENT_TYPE).length, 2);

	const replay = mockLogSession([...session.log], { nodes: [0] });
	const replayRuns = [];
	const restarted = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		checkpointStore: store,
		agents: agentsOf("rewind-session", replay),
		createAgentRun: () => {
			const run = fakeRun([], { endFrames: true });
			replayRuns.push(run);
			return run;
		},
	});
	await drainStream(restarted.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "rewind-session",
		messages: [
			{ role: "user", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: [{ type: "text", text: "edited" }] },
		],
	}));
	const request = runRequestOf(replayRuns[0].writes[0]);
	assert.deepEqual([...fieldBytesOf(request, 1)], [...firstCkpt]);
	assert.equal(fieldStringOf(request, 5), firstMarker.data.conversationId);
	assert.equal(userActionText(request), "edited");
	await store.close();
});

test("same adapter follows a trailing human replace instead of the in-memory latest", async () => {
	const store = createCheckpointStore({
		storageDomain: memoryFacility(),
		files: memoryAttachments(),
	});
	const firstCkpt = new Writer().bytes(4, new TextEncoder().encode("one")).finish();
	const secondCkpt = new Writer().bytes(4, new TextEncoder().encode("two")).finish();
	const nodes = [0];
	const session = mockLogSession([
		{ type: "user/message", seq: 0, data: { source: { kind: "user" } } },
	], { nodes });
	let turn = 0;
	const adapter = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		checkpointStore: store,
		agents: agentsOf("live-rewind", session),
		createAgentRun: () => {
			turn += 1;
			const bytes = turn === 1 ? firstCkpt : secondCkpt;
			return fakeRun([
				frameEncode(new Writer().message(3, bytes).finish()),
			], { endFrames: true });
		},
	});
	await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "live-rewind",
		messages: [{ role: "user", content: [{ type: "text", text: "first" }] }],
	}));
	await store.flush();
	const firstMarker = session.log.find((event) => event.type === CURSOR_CHECKPOINT_EVENT_TYPE);
	const withdrawnSeq = session.log.length;
	session.log.push({ type: "user/message", seq: withdrawnSeq, data: { source: { kind: "user" } } });
	nodes.push(withdrawnSeq);
	await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "live-rewind",
		messages: [
			{ role: "user", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: [{ type: "text", text: "second" }] },
		],
	}));
	await store.flush();
	assert.equal(session.log.filter((event) => event.type === CURSOR_CHECKPOINT_EVENT_TYPE).length, 2);

	const replacementSeq = session.log.length;
	session.log.push({
		type: "user/message",
		seq: replacementSeq,
		data: { source: { kind: "user" } },
		surfaceOp: { op: "replace", startSeq: withdrawnSeq, endSeq: withdrawnSeq },
	});
	nodes.splice(0, nodes.length, 0, replacementSeq);

	const rewindRuns = [];
	const previousFactory = adapter.createAgentRun;
	adapter.createAgentRun = () => {
		const run = fakeRun([], { endFrames: true });
		rewindRuns.push(run);
		return run;
	};
	await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "live-rewind",
		messages: [
			{ role: "user", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: [{ type: "text", text: "edited" }] },
		],
	}));
	adapter.createAgentRun = previousFactory;
	const request = runRequestOf(rewindRuns[0].writes[0]);
	assert.deepEqual([...fieldBytesOf(request, 1)], [...firstCkpt]);
	assert.equal(fieldStringOf(request, 5), firstMarker.data.conversationId);
	assert.equal(userActionText(request), "edited");
	await store.close();
});
