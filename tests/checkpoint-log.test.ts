/**
 * Log-only Cursor checkpoint markers: pick + ignorable append.
 */
import { test } from "@rstest/core";
import assert from "node:assert/strict";

import {
	CURSOR_CHECKPOINT_EVENT_TYPE,
	CURSOR_CHECKPOINT_SCHEMA_VERSION,
	appendCursorCheckpointEvent,
	isCursorCheckpointEvent,
	listCursorCheckpointEvents,
	pickCursorCheckpointEvent,
} from "../src/checkpoint-log";

function ref(id, bytes = 4) {
	return { attachmentId: `sha256:${id}`, name: "cursor-checkpoint.bin", bytes };
}

function marker(seq, id, conversationId = "conv-1") {
	return {
		type: CURSOR_CHECKPOINT_EVENT_TYPE,
		seq,
		time: seq,
		ignorable: true,
		data: {
			schemaVersion: CURSOR_CHECKPOINT_SCHEMA_VERSION,
			conversationId,
			checkpoint: ref(id),
			blobs: {},
		},
	};
}

function human(seq, extra = {}) {
	return {
		type: "user/message",
		seq,
		time: seq,
		data: { source: { kind: "user" }, message: { content: [{ type: "text", text: `u${seq}` }] } },
		...extra,
	};
}

function pluginUser(seq) {
	return {
		type: "user/message",
		seq,
		time: seq,
		data: { source: { kind: "plugin", plugin: "compaction" }, message: { content: [{ type: "text", text: "summary" }] } },
	};
}

test("isCursorCheckpointEvent requires ignorable and schema", () => {
	assert.equal(isCursorCheckpointEvent(marker(3, "aa".repeat(32))), true);
	assert.equal(isCursorCheckpointEvent({ ...marker(3, "aa".repeat(32)), ignorable: undefined }), false);
	assert.equal(isCursorCheckpointEvent({ type: "user/message", seq: 0, data: {} }), false);
});

test("pick uses the last marker when continuing", () => {
	const first = marker(2, "aa".repeat(32));
	const second = marker(5, "bb".repeat(32));
	const events = [human(1), first, human(4), second];
	assert.equal(pickCursorCheckpointEvent(events, [1, 4]), second);
	assert.equal(pickCursorCheckpointEvent(events), second);
});

test("pick uses the marker before a withdrawn later human (rewind)", () => {
	const first = marker(2, "aa".repeat(32));
	const second = marker(5, "bb".repeat(32));
	const events = [human(1), first, human(4), second];
	assert.equal(pickCursorCheckpointEvent(events, [1]), first);
});

test("pick uses the marker before a trailing human replace (same-session rewind)", () => {
	const first = marker(2, "aa".repeat(32));
	const second = marker(5, "bb".repeat(32));
	const replacement = human(7, { surfaceOp: { op: "replace", startSeq: 4, endSeq: 4 } });
	const events = [human(1), first, human(4), second, replacement];
	assert.equal(pickCursorCheckpointEvent(events, [1, 7]), first);
});

test("pick accepts surfaceOp.start on a trailing human replace", () => {
	const first = marker(2, "aa".repeat(32));
	const second = marker(5, "bb".repeat(32));
	const replacement = human(7, { surfaceOp: { op: "replace", start: 4, end: 4 } });
	const events = [human(1), first, human(4), second, replacement];
	assert.equal(pickCursorCheckpointEvent(events, [1, 7]), first);
});

test("pick stays on the last marker when withdrawn humans are older (compaction)", () => {
	const first = marker(2, "aa".repeat(32));
	const second = marker(6, "bb".repeat(32));
	const events = [human(1), first, pluginUser(4), human(5), second];
	assert.equal(pickCursorCheckpointEvent(events, [4, 5]), second);
});

test("pick uses the last inherited marker on a fork prefix", () => {
	const inherited = marker(3, "aa".repeat(32));
	const events = [human(1), inherited, { type: "session/end-seed", seq: 4, data: {} }];
	assert.equal(pickCursorCheckpointEvent(events, [1]), inherited);
});

test("pick returns undefined when rewind is before any marker", () => {
	const later = marker(4, "aa".repeat(32));
	const events = [human(1), human(2), later];
	assert.equal(pickCursorCheckpointEvent(events, []), undefined);
});

test("appendCursorCheckpointEvent writes ignorable and skips duplicates", () => {
	const published = [];
	const session = {
		log: [],
		eventsSnapshot: [],
		surface: { validateNext() {} },
	};
	const data = {
		schemaVersion: CURSOR_CHECKPOINT_SCHEMA_VERSION,
		conversationId: "conv-1",
		checkpoint: ref("cc".repeat(32)),
		blobs: {},
	};
	const first = appendCursorCheckpointEvent(session, data, (subject, event) => {
		published.push({ subject, event });
	});
	assert.equal(first.type, CURSOR_CHECKPOINT_EVENT_TYPE);
	assert.equal(first.ignorable, true);
	assert.equal(first.seq, 0);
	assert.equal(session.log.length, 1);
	assert.equal(session.eventsSnapshot, undefined);
	assert.equal(published.length, 1);
	assert.equal(Object.hasOwn(first, "surfaceOp"), false);

	const again = appendCursorCheckpointEvent(session, data, (subject, event) => {
		published.push({ subject, event });
	});
	assert.equal(again, first);
	assert.equal(session.log.length, 1);
	assert.equal(published.length, 1);
	assert.deepEqual(listCursorCheckpointEvents(session.log), [first]);
});

test("appendCursorCheckpointEvent rejects a non-ignorable-safe payload", () => {
	const session = { log: [], surface: { validateNext() {} } };
	assert.equal(appendCursorCheckpointEvent(session, { conversationId: "x" }), undefined);
	assert.equal(session.log.length, 0);
});
