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

import {
	CREDENTIAL_REF,
	PROVIDER,
	CURSOR_AUTH_ORIGIN,
	CURSOR_BASE_URL,
	CURSOR_LOGIN_URL,
	CURSOR_POLL_PATH,
	CURSOR_REFRESH_PATH,
	CHANNEL,
	DEFAULT_TOKEN_LIFETIME_MS,
	REFRESH_AHEAD_MS,
} from "./constants";
import { nativeFetch } from "./fetch";

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

/**
 * Validate a stored Cursor credential. Two shapes are supported:
 * - `{type:"oauth", access, refresh, expires}` from the browser PKCE flow;
 * - `{type:"api-key", apiKey, access, refresh, expires}` from the API key
 *   exchange. The api-key `refresh` token is never used for renewal — a fresh
 *   exchange with the stored `apiKey` is that shape's only refresh path;
 * - `{type:"token", access, refresh, expires}` from a pasted access token.
 *   `crsr_*` secrets stay on the api-key path; everything else is stored as-is.
 */
function assertCursorCredential(value) {
	if (value === undefined) return undefined;
	if (
		value === null ||
		typeof value !== "object" ||
		(value.type !== "oauth" && value.type !== "api-key" && value.type !== "token") ||
		typeof value.access !== "string" ||
		value.access.length === 0 ||
		typeof value.refresh !== "string" ||
		typeof value.expires !== "number" ||
		!Number.isFinite(value.expires)
	) {
		throw new Error("Cursor credential store received a malformed Cursor credential");
	}
	if (value.type === "api-key" && (typeof value.apiKey !== "string" || value.apiKey.length === 0)) {
		throw new Error("Cursor credential store received a malformed Cursor credential");
	}
	return clone(value);
}

function parseCursorCredential(raw) {
	try {
		return assertCursorCredential(JSON.parse(raw));
	} catch (error) {
		if (error?.message === "Cursor credential store received a malformed Cursor credential") throw error;
		throw new Error("Cursor credential store contains malformed Cursor JSON", { cause: error });
	}
}

/**
 * Adapt DSH's managed string credential service to Cursor's typed OAuth
 * credential. Write operations are serialized so an older refresh response
 * cannot overwrite a newer rotated token.
 */
export class CursorCredentialStore {
	#chain = Promise.resolve();
	credentials: any;
	ref: any;

	constructor(credentials, ref) {
		if (credentials === undefined || credentials === null) {
			throw new Error("Cursor auth requires the DSH credentials service");
		}
		this.credentials = credentials;
		this.ref = ref;
	}

	#enqueue(operation) {
		const current = this.#chain.catch(() => undefined).then(operation);
		const tail = current.catch(() => undefined);
		this.#chain = tail;
		return current;
	}

	async read() {
		const hit = await this.credentials.resolve(this.ref);
		if (hit?.value === undefined || hit.value === "") return undefined;
		return parseCursorCredential(hit.value);
	}

	async write(credential) {
		const validated = assertCursorCredential(credential);
		if (validated === undefined) throw new Error("Cursor credential store cannot write an empty credential");
		await this.credentials.set(this.ref, JSON.stringify(validated));
		return clone(validated);
	}

	modify(update) {
		return this.#enqueue(async () => {
			const current = await this.read();
			const next = await update(clone(current));
			if (next === undefined) return current;
			return this.write(next);
		});
	}

	async clear() {
		await this.#enqueue(async () => {
			await this.credentials.unset(this.ref);
		});
	}
}
//#endregion

//#region token helpers
/**
 * Extract a JWT expiry (ms epoch) with a safety margin.
 * Falls back to a default lifetime when the token cannot be parsed.
 */
export function classifyCursorSecret(value) {
	const raw = typeof value === "string" ? value.trim() : "";
	if (raw.length === 0) return undefined;
	return /^crsr_/i.test(raw) ? "api-key" : "token";
}

/** JWT `exp` in ms, or undefined when the value is not a JWT with exp. */
export function readJwtExpiry(token) {
	if (typeof token !== "string") return undefined;
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return undefined;
	try {
		const decoded = JSON.parse(
			Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
		);
		if (decoded && typeof decoded === "object" && typeof decoded.exp === "number") {
			return decoded.exp * 1000;
		}
	} catch {}
	return undefined;
}

export function getTokenExpiry(token, now = Date.now) {
	return readJwtExpiry(token) ?? now() + DEFAULT_TOKEN_LIFETIME_MS;
}

function statusExpiresAt(current) {
	if (current.type === "token") {
		const exp = readJwtExpiry(current.access);
		return exp === undefined ? {} : { expiresAt: exp };
	}
	return { expiresAt: current.expires };
}

/** Mask an API key for display in the settings page (first 7 + last 2). */
export function maskApiKey(value) {
	if (typeof value !== "string" || value.length === 0) return undefined;
	if (value.length <= 10) return `${value.slice(0, 2)}…${value.slice(-1)}`;
	return `${value.slice(0, 7)}…${value.slice(-2)}`;
}

//#endregion

//#region pkce
async function generatePkce() {
	const verifierBytes = new Uint8Array(96);
	globalThis.crypto.getRandomValues(verifierBytes);
	const verifier = Buffer.from(verifierBytes).toString("base64url");
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	const challenge = Buffer.from(digest).toString("base64url");
	return { verifier, challenge };
}

/** Build the browser login URL for the PKCE flow. */
export function buildLoginUrl({ challenge, uuid }: any) {
	const params = new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" });
	return `${CURSOR_LOGIN_URL}?${params.toString()}`;
}
//#endregion

//#region external url
/** Validate the only external origin this plugin may launch. */
export function assertCursorAuthUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Cursor auth URL is invalid");
	}
	if (url.protocol !== "https:") throw new Error("Cursor auth URL must use HTTPS");
	if (url.origin !== CURSOR_AUTH_ORIGIN || url.username !== "" || url.password !== "") {
		throw new Error("Cursor auth URL must use the cursor.com origin");
	}
	return url.href;
}

/** Return a shell-free native opener command for the current desktop. */
export function commandForCursorAuthUrl(value, platform = process.platform) {
	const url = assertCursorAuthUrl(value);
	if (platform === "win32") return { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url], shell: false };
	if (platform === "darwin") return { file: "open", args: [url], shell: false };
	if (platform === "linux") return { file: "xdg-open", args: [url], shell: false };
	throw new Error(`Cursor auth URL opener is unsupported on ${platform}`);
}

export function openCursorAuthUrl(value, options: any = {}) {
	const command = commandForCursorAuthUrl(value, options.platform);
	const spawnProcess = options.spawn ?? spawn;
	return new Promise<void>((resolve, reject) => {
		const child = spawnProcess(command.file, command.args, {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			shell: command.shell,
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
//#endregion

//#region auth service
/**
 * Owns the Cursor credential lifecycle: PKCE browser login, API key exchange
 * login, refresh, and status. Tokens live in the DSH credential store; the
 * browser client only ever sees `{ authenticated, provider, type, method,
 * apiKeyLabel, expiresAt }` — the raw API key and tokens never leave the host.
 */
export class CursorAuthService {
	store: any;
	fetch: typeof nativeFetch | ((...args: any[]) => any);
	now: () => number;
	logger: any;
	resolveBaseUrl: () => string;

	constructor(store, options: any = {}) {
		this.store = store;
		this.fetch = options.fetch ?? nativeFetch;
		this.now = options.now ?? Date.now;
		this.logger = options.logger;
		this.resolveBaseUrl = options.resolveBaseUrl
			?? (() => options.baseUrl ?? CURSOR_BASE_URL);
	}

	#apiUrl(path) {
		return `${this.resolveBaseUrl()}${path}`;
	}

	#log(level, message, ...args) {
		try {
			this.logger?.[level]?.(`cursor-agent: ${message}`, ...args);
		} catch {}
	}

	async status({ signal }: any = {}) {
		signal?.throwIfAborted();
		const current = await this.store.read();
		if (current === undefined) return { authenticated: false, provider: PROVIDER };
		return {
			authenticated: true,
			provider: PROVIDER,
			type: current.type,
			method: current.type,
			...current.type === "api-key" ? { apiKeyLabel: maskApiKey(current.apiKey) } : {},
			...current.type === "token" ? { tokenLabel: maskApiKey(current.access) } : {},
			...statusExpiresAt(current),
		};
	}

	/**
	 * Resolve a usable access token, refreshing first when the stored token is
	 * missing, expired, or about to expire.
	 * @returns {Promise<string>} the bearer token.
	 */
	async accessToken({ signal } : any = {}) {
		const credential = await this.credential({ signal });
		return credential.access;
	}

	/**
	 * Resolve the stored credential, refreshing first when its token is
	 * missing, expired, or about to expire.
	 * @returns {Promise<{access: string, refresh: string, expires: number}>}
	 */
	async credential({ signal } : any = {}) {
		signal?.throwIfAborted();
		const current = await this.store.read();
		if (current === undefined) {
			throw new LlmError("Cursor Agent is not signed in", "MISSING_CREDENTIAL");
		}
		if (current.type === "token") return current;
		if (current.expires - this.now() > REFRESH_AHEAD_MS) return current;
		const refreshed = await this.refresh(current, { signal });
		return refreshed;
	}

	/**
	 * Exchange a bearer credential (a refresh token or a Cursor API key) for a
	 * fresh access token through `/auth/exchange_user_api_key`. The API key
	 * path additionally sends `local-cli-mode`, which Cursor requires there.
	 * @returns {Promise<{accessToken: string, refreshToken?: string}>}
	 */
	async #exchange(bearer, { localCliMode = false, signal } : any = {}) {
		const response = await this.fetch(`${this.#apiUrl(CURSOR_REFRESH_PATH)}`, {
			method: "POST",
			redirect: "error",
			headers: {
				authorization: `Bearer ${bearer}`,
				"content-type": "application/json",
				accept: "application/json",
				"user-agent": "dsh-cursor-agent/0.1.0",
				...localCliMode ? { "local-cli-mode": "true" } : {},
			},
			body: "{}",
			signal,
		});
		if (!response.ok) {
			this.#log("warn", "token exchange failed (HTTP %s)", response.status);
			if (response.status === 401 || response.status === 403) {
				throw new LlmError("Cursor sign-in needs to be renewed", "INVALID_CREDENTIAL");
			}
			throw new LlmError(`Cursor token exchange failed (HTTP ${response.status})`, "AUTH_FAILED");
		}
		let data;
		try {
			data = await response.json();
		} catch (error) {
			throw new LlmError("Cursor returned an unreadable token response", "AUTH_FAILED", { cause: error });
		}
		if (typeof data?.accessToken !== "string" || data.accessToken.length === 0) {
			throw new LlmError("Cursor sign-in needs to be renewed", "INVALID_CREDENTIAL");
		}
		return {
			accessToken: data.accessToken,
			refreshToken: typeof data.refreshToken === "string" ? data.refreshToken : undefined,
		};
	}

	async refresh(current, { signal } : any = {}) {
		if (current.type === "token") {
			throw new LlmError("Cursor sign-in needs to be renewed", "INVALID_CREDENTIAL");
		}
		if (current.type === "api-key") {
			// The refresh token Cursor returns for an API key exchange cannot be
			// renewed itself: refresh means exchanging the API key again.
			const tokens = await this.#exchange(current.apiKey, { localCliMode: true, signal });
			const next = {
				type: "api-key",
				apiKey: current.apiKey,
				access: tokens.accessToken,
				refresh: tokens.refreshToken ?? "",
				expires: getTokenExpiry(tokens.accessToken, this.now),
			};
			const stored = await this.store.modify((latest) => {
				// Only rotate when the stored credential is still the same key.
				if (latest === undefined || latest.apiKey !== current.apiKey) return latest;
				return next;
			});
			return stored ?? next;
		}
		const tokens = await this.#exchange(current.refresh, { signal });
		const next = {
			type: "oauth",
			access: tokens.accessToken,
			refresh: typeof tokens.refreshToken === "string" && tokens.refreshToken.length > 0 ? tokens.refreshToken : current.refresh,
			expires: getTokenExpiry(tokens.accessToken, this.now),
		};
		const stored = await this.store.modify((latest) => {
			// Only rotate when the stored credential is still the one we refreshed.
			if (latest === undefined || latest.refresh !== current.refresh) return latest;
			return next;
		});
		return stored ?? next;
	}

	/** Paste box: `crsr_*` exchanges as an API key; anything else is stored as an access token. */
	async loginWithSecret(secret, { signal } : any = {}) {
		const kind = classifyCursorSecret(secret);
		if (kind === "api-key") return this.loginWithApiKey(secret, { signal });
		if (kind === "token") return this.loginWithAccessToken(secret, { signal });
		throw new LlmError("Cursor API key or auth token is required", "INVALID_CREDENTIAL");
	}

	/** Store a pasted access token as-is. JWT `exp` becomes the displayed expiry. */
	async loginWithAccessToken(token, { signal } : any = {}) {
		signal?.throwIfAborted();
		if (typeof token !== "string" || token.trim().length === 0) {
			throw new LlmError("Cursor auth token is required", "INVALID_CREDENTIAL");
		}
		const access = token.trim();
		const jwtExp = readJwtExpiry(access);
		await this.store.modify(() => ({
			type: "token",
			access,
			refresh: "",
			expires: jwtExp ?? Number.MAX_SAFE_INTEGER,
		}));
		return this.status({ signal });
	}

	/** Sign in with a Cursor API key: one exchange, no browser flow. */
	async loginWithApiKey(apiKey, { signal } : any = {}) {
		signal?.throwIfAborted();
		if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
			throw new LlmError("Cursor API key is required", "INVALID_CREDENTIAL");
		}
		const key = apiKey.trim();
		let tokens;
		try {
			tokens = await this.#exchange(key, { localCliMode: true, signal });
		} catch (error) {
			if (error instanceof LlmError && error.code === "INVALID_CREDENTIAL") {
				throw new LlmError("Cursor API key is invalid", "INVALID_CREDENTIAL", { cause: error });
			}
			throw error;
		}
		await this.store.modify(() => ({
			type: "api-key",
			apiKey: key,
			access: tokens.accessToken,
			refresh: tokens.refreshToken ?? "",
			expires: getTokenExpiry(tokens.accessToken, this.now),
		}));
		return this.status({ signal });
	}

	/** Start a login and resolve once the browser flow completes. */
	async login({ interaction, signal }) {
		signal?.throwIfAborted();
		const { verifier, challenge } = await generatePkce();
		const uuid = randomUUID();
		const loginUrl = buildLoginUrl({ challenge, uuid });

		interaction.notify?.({
			type: "auth_url",
			url: assertCursorAuthUrl(loginUrl),
			instructions: "在浏览器中登录 Cursor 并授权后，此页面会自动完成登录。",
		});
		interaction.prompt?.({ type: "text", message: "等待浏览器登录完成…" }).catch(() => {});
		interaction.signal?.throwIfAborted();

		let delay = 1000;
		for (let attempt = 0; attempt < 150; attempt++) {
			await sleep(delay);
			signal?.throwIfAborted();
			interaction.signal?.throwIfAborted();
			let response;
			try {
				response = await this.fetch(`${this.#apiUrl(CURSOR_POLL_PATH)}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`, {
					redirect: "error",
					headers: { accept: "application/json", "user-agent": "dsh-cursor-agent/0.1.0" },
					signal,
				});
			} catch (error) {
				this.#log("warn", "login poll request failed on attempt %d: %s", attempt, error?.cause?.code ?? error?.message);
				throw new LlmError("Cursor login poll request failed", "AUTH_FAILED", { cause: error });
			}
			if (response.status === 404) {
				delay = Math.min(delay * 1.2, 10000);
				continue;
			}
			if (!response.ok) {
				this.#log("warn", "login poll returned HTTP %s on attempt %d", response.status, attempt);
				throw new LlmError(`Cursor login poll failed (HTTP ${response.status})`, "AUTH_FAILED");
			}
			const text = await response.text().catch(() => "");
			this.#log("info", "login poll succeeded after %d attempts", attempt);
			let data;
			try {
				data = JSON.parse(text);
			} catch (error) {
				this.#log("warn", "login poll returned unreadable JSON: %s", text.slice(0, 200));
				throw new LlmError("Cursor login returned an unreadable response", "AUTH_FAILED", { cause: error });
			}
			if (typeof data?.accessToken !== "string" || data.accessToken.length === 0) {
				this.#log("warn", "login poll response had no accessToken");
				throw new LlmError("Cursor login returned no access token", "AUTH_FAILED");
			}
			const credential = {
				type: "oauth",
				access: data.accessToken,
				refresh: typeof data.refreshToken === "string" && data.refreshToken.length > 0 ? data.refreshToken : "",
				expires: getTokenExpiry(data.accessToken, this.now),
			};
			try {
				await this.store.modify(() => credential);
			} catch (error) {
				this.#log("error", "failed to store Cursor credential: %s", error?.message);
				throw new LlmError("Cursor login could not store the credential", "AUTH_FAILED", { cause: error });
			}
			return;
		}
		this.#log("warn", "login timed out after 150 poll attempts");
		throw new LlmError("Cursor login timed out", "AUTH_FAILED");
	}

	async logout({ signal } : any = {}) {
		signal?.throwIfAborted();
		await this.store.clear();
		return this.status({ signal });
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
//#endregion

//#region login coordinator
const TERMINAL_PHASES = new Set(["authenticated", "failed", "cancelled"]);
const publicClone = (value) => structuredClone(value);
const asObject = (value) => (value !== null && typeof value === "object" ? value : {});
const ok = (value) => ({ ok: true, value });
const badRequest = (message) => ({ ok: false, error: { code: "bad-request", message, details: { issues: [] } } });

const deferred = () => {
	let resolve;
	let reject;
	return {
		promise: new Promise((onResolve, onReject) => {
			resolve = onResolve;
			reject = onReject;
		}),
		resolve,
		reject,
	};
};

/** Own one host-side login without exposing tokens to the browser client. */
export class CursorLoginCoordinator {
	#sessions = new Map();
	#activeId;

	auth: any;
	createId: any;
	logger: any;

	constructor(auth, options: any = {}) {
		this.auth = auth;
		this.createId = options.createId ?? (() => randomUUID());
		this.logger = options.logger;
	}

	#log(level, message, ...args) {
		try {
			this.logger?.[level]?.(`cursor-agent: ${message}`, ...args);
		} catch {}
	}

	async accountStatus(options) {
		return publicClone(await this.auth.status(options));
	}

	async start() {
		const active = this.#activeId === undefined ? undefined : this.#sessions.get(this.#activeId);
		if (active !== undefined && !TERMINAL_PHASES.has(active.view.phase)) {
			throw new Error("a Cursor login is already active");
		}
		if (active !== undefined) this.#sessions.delete(active.view.id);
		const id = this.createId();
		const ready = deferred();
		const controller = new AbortController();
		const session: any = {
			controller,
			ready,
			view: { id, provider: PROVIDER, method: "browser", phase: "starting", authenticated: false },
		};
		this.#sessions.set(id, session);
		this.#activeId = id;
		const publishReady = () => ready.resolve(this.read(id));
		const interaction = {
			signal: controller.signal,
			prompt: async (prompt) => {
				controller.signal.throwIfAborted();
				const answer = deferred();
				session.prompt = answer;
				session.view = { ...session.view, phase: "waiting_input", prompt: publicPrompt(prompt) };
				const abortPrompt = () => answer.reject(controller.signal.reason ?? new Error("login cancelled"));
				controller.signal.addEventListener("abort", abortPrompt, { once: true });
				prompt.signal?.addEventListener("abort", abortPrompt, { once: true });
				publishReady();
				try {
					return await answer.promise;
				} finally {
					controller.signal.removeEventListener("abort", abortPrompt);
					prompt.signal?.removeEventListener("abort", abortPrompt);
					if (session.prompt === answer) session.prompt = undefined;
				}
			},
			notify: (event) => {
				if (controller.signal.aborted) return;
				if (event.type === "auth_url") {
					session.view = {
						...session.view,
						phase: "waiting_browser",
						authUrl: assertCursorAuthUrl(event.url),
						...typeof event.instructions === "string" ? { instructions: event.instructions } : {},
					};
				} else {
					session.view = { ...session.view, message: String(event.message ?? "") };
				}
				publishReady();
			},
		};
		session.run = Promise.resolve()
			.then(() => this.auth.login({ interaction, signal: controller.signal }))
			.then(async () => {
				if (controller.signal.aborted) return;
				const status = await this.auth.status();
				session.view = {
					id,
					provider: PROVIDER,
					method: "browser",
					phase: "authenticated",
					authenticated: status.authenticated === true,
					...typeof status.expiresAt === "number" ? { expiresAt: status.expiresAt } : {},
				};
			})
			.catch((error) => {
				if (controller.signal.aborted) {
					session.view = { id, provider: PROVIDER, method: "browser", phase: "cancelled", authenticated: false };
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				this.#log("warn", "login failed: %s", message);
				session.view = {
					id,
					provider: PROVIDER,
					method: "browser",
					phase: "failed",
					authenticated: false,
					error: "Cursor login failed",
					...(message ? { detail: message.slice(0, 500) } : {}),
				};
				session.hostError = error;
			})
			.finally(publishReady);
		return ready.promise;
	}

	read(id) {
		const session = this.#sessions.get(id);
		if (session === undefined) throw new Error("unknown Cursor login");
		return publicClone(session.view);
	}

	async cancel(id) {
		const session = this.#sessions.get(id);
		if (session === undefined) throw new Error("unknown Cursor login");
		if (!TERMINAL_PHASES.has(session.view.phase)) {
			session.view = { id, provider: PROVIDER, method: "browser", phase: "cancelled", authenticated: false };
			session.controller.abort(new Error("Cursor login cancelled"));
		}
		await Promise.resolve(session.run).catch(() => undefined);
		return this.read(id);
	}

	async logout(options) {
		if (this.#activeId !== undefined) {
			const active = this.#sessions.get(this.#activeId);
			if (active !== undefined && !TERMINAL_PHASES.has(active.view.phase)) await this.cancel(active.view.id);
		}
		await this.auth.logout(options);
		return this.accountStatus(options);
	}
}

const publicPrompt = (prompt) => ({
	type: prompt.type,
	message: String(prompt.message ?? ""),
	...typeof prompt.placeholder === "string" ? { placeholder: prompt.placeholder } : {},
});

/** Map the loopback-only DSH Connection channel onto the coordinator. */
export function createCursorRpcHandler(coordinator, options : any = {}) {
	const openExternal = options.openExternal;
	const usageReader = options.usageReader;
	const modelsProvider = options.modelsProvider;
	const settingsController = options.settings;
	const auth = options.auth;
	const publicError = (code, message) => ({ ok: false, error: { code, message, details: { issues: [] } } });
	return async (endpoint, payload, signal) => {
		try {
			signal.throwIfAborted();
			const input = asObject(payload);
			if (endpoint === "settings") return ok(settingsController.read());
			if (endpoint === "settings/update") {
				if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error("invalid Cursor settings revision");
				const patch: any = {};
				for (const key of ["maxToolRounds", "apiBaseUrl", "retryCount", "retryIntervalMs", "retryHttpStatusCodes", "parkedBridgeTimeoutMs"]) {
					if (Object.hasOwn(input, key)) patch[key] = input[key];
				}
				return ok(await settingsController.update(patch, input.revision));
			}
			if (endpoint === "status") return ok(await coordinator.accountStatus({ signal }));
			if (endpoint === "usage") {
				try {
					return ok(await usageReader.read({ force: input.force === true, signal }));
				} catch (error) {
					const known = new Set(["Cursor Agent is not signed in", "Cursor sign-in needs to be renewed"]);
					if (error instanceof Error && known.has(error.message)) return publicError("internal", error.message);
					const raw = error instanceof Error ? error.message : "";
					const http = raw.match(/^HTTP (\d{3})\b/);
					const message = http ? `Could not read Cursor usage (HTTP ${http[1]})` : `Could not read Cursor usage: ${raw}`;
					return publicError("internal", message);
				}
			}
			if (endpoint === "models") {
				try {
					return ok({
						models: await modelsProvider.listModelsForRpc({ force: input.force === true, signal }),
						fetchedAt: Date.now(),
					});
				} catch (error) {
					return publicError("internal", error instanceof Error ? error.message : "Could not list Cursor models");
				}
			}
			if (endpoint === "login/start") {
				const started = await coordinator.start();
				if (input.openExternal !== true) return ok(started);
				const url = started.authUrl;
				if (typeof url !== "string" || openExternal === undefined) return ok({ ...started, externalOpened: false });
				try {
					await openExternal(url);
					return ok({ ...started, externalOpened: true });
				} catch {
					return ok({ ...started, externalOpened: false });
				}
			}
			if (endpoint === "login/status") return ok(coordinator.read(input.id));
			if (endpoint === "login/cancel") return ok(await coordinator.cancel(input.id));
			if (endpoint === "login/apikey") {
				// Host-owned exchange; the raw secret is never echoed or logged.
				const secret = typeof input.apiKey === "string" ? input.apiKey
					: typeof input.token === "string" ? input.token
						: "";
				if (secret.trim() === "") {
					return badRequest("Cursor API key or auth token is required");
				}
				const status = await auth.loginWithSecret(secret, { signal });
				usageReader?.clear();
				return ok(status);
			}
			if (endpoint === "logout") {
				const result = await coordinator.logout({ signal });
				usageReader?.clear();
				return ok(result);
			}
			return badRequest(`unknown Cursor auth endpoint: ${endpoint}`);
		} catch (error) {
			if (signal.aborted) throw error;
			const message = error instanceof Error && /^(unknown|unsupported|a Cursor|Cursor login|Cursor auth URL|Cursor API key)/.test(error.message)
				? error.message
				: "Cursor request failed";
			return badRequest(message);
		}
	};
}

const CURSOR_RPC_MAX_BODY_BYTES = 1_048_576;

/**
 * HTTP adapter for the `/cursor-agent/*` Connection channel. Beta
 * `rpc.handle` still binds `owner.webServer` through the caller fiber; if
 * that prefix never lands, frontend-static answers POST with 405. Mounting
 * the route on the injected `webServer` keeps the settings page on the
 * same envelope the browser already posts.
 */
export function createCursorRpcHttpHandler(handler, { requestRejection } : any = {}) {
	return async (req, res) => {
		const rejection = typeof requestRejection === "function" ? requestRejection(req) : undefined;
		if (rejection !== undefined) {
			res.writeHead(rejection);
			res.end(rejection === 401 ? "unauthorized" : "forbidden");
			return;
		}
		if ((req.method ?? "GET") !== "POST") {
			res.writeHead(405, { allow: "POST" });
			res.end("method not allowed");
			return;
		}
		const mediaType = String(req.headers?.["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
		if (mediaType !== "application/json") {
			res.writeHead(415);
			res.end("content type must be application/json");
			return;
		}
		let raw;
		try {
			raw = await readCursorRpcBody(req, CURSOR_RPC_MAX_BODY_BYTES);
		} catch (error) {
			const status = error instanceof Error && error.message === "payload-too-large" ? 413 : 400;
			if (status === 413) res.writeHead(413, { connection: "close" });
			else res.writeHead(400);
			res.end(status === 413 ? "" : "body is not readable");
			return;
		}
		let envelope;
		try {
			envelope = JSON.parse(raw.length === 0 ? "{}" : raw.toString("utf8"));
		} catch {
			res.writeHead(400);
			res.end("body is not JSON");
			return;
		}
		const rpcId = typeof envelope?.rpcId === "string" ? envelope.rpcId : "invalid-request";
		const pathname = String(req.url ?? "/").split("?")[0];
		const prefix = `${CHANNEL}/`;
		const endpoint = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
		if (envelope?.type !== "client-request" || envelope.method !== endpoint || endpoint.length === 0) {
			writeCursorRpcJson(res, rpcId, {
				ok: false,
				error: { code: "gateway/bad-request", message: "invalid client-request message", details: { issues: [] } },
			});
			return;
		}
		const abort = new AbortController();
		res.on?.("close", () => {
			if (!res.writableEnded) abort.abort();
		});
		try {
			writeCursorRpcJson(res, rpcId, await handler(endpoint, envelope.payload, abort.signal));
		} catch (error) {
			res.writeHead(500);
			res.end(`handler failure: ${String(error)}`);
		}
	};
}

function writeCursorRpcJson(res, rpcId, result) {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ type: "server-response", rpcId, result }));
}

async function readCursorRpcBody(req, maxBytes) {
	if (typeof req[Symbol.asyncIterator] !== "function") {
		if (Buffer.isBuffer(req.body)) return req.body;
		if (typeof req.body === "string") return Buffer.from(req.body);
		throw new Error("unreadable");
	}
	const declared = req.headers?.["content-length"];
	if (declared !== undefined && Number(declared) > maxBytes) {
		req.destroy?.();
		throw new Error("payload-too-large");
	}
	const chunks = [];
	let received = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		received += buffer.byteLength;
		if (received > maxBytes) {
			req.destroy?.();
			throw new Error("payload-too-large");
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}
//#endregion
