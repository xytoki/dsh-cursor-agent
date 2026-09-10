/**
 * Log-only Cursor checkpoint markers.
 *
 * Each persist writes protobuf/blob bytes to the plugin object directory and
 * appends a `cursor-agent/checkpoint` event that stores only pointers
 * (`conversationId` + `FileAttachmentRef`-shaped JSON). The event type is
 * outside DSH `KNOWN_SESSION_EVENT_TYPES`, so the envelope must carry
 * `ignorable: true` forever — otherwise persistence refuses the session.
 *
 * `Session.append()` cannot set `ignorable`. This module builds the envelope,
 * validates it through `session.surface.validateNext`, pushes onto `session.log`,
 * and publishes `session/event` so `dsh-session-persistence-jsonl` can enqueue.
 */
import { z } from "zod";
import { fileAttachmentRefSchema, tokenDetailsSchema } from "./checkpoint-store";

export const CURSOR_CHECKPOINT_EVENT_TYPE = "cursor-agent/checkpoint";
export const CURSOR_CHECKPOINT_SCHEMA_VERSION = 1;

const BLOB_HEX = /^[0-9a-f]+$/;

export const cursorCheckpointEventDataSchema = z.object({
	schemaVersion: z.literal(CURSOR_CHECKPOINT_SCHEMA_VERSION),
	conversationId: z.string().min(1),
	checkpoint: fileAttachmentRefSchema,
	blobs: z.record(z.string().regex(BLOB_HEX), fileAttachmentRefSchema).default({}),
	tokenDetails: tokenDetailsSchema.optional(),
});

export function isHumanUserMessage(event) {
	return event?.type === "user/message" && event.data?.source?.kind === "user";
}

export function isCursorCheckpointEvent(event) {
	return event != null
		&& event.type === CURSOR_CHECKPOINT_EVENT_TYPE
		&& event.ignorable === true
		&& cursorCheckpointEventDataSchema.safeParse(event.data).success;
}

export function listCursorCheckpointEvents(events) {
	const out = [];
	for (const event of events ?? []) {
		if (isCursorCheckpointEvent(event)) out.push(event);
	}
	return out;
}

function replaceStartOf(event) {
	const op = event?.surfaceOp;
	if (op == null || op === "append" || typeof op !== "object") return undefined;
	if (op.op !== "replace") return undefined;
	const start = op.startSeq ?? op.start;
	return Number.isSafeInteger(start) && start >= 0 ? start : undefined;
}

function lastMarkerBefore(markers, seq) {
	for (let i = markers.length - 1; i >= 0; i--) {
		if (markers[i].seq < seq) return markers[i];
	}
	return undefined;
}

/**
 * Choose the marker that matches the conversation the surface still shows.
 *
 * lastKeptHuman = last human `user/message` on `session.surface`.
 *
 * A trailing human with `surfaceOp.replace` is same-session rewind
 * (`dsh-rewind`): take the last marker before `replace.start`. Compaction's
 * replace is `source.kind === "plugin"`, so it does not take this path.
 *
 * Otherwise firstWithdrawnAfterKept = first later human still in the log but
 * not on the surface. If that exists, take the last marker before it.
 * Otherwise take the last marker (continue, official fork prefix,
 * message-edit seed, DSH compaction).
 *
 * `surfaceNodes === undefined` means the caller has no surface; use the last
 * marker. An actual empty array still runs the withdrawn-human walk.
 */
export function pickCursorCheckpointEvent(events, surfaceNodes) {
	const markers = listCursorCheckpointEvents(events);
	if (markers.length === 0) return undefined;
	if (surfaceNodes === undefined || surfaceNodes === null) {
		return markers[markers.length - 1];
	}

	const onSurface = new Set(surfaceNodes);
	let lastKeptHuman;
	for (const event of events ?? []) {
		if (!isHumanUserMessage(event)) continue;
		if (onSurface.has(event.seq)) lastKeptHuman = event;
	}

	const replaceStart = lastKeptHuman === undefined ? undefined : replaceStartOf(lastKeptHuman);
	if (replaceStart !== undefined) return lastMarkerBefore(markers, replaceStart);

	const lastKeptSeq = lastKeptHuman?.seq ?? -1;
	let firstWithdrawnAfterKept;
	for (const event of events ?? []) {
		if (!isHumanUserMessage(event)) continue;
		if (event.seq <= lastKeptSeq) continue;
		if (!onSurface.has(event.seq)) {
			firstWithdrawnAfterKept = event.seq;
			break;
		}
	}

	if (firstWithdrawnAfterKept === undefined) return markers[markers.length - 1];
	return lastMarkerBefore(markers, firstWithdrawnAfterKept);
}

function lastCursorCheckpointEvent(events) {
	const markers = listCursorCheckpointEvents(events);
	return markers.length === 0 ? undefined : markers[markers.length - 1];
}

function sameCheckpointPointer(left, right) {
	return left?.conversationId === right?.conversationId
		&& left?.checkpoint?.attachmentId === right?.checkpoint?.attachmentId;
}

/**
 * Append one ignorable checkpoint marker. Returns the logged event, the
 * existing last marker when the pointer is unchanged, or undefined on reject.
 */
export function appendCursorCheckpointEvent(session, data, publish) {
	if (session == null || !Array.isArray(session.log)) return undefined;
	const parsed = cursorCheckpointEventDataSchema.safeParse(data);
	if (!parsed.success) return undefined;

	const last = lastCursorCheckpointEvent(session.log);
	if (last !== undefined && sameCheckpointPointer(last.data, parsed.data)) {
		return last;
	}

	const event = Object.freeze({
		type: CURSOR_CHECKPOINT_EVENT_TYPE,
		seq: session.log.length,
		time: Date.now(),
		data: parsed.data,
		ignorable: true,
	});
	try {
		session.surface?.validateNext?.(event);
	} catch {
		return undefined;
	}
	session.log.push(event);
	session.eventsSnapshot = undefined;
	try {
		publish?.(session, event);
	} catch {
		// already in the in-process log
	}
	return event;
}
