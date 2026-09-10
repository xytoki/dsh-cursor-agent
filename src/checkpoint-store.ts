/**
 * Durable Cursor conversation checkpoints.
 *
 * Latest-per-session pointers live in `ctx.storageDomain` (`cursor_agent` /
 * `sessions`) as a fallback for logs that have no markers yet.
 * Checkpoint protobuf and KV blob bytes live in a plugin-owned directory at
 * `dshHomePath('storages', 'cursor_agent', 'objects')`, next to the domain's
 * per-record JSON. Host `ctx.attachments` is image-only on current DSH and
 * is not used here.
 * `persist` also returns those pointers so the adapter can append a log-only
 * `cursor-agent/checkpoint` event. The session log is authoritative for
 * rewind / edit / fork; this table row is only the latest pointer.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { cursorAgentDebug } from "./constants";

/** Domain / table names must match DSH `UNIT_NAME_RE`. */
export const CURSOR_AGENT_DOMAIN = "cursor_agent";

const BLOB_HEX = /^[0-9a-f]+$/;

const nonNegativeInt = z.number().int().nonnegative();

/** Content-addressed file pointer — same shape as DSH `FileAttachmentRef`. */
export const fileAttachmentRefSchema = z.object({
	attachmentId: z.string().min(1),
	name: z.string(),
	bytes: nonNegativeInt,
});

/** Session-lifecycle fence so a reused DSH session id cannot inherit the previous Cursor conversation. */
export const sessionIdentitySchema = z.object({
	createdAt: nonNegativeInt,
	cwd: z.string().optional(),
});

export const tokenDetailsSchema = z.object({
	usedTokens: nonNegativeInt.optional(),
	maxTokens: nonNegativeInt.optional(),
});

/** One session's durable Cursor run pointer. Bytes stay in the object store. */
export const checkpointRecordSchema = z.object({
	identity: sessionIdentitySchema.optional(),
	conversationId: z.string().min(1),
	checkpoint: fileAttachmentRefSchema,
	blobs: z.record(z.string().regex(BLOB_HEX), fileAttachmentRefSchema).default({}),
	tokenDetails: tokenDetailsSchema.optional(),
});

/**
 * Spec object for `ctx.storageDomain.open`. Hand-built so this plugin does
 * not import `@deepseek-ai/dsh-storage-domain` (the host already mounts it).
 */
export const cursorAgentDomainSpec = {
	name: CURSOR_AGENT_DOMAIN,
	version: 1,
	layout: "per-record",
	invalidRecords: "backup-and-skip",
	tables: {
		sessions: { valueSchema: checkpointRecordSchema },
	},
};

/**
 * A stored row may be reused only when it is fenced to the live Session
 * lifecycle. No live header (tests, agents unset) accepts any row. A live
 * session with no stored fence is a reused id and must not inherit.
 */
export function identityMatches(stored, live) {
	if (live == null) return true;
	if (stored == null) return false;
	if (stored.createdAt !== live.createdAt) return false;
	if (stored.cwd !== undefined && live.cwd !== undefined && stored.cwd !== live.cwd) {
		return false;
	}
	return true;
}

/** Segments for `dshHomePath(...)`. Do not join these onto a resolved home. */
export const CHECKPOINT_OBJECTS_SEGMENTS = Object.freeze(["storages", "cursor_agent", "objects"]);

const SHA256_ID = /^sha256:([0-9a-f]{64})$/;

/**
 * Content-addressed byte store under `root/<aa>/<sha256>`. Same
 * `saveFile` / `readFileStream` shape as DSH attachments, without
 * depending on the mounted provider.
 */
export function createLocalObjectStore(root) {
	if (typeof root !== "string" || root.length === 0) {
		throw new Error("checkpoint object store root is required");
	}
	return {
		async saveFile({ data, name }) {
			const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			const objectPath = join(root, sha256.slice(0, 2), sha256);
			await mkdir(dirname(objectPath), { recursive: true });
			const tmp = `${objectPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
			await writeFile(tmp, bytes);
			try {
				await rename(tmp, objectPath);
			} catch (error) {
				await unlink(tmp).catch(() => {});
				if (error?.code !== "EEXIST") throw error;
			}
			return {
				attachmentId: `sha256:${sha256}`,
				name: typeof name === "string" && name.length > 0 ? name : "file.bin",
				bytes: bytes.byteLength,
			};
		},
		async *readFileStream(ref, signal) {
			signal?.throwIfAborted?.();
			const match = SHA256_ID.exec(String(ref?.attachmentId ?? ""));
			if (match == null) throw new Error("invalid checkpoint object ref");
			const objectPath = join(root, match[1].slice(0, 2), match[1]);
			const data = await readFile(objectPath);
			if (Number.isInteger(ref.bytes) && data.byteLength !== ref.bytes) {
				throw new Error("checkpoint object length mismatch");
			}
			yield data;
		},
	};
}

/** Concatenate `readFileStream` chunks into one buffer. */
export async function readAttachmentBytes(attachments, ref, signal?) {
	if (attachments == null || typeof attachments.readFileStream !== "function") {
		throw new Error("attachments cannot read verbatim files");
	}
	const chunks = [];
	let total = 0;
	for await (const chunk of attachments.readFileStream(ref, signal)) {
		const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
		chunks.push(bytes);
		total += bytes.byteLength;
	}
	if (chunks.length === 0) return new Uint8Array(0);
	if (chunks.length === 1) return chunks[0];
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of chunks) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function snapshotTokenDetails(value) {
	if (value == null) return undefined;
	const details: any = {};
	if (Number.isInteger(value.usedTokens) && value.usedTokens >= 0) details.usedTokens = value.usedTokens;
	if (Number.isInteger(value.maxTokens) && value.maxTokens >= 0) details.maxTokens = value.maxTokens;
	return Object.keys(details).length > 0 ? details : undefined;
}

function snapshotIdentity(identity) {
	if (identity == null || !Number.isInteger(identity.createdAt) || identity.createdAt < 0) {
		return undefined;
	}
	return {
		createdAt: identity.createdAt,
		...(typeof identity.cwd === "string" && identity.cwd.length > 0 ? { cwd: identity.cwd } : {}),
	};
}

function logPersistError(message, error) {
	const detail = error instanceof Error ? error.message : String(error);
	cursorAgentDebug(`${message}: ${detail}`);
}

/**
 * Open-on-demand store. Missing `storageDomain` or `files` fail soft:
 * persist becomes a no-op and load returns undefined (cold start).
 */
export function createCheckpointStore(options : any = {}) {
	const filesOf = typeof options.files === "function"
		? options.files
		: () => options.files;
	const facility = options.storageDomain;
	let domain;
	let closed = false;
	let tail = Promise.resolve();

	const enqueue = (task) => {
		const run = tail.then(task, task);
		tail = run.then(() => undefined, () => undefined);
		return run;
	};

	const ensureDomain = async () => {
		if (closed) return undefined;
		if (domain !== undefined) return domain;
		if (facility == null || typeof facility.open !== "function") return undefined;
		domain = await facility.open(cursorAgentDomainSpec);
		return domain;
	};

	const pointersOf = (record) => ({
		conversationId: record.conversationId,
		checkpoint: record.checkpoint,
		blobs: record.blobs,
		...(record.tokenDetails === undefined ? {} : { tokenDetails: record.tokenDetails }),
	});

	const readSnapshot = async (record) => {
		const files = filesOf();
		if (files == null) return undefined;
		try {
			const checkpoint = await readAttachmentBytes(files, record.checkpoint);
			const blobs = new Map();
			for (const [hex, ref] of Object.entries(record.blobs)) {
				blobs.set(hex, await readAttachmentBytes(files, ref));
			}
			return {
				...pointersOf(record),
				checkpoint,
				blobs,
			};
		} catch (error) {
			logPersistError("checkpoint load failed", error);
			return undefined;
		}
	};

	const persistSnapshot = async (sessionId, snapshot, identity) => {
		if (closed || snapshot.checkpoint === undefined || snapshot.conversationId == null) return;
		const files = filesOf();
		if (files == null || typeof files.saveFile !== "function") return;
		try {
			const checkpoint = await files.saveFile({
				data: snapshot.checkpoint,
				name: "cursor-checkpoint.bin",
			});
			const blobs: any = {};
			for (const [hex, data] of snapshot.blobs) {
				if (!BLOB_HEX.test(hex) || data == null) continue;
				blobs[hex] = await files.saveFile({
					data: data instanceof Uint8Array ? data : Uint8Array.from(data),
					name: `cursor-blob-${hex.slice(0, 16)}.bin`,
				});
			}
			const record = checkpointRecordSchema.parse({
				conversationId: String(snapshot.conversationId),
				checkpoint,
				blobs,
				...(snapshot.tokenDetails === undefined ? {} : { tokenDetails: snapshot.tokenDetails }),
				...(identity === undefined ? {} : { identity }),
			});
			if (typeof sessionId === "string" && sessionId.length > 0) {
				try {
					const table = (await ensureDomain())?.table("sessions");
					if (table !== undefined) await table.put(sessionId, record);
				} catch (error) {
					logPersistError("checkpoint domain open failed", error);
				}
			}
			return pointersOf(record);
		} catch (error) {
			logPersistError("checkpoint persist failed", error);
		}
	};

	const loadNow = async (sessionId, liveIdentity) => {
		if (closed || typeof sessionId !== "string" || sessionId.length === 0) return undefined;
		let table;
		try {
			table = (await ensureDomain())?.table("sessions");
		} catch (error) {
			logPersistError("checkpoint domain open failed", error);
			return undefined;
		}
		if (table === undefined) return undefined;
		const raw = table.get(sessionId);
		if (raw === undefined) return undefined;
		const parsed = checkpointRecordSchema.safeParse(raw);
		if (!parsed.success) return undefined;
		const record = parsed.data;
		if (!identityMatches(record.identity, liveIdentity)) return undefined;
		return readSnapshot(record);
	};

	const loadFromPointers = async (raw) => {
		if (closed || raw == null) return undefined;
		const parsed = checkpointRecordSchema.safeParse({
			conversationId: raw.conversationId,
			checkpoint: raw.checkpoint,
			blobs: raw.blobs ?? {},
			...(raw.tokenDetails === undefined ? {} : { tokenDetails: raw.tokenDetails }),
		});
		if (!parsed.success) return undefined;
		return readSnapshot(parsed.data);
	};

	return {
		/**
		 * Snapshot the live session state and write it. No checkpoint → no-op.
		 * Concurrent calls share one write chain so load cannot race a persist.
		 * Resolves to the pointer record (no identity, no bytes) so a log event
		 * can be built; undefined when nothing was written.
		 */
		persist(sessionId, persisted, identity) {
			const snapshot = {
				checkpoint: persisted?.checkpoint === undefined
					? undefined
					: Uint8Array.from(persisted.checkpoint),
				blobs: new Map(persisted?.blobs ?? []),
				conversationId: persisted?.conversationId,
				tokenDetails: snapshotTokenDetails(persisted?.tokenDetails),
			};
			return enqueue(() => persistSnapshot(sessionId, snapshot, snapshotIdentity(identity)));
		},

		/** Latest pointer + bytes for this DSH session, or undefined. */
		load(sessionId, identity) {
			return enqueue(() => loadNow(sessionId, snapshotIdentity(identity)));
		},

		/** Read bytes for a log-marker or table pointer record. */
		loadPointers(record) {
			return enqueue(() => loadFromPointers(record));
		},

		async flush() {
			await tail;
		},

		async close() {
			closed = true;
			await tail;
			const handle = domain;
			domain = undefined;
			try {
				await handle?.close?.();
			} catch (error) {
				logPersistError("checkpoint domain close failed", error);
			}
		},
	};
}
