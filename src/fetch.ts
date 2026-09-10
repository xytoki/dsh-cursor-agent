import http from "node:http";
import https from "node:https";

/**
 * DSH web replaces the ambient `fetch` with an MCP `createFetchWithInit`
 * wrapper whose `baseFetch` is undefined in the host process, so any consumer
 * of the global `fetch` throws `baseFetch is not a function`. Cursor usage /
 * refresh / model discovery go through HTTP, so this module uses Node's own
 * `http`/`https` to talk to the upstream directly instead of trusting the
 * host-injected `fetch`. It exposes the small Fetch subset these callers use.
 */
export async function nativeFetch(url, init : any = {}) {
	const target = new URL(url);
	const client = target.protocol === "https:" ? https : http;
	const method = (init.method ?? "GET").toUpperCase();
	const body = init.body === undefined ? undefined : isBytes(init.body) ? Buffer.from(init.body) : String(init.body);

	const request = (u, redirect): Promise<any> =>
		new Promise((resolve, reject) => {
			const req = client.request(
				u,
				{
					method,
					headers: sanitizeHeaders(init.headers),
					signal: init.signal,
				},
				(res) => {
					const chunks = [];
					res.on("data", (chunk) => chunks.push(chunk));
					res.on("end", () => {
						const data = Buffer.concat(chunks);
						const status = res.statusCode ?? 0;
						if ((redirect === "error" || redirect === "manual") && status >= 300 && status < 400) {
							reject(new Error(`HTTP ${status} from ${u.origin}${u.pathname}`));
							return;
						}
						const location = res.headers.location;
						if ((redirect ?? "follow") === "follow" && location && status >= 300 && status < 400) {
							const next = new URL(location, u);
							resolve({ redirect: next });
							return;
						}
						resolve({
							response: makeResponse(status, res, data),
						});
					});
				},
			);
			req.on("error", reject);
			if (body !== undefined) req.write(body);
			req.end();
		});

	let u = target;
	for (let hops = 0; ; hops++) {
		const result = await request(u, init.redirect);
		if (result.redirect !== undefined) {
			if (hops >= 6) throw new Error(`too many redirects from ${target.href}`);
			u = result.redirect;
			continue;
		}
		return result.response;
	}
}

function isBytes(value) {
	return value instanceof Uint8Array || (typeof value !== "string" && ArrayBuffer.isView(value));
}

function sanitizeHeaders(headers) {
	if (headers === undefined) return undefined;
	const out: any = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		out[key] = value;
	}
	return out;
}

function makeResponse(status, res, data) {
	const text = () => data.toString("utf8");
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: res.statusMessage ?? "",
		headers: {
			get: (name) => res.headers[String(name).toLowerCase()] ?? null,
		},
		text,
		json: async () => JSON.parse(text()),
		arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
	};
}
