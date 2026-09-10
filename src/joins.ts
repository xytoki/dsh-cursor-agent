/**
 * In-flight Cursor exec/display results keyed by the DSH tool-call id.
 * The adapter settles these when exec-plane or a display-completed frame
 * finishes; shim `execute()` only joins that promise.
 */

const joins = new Map();

function createJoin(callId) {
	let settle;
	let fail;
	const promise = new Promise((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	// A consumer that never awaits must not surface as unhandled.
	promise.catch(() => {});
	return { callId, promise, settle, fail, settled: false };
}

/** Open (or return) the join for one DSH call id. */
export function openCursorJoin(callId) {
	if (typeof callId !== "string" || callId.length === 0) {
		throw new Error("cursor-agent: join id is required");
	}
	const existing = joins.get(callId);
	if (existing !== undefined) return existing;
	const entry = createJoin(callId);
	joins.set(callId, entry);
	return entry;
}

/** Resolve one join. Later settles are ignored. */
export function settleCursorJoin(callId, result : any = {}) {
	if (typeof callId !== "string" || callId.length === 0) return;
	const entry = joins.get(callId) ?? openCursorJoin(callId);
	if (entry.settled) return;
	entry.settled = true;
	entry.settle({
		text: String(result.text ?? ""),
		isError: result.isError === true,
		...result.meta !== undefined ? { meta: result.meta } : {},
	});
}

/** Reject one join. Later fails/settles are ignored. */
export function failCursorJoin(callId, error) {
	if (typeof callId !== "string" || callId.length === 0) return;
	const entry = joins.get(callId) ?? openCursorJoin(callId);
	if (entry.settled) return;
	entry.settled = true;
	entry.fail(error instanceof Error ? error : new Error(String(error ?? "Cursor join failed")));
}

/** Drop a join that will never be awaited (paired probe-read). */
export function dropCursorJoin(callId) {
	if (typeof callId !== "string" || callId.length === 0) return;
	joins.delete(callId);
}

/** Await the exec-plane / display result for this call. */
export async function awaitCursorJoin(callId, signal) {
	const entry = joins.get(callId);
	if (entry === undefined) {
		throw new Error(`cursor-agent: no in-flight join for ${callId}`);
	}
	if (signal?.aborted) {
		throw signal.reason instanceof Error ? signal.reason : new Error("Cursor join aborted");
	}
	try {
		if (signal === undefined) return await entry.promise;
		return await new Promise((resolve, reject) => {
			const onAbort = () => {
				signal.removeEventListener("abort", onAbort);
				reject(signal.reason instanceof Error ? signal.reason : new Error("Cursor join aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			entry.promise.then(
				(value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
		});
	} finally {
		joins.delete(callId);
	}
}

/** Test helper: forget every join. */
export function resetCursorJoins() {
	joins.clear();
}
