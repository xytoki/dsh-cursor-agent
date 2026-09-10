import { gunzipSync } from "node:zlib";
import { CURSOR_CLIENT_VERSION } from "../constants";

export function frameEncode(payload, flags = 0) {
	const out = new Uint8Array(5 + payload.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, flags);
	view.setUint32(1, payload.length, false);
	out.set(payload, 5);
	return out;
}

export const CONNECT_END_STREAM_FLAG = 0b00000010;
export const CONNECT_COMPRESSED_FLAG = 0b00000001;

/** Upper bound for a decompressed Connect frame; guards against zip bombs. */
export const MAX_CONNECT_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * Incremental Connect frame parser fed by response chunks.
 * Yields { flags, payload } objects. Frames flagged compressed (bit 0) are
 * gzip-decompressed here so consumers only ever see plain payloads.
 */
export class ConnectFrameReader {
	buffer: Uint8Array;
	frames: Array<{ flags: number; payload: Uint8Array }>;
	waiters: Array<{ resolve: (frame?: { flags: number; payload: Uint8Array }) => void; reject: (error: unknown) => void }>;
	ended: boolean;
	error: unknown;

	constructor() {
		this.buffer = new Uint8Array(0);
		this.frames = [];
		this.waiters = [];
		this.ended = false;
		this.error = undefined;
	}

	push(chunk) {
		const combined = new Uint8Array(this.buffer.length + chunk.length);
		combined.set(this.buffer);
		combined.set(chunk, this.buffer.length);
		this.buffer = combined;
		while (this.buffer.length >= 5) {
			const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, 5);
			const flags = view.getUint8(0);
			const length = view.getUint32(1, false);
			if (this.buffer.length < 5 + length) break;
			const payload = this.buffer.slice(5, 5 + length);
			this.buffer = this.buffer.slice(5 + length);
			let data = payload;
			if ((flags & CONNECT_COMPRESSED_FLAG) !== 0) {
				try {
					data = gunzipSync(Buffer.from(payload), { maxOutputLength: MAX_CONNECT_FRAME_BYTES });
				} catch (error) {
					this.fail(new Error("Cursor sent an unreadable compressed frame", { cause: error }));
					return;
				}
			}
			this.#enqueue({ flags: flags & ~CONNECT_COMPRESSED_FLAG, payload: data });
		}
	}

	#enqueue(frame) {
		if (this.waiters.length > 0) {
			const waiter = this.waiters.shift();
			waiter.resolve(frame);
			return;
		}
		this.frames.push(frame);
	}

	finish() {
		this.ended = true;
		for (const waiter of this.waiters.splice(0)) waiter.resolve(undefined);
	}

	fail(error) {
		this.error = error;
		this.ended = true;
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}

	async next(): Promise<any> {
		if (this.frames.length > 0) return this.frames.shift();
		if (this.ended) {
			if (this.error !== undefined) throw this.error;
			return undefined;
		}
		return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
	}
}
//#endregion

//#region agent transport
export const AGENT_HEADERS = {
	"content-type": "application/connect+proto",
	"connect-protocol-version": "1",
	"connect-accept-encoding": "gzip",
	te: "trailers",
	"x-ghost-mode": "true",
	"x-cursor-client-version": CURSOR_CLIENT_VERSION,
	"x-cursor-client-type": "cli",
};
