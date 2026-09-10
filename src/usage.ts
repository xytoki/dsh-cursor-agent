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
	CURSOR_BASE_URL,
	CURSOR_CLIENT_VERSION,
	CURSOR_GET_CURRENT_PERIOD_USAGE_PATH,
	CURSOR_GET_ME_PATH,
	CURSOR_GET_PLAN_INFO_PATH,
	CURSOR_GET_SAND_USAGE_STATUS_PATH,
	USAGE_TTL_MS,
} from "./constants";
import { nativeFetch } from "./fetch";
import { CONNECT_END_STREAM_FLAG, ConnectFrameReader, frameEncode } from "./wire/frames";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function usageDaysLeft(billingCycleEnd, now) {
	const end = new Date(billingCycleEnd).getTime();
	if (!Number.isFinite(end)) return undefined;
	return Math.max(0, Math.ceil((end - now) / (24 * 60 * 60 * 1000)));
}

function finiteNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

function centsToDollars(cents) {
	const n = finiteNumber(cents);
	return n === undefined ? undefined : Math.round((n / 100) * 100) / 100;
}

function percentValue(value) {
	const n = finiteNumber(value);
	return n === undefined ? undefined : Math.round(n * 10) / 10;
}

const boolish = (value) => (typeof value === "boolean" ? value : undefined);

/** Normalize an epoch (seconds or ms), numeric string, or ISO string to ms. */
function normalizeEpoch(value) {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed === "") return undefined;
		if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
			const iso = new Date(trimmed).getTime();
			return Number.isFinite(iso) ? iso : undefined;
		}
	}
	const n = finiteNumber(value);
	if (n === undefined) return undefined;
	return n < 1e12 ? n * 1000 : n;
}

/** Decode one protobuf message into a flat { fieldNumber: value } map. */
function readMessage(bytes) {
	if (bytes === undefined) return undefined;
	try {
		const reader = new Reader(bytes);
		const fields: any = {};
		while (!reader.done) {
			const { field, wireType } = reader.tag();
			if (wireType === 0) fields[field] = reader.varint();
			else if (wireType === 1) fields[field] = reader.double();
			else if (wireType === 2) fields[field] = reader.bytes();
			else reader.skip(wireType);
		}
		return fields;
	} catch {
		return undefined;
	}
}

function decodeTimestamp(bytes): any {
	const d = readMessage(bytes);
	if (d === undefined) return undefined;
	const seconds = typeof d[1] === "number" ? d[1] : undefined;
	return seconds === undefined ? undefined : seconds * 1000;
}

function textOrUndefined(bytes) {
	if (bytes === undefined) return undefined;
	try {
		return new TextDecoder().decode(bytes);
	} catch {
		return undefined;
	}
}

const numberish = (value) => (typeof value === "number" ? value : undefined);

export function decodeCurrentPeriodUsage(bytes): any {
	const d = readMessage(bytes);
	if (d === undefined) return undefined;
	const planRaw = d[3] === undefined ? undefined : readMessage(d[3]);
	const spendRaw = d[4] === undefined ? undefined : readMessage(d[4]);
	const plan = planRaw === undefined ? undefined : {
		// Authoritative `PlanUsage` schema (aiserver.v1, decompiled):
		// 1-5 cents, 6 remaining_bonus BOOL, 7 tooltip, 8-11 optional
		// auto/api spend+limit (returned for usage-based accounts, omitted
		// for plan accounts), 12-14 server-computed percents.
		totalSpend: numberish(planRaw[1]),
		includedSpend: numberish(planRaw[2]),
		bonusSpend: numberish(planRaw[3]),
		remaining: numberish(planRaw[4]),
		limit: numberish(planRaw[5]),
		remainingBonus: planRaw[6] === undefined ? undefined : numberish(planRaw[6]) !== 0,
		bonusTooltip: textOrUndefined(planRaw[7]),
		autoSpend: numberish(planRaw[8]),
		apiSpend: numberish(planRaw[9]),
		autoLimit: numberish(planRaw[10]),
		apiLimit: numberish(planRaw[11]),
		autoPercentUsed: numberish(planRaw[12]),
		apiPercentUsed: numberish(planRaw[13]),
		totalPercentUsed: numberish(planRaw[14]),
	};
	const spendLimit = spendRaw === undefined ? undefined : {
		totalSpend: numberish(spendRaw[1]),
		pooledLimit: numberish(spendRaw[2]),
		pooledUsed: numberish(spendRaw[3]),
		pooledRemaining: numberish(spendRaw[4]),
		individualLimit: numberish(spendRaw[5]),
		individualUsed: numberish(spendRaw[6]),
		individualRemaining: numberish(spendRaw[7]),
		limitType: textOrUndefined(spendRaw[8]),
		overallLimit: numberish(spendRaw[9]),
		overallUsed: numberish(spendRaw[10]),
		overallRemaining: numberish(spendRaw[11]),
	};
	return {
		billingCycleStart: d[1] === undefined ? undefined : normalizeEpoch(numberish(d[1])),
		billingCycleEnd: d[2] === undefined ? undefined : normalizeEpoch(numberish(d[2])),
		enabled: d[6] === undefined ? undefined : numberish(d[6]) !== 0,
		displayMessage: textOrUndefined(d[7]),
		planUsage: plan,
		spendLimitUsage: spendLimit,
	};
}

/** Decode the `GetSandUsageStatus` (Grok allowance) response. */
export function decodeSandUsageStatus(bytes): any {
	const d = readMessage(bytes);
	if (d === undefined) return undefined;
	const count = d[5];
	return {
		usagePercent: numberish(d[3]),
		currentPeriodStart: d[1] === undefined ? undefined : decodeTimestamp(d[1]),
		nextResetTimestampUtc: d[2] === undefined ? undefined : decodeTimestamp(d[2]),
		includedLimitZero: d[4] === undefined ? undefined : numberish(d[4]) !== 0,
		availableBankedResetCount: count === undefined ? undefined : typeof count === "number" ? String(count) : textOrUndefined(count),
		usesPooledEnterpriseAllowance: d[6] === undefined ? undefined : numberish(d[6]) !== 0,
		hasAvailableUsage: d[7] === undefined ? undefined : numberish(d[7]) !== 0,
		hasNonZeroIncludedLimit: d[8] === undefined ? undefined : numberish(d[8]) !== 0,
	};
}

/** Decode the `GetMe` response down to the account email (field 3). */
export function decodeGetMe(bytes): any {
	const d = readMessage(bytes);
	if (d === undefined) return undefined;
	return { email: textOrUndefined(d[3]) };
}

/** Decode the `GetPlanInfo` response down to `planInfo.planName`. */
export function decodeGetPlanInfo(bytes): any {
	const d = readMessage(bytes);
	if (d === undefined) return undefined;
	const planInfo = d[1] === undefined ? undefined : readMessage(d[1]);
	return { planInfo: planInfo === undefined ? undefined : { planName: textOrUndefined(planInfo[1]) } };
}

/** Project a (JSON or decoded-proto) `GetCurrentPeriodUsage` value. */
export function projectCurrentPeriodUsage(input) {
	if (!record(input)) return undefined;
	const plan = record(input.planUsage) ? input.planUsage : undefined;
	const spendLimit = record(input.spendLimitUsage) ? input.spendLimitUsage : undefined;
	const limitCents = plan === undefined ? undefined : finiteNumber(plan.limit);
	const includedCents = plan === undefined ? undefined : finiteNumber(plan.includedSpend);
	// protojson omits zero-valued fields, so a missing `remaining` usually
	// means the plan is exhausted (remaining = 0 = limit - includedSpend).
	const remainingCents = plan === undefined ? undefined
		: finiteNumber(plan.remaining)
			?? (limitCents !== undefined && includedCents !== undefined ? limitCents - includedCents : undefined);
	return {
		billingCycleStart: normalizeEpoch(input.billingCycleStart),
		billingCycleEnd: normalizeEpoch(input.billingCycleEnd),
		enabled: boolish(input.enabled),
		displayMessage: typeof input.displayMessage === "string" ? input.displayMessage : undefined,
		plan: plan === undefined ? undefined : {
			totalSpend: centsToDollars(plan.totalSpend),
			includedSpend: centsToDollars(plan.includedSpend),
			bonusSpend: centsToDollars(plan.bonusSpend),
			remaining: centsToDollars(remainingCents),
			limit: centsToDollars(plan.limit),
			remainingBonus: boolish(plan.remainingBonus),
			bonusTooltip: typeof plan.bonusTooltip === "string" ? plan.bonusTooltip : undefined,
			autoSpend: centsToDollars(plan.autoSpend),
			apiSpend: centsToDollars(plan.apiSpend),
			autoLimit: centsToDollars(plan.autoLimit),
			apiLimit: centsToDollars(plan.apiLimit),
			autoPercentUsed: percentValue(plan.autoPercentUsed),
			apiPercentUsed: percentValue(plan.apiPercentUsed),
			totalPercentUsed: percentValue(plan.totalPercentUsed),
		},
		spendLimit: spendLimit === undefined ? undefined : {
			individualUsed: centsToDollars(spendLimit.individualUsed),
			individualLimit: centsToDollars(spendLimit.individualLimit),
			individualRemaining: centsToDollars(spendLimit.individualRemaining),
			pooledUsed: centsToDollars(spendLimit.pooledUsed),
			pooledLimit: centsToDollars(spendLimit.pooledLimit),
			pooledRemaining: centsToDollars(spendLimit.pooledRemaining),
			totalSpend: centsToDollars(spendLimit.totalSpend),
			limitType: typeof spendLimit.limitType === "string" ? spendLimit.limitType : undefined,
			overallUsed: centsToDollars(spendLimit.overallUsed),
			overallLimit: centsToDollars(spendLimit.overallLimit),
			overallRemaining: centsToDollars(spendLimit.overallRemaining),
		},
	};
}

/** Project a (JSON or decoded-proto) `GetSandUsageStatus` value. */
export function projectSandUsageStatus(input) {
	if (!record(input)) return undefined;
	const count = input.availableBankedResetCount;
	return {
		usagePercent: percentValue(input.usagePercent),
		currentPeriodStart: normalizeEpoch(input.currentPeriodStart),
		nextReset: normalizeEpoch(input.nextResetTimestampUtc),
		includedLimitZero: boolish(input.includedLimitZero),
		hasAvailableUsage: boolish(input.hasAvailableUsage),
		hasNonZeroIncludedLimit: boolish(input.hasNonZeroIncludedLimit),
		availableBankedResetCount: count === undefined ? undefined : typeof count === "string" ? count : String(count),
		usesPooledEnterpriseAllowance: boolish(input.usesPooledEnterpriseAllowance),
	};
}

/** Project a (JSON or decoded-proto) `GetMe` value. */
export function projectGetMe(input) {
	if (!record(input)) return undefined;
	return { email: typeof input.email === "string" && input.email.length > 0 ? input.email : undefined };
}

/** Project a (JSON or decoded-proto) `GetPlanInfo` value. */
export function projectGetPlanInfo(input) {
	if (!record(input) || !record(input.planInfo)) return undefined;
	return { planName: typeof input.planInfo.planName === "string" && input.planInfo.planName.length > 0 ? input.planInfo.planName : undefined };
}

/**
 * Call one unary `aiserver.v1.DashboardService` RPC over Connect. Tries the
 * JSON encoding first and falls back to protobuf framing on 415/proto
 * responses, mirroring what the reference CLI client does.
 * @returns {Promise<{json?: unknown, bytes?: Uint8Array} | undefined>}
 */
export async function callDashboardRpc(fetchImpl, url, token, options : any = {}) {
	const headers = {
		"connect-protocol-version": "1",
		authorization: `Bearer ${token}`,
		"x-ghost-mode": "true",
		"x-cursor-client-version": CURSOR_CLIENT_VERSION,
		"x-cursor-client-type": "cli",
		"user-agent": "dsh-cursor-agent/0.2.0",
		...options.headers,
	};
	let response = await fetchImpl(url, {
		method: "POST",
		redirect: "error",
		headers: { ...headers, "content-type": "application/json", accept: "application/json" },
		body: "{}",
		signal: options.signal,
	});
	let contentType = typeof response.headers?.get === "function" ? String(response.headers.get("content-type") ?? "") : "";
	if (response.status === 415 || /proto/i.test(contentType)) {
		response = await fetchImpl(url, {
			method: "POST",
			redirect: "error",
			headers: { ...headers, "content-type": "application/proto", accept: "application/proto" },
			body: frameEncode(new Uint8Array(0)),
			signal: options.signal,
		});
		contentType = typeof response.headers?.get === "function" ? String(response.headers.get("content-type") ?? "") : "";
	}
	if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (/json/i.test(contentType)) {
		let text = new TextDecoder().decode(bytes);
		// Tolerate a Connect envelope in front of a JSON payload.
		if (bytes.length >= 5 && !text.trimStart().startsWith("{")) {
			const view = new DataView(bytes.buffer, bytes.byteOffset, 5);
			const length = view.getUint32(1, false);
			if (length <= bytes.length - 5) text = new TextDecoder().decode(bytes.subarray(5, 5 + length));
		}
		if (text.trim() === "") return undefined;
		try {
			return { json: JSON.parse(text) };
		} catch (error) {
			throw new Error(`unreadable JSON from ${url}`, { cause: error });
		}
	}
	try {
		const frames = new ConnectFrameReader();
		frames.push(bytes);
		frames.finish();
		const frame = await frames.next();
		if (frame === undefined || (frame.flags & CONNECT_END_STREAM_FLAG) !== 0) return undefined;
		return { bytes: frame.payload };
	} catch {
		// Last resort: treat the whole body as one raw protobuf message.
		return { bytes };
	}
}

/**
 * Read usage from Cursor's `aiserver.v1.DashboardService` RPCs using the
 * credential's access token (works for both OAuth and API key credentials).
 * The browser receives only the parsed projection; tokens stay host-local.
 * Successful reads are cached for a short TTL.
 */
export class CursorUsageReader {
	auth: any;
	fetch: any;
	now: any;
	ttlMs: any;
	baseUrl: any;
	resolveBaseUrl: any;
	logger: any;

	constructor(auth, options: any = {}) {
		this.auth = auth;
		this.fetch = options.fetch ?? nativeFetch;
		this.now = options.now ?? Date.now;
		this.ttlMs = options.ttlMs ?? USAGE_TTL_MS;
		this.baseUrl = options.baseUrl ?? CURSOR_BASE_URL;
		this.resolveBaseUrl = options.resolveBaseUrl ?? (() => this.baseUrl);
		this.logger = options.logger;
		this.#cache = { at: 0, value: undefined };
	}

	forget() {
		this.#cache = { at: 0, value: undefined };
	}

	#cache;

	#log(level, message, ...args) {
		try {
			this.logger?.[level]?.(`cursor-agent: ${message}`, ...args);
		} catch {}
	}

	#mergeSignals(signal, timeoutMs) {
		const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof AbortSignal.timeout === "function"
			? AbortSignal.timeout(timeoutMs)
			: undefined;
		if (signal === undefined) return timeout;
		if (timeout === undefined) return signal;
		return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
	}

	#rpc(path, token, { signal, timeoutMs } : any = {}) {
		return callDashboardRpc(this.fetch, `${this.resolveBaseUrl()}${path}`, token, {
			signal: this.#mergeSignals(signal, timeoutMs),
		});
	}

	async #tryRpc(path, token, options : any = {}) {
		try {
			return { ok: true, value: await this.#rpc(path, token, options) };
		} catch (error) {
			this.#log("warn", "usage RPC failed: %s", error instanceof Error ? error.message : error);
			return { ok: false, error };
		}
	}

	async read({ force = false, signal } : any = {}) {
		const now = this.now();
		if (!force && this.#cache.value !== undefined && now - this.#cache.at < this.ttlMs) {
			return structuredClone(this.#cache.value);
		}
		const credential = await this.auth.credential({ signal });
		const token = credential.access;

		const [usageResult, planResult, meResult, grokResult] = await Promise.all([
			this.#tryRpc(CURSOR_GET_CURRENT_PERIOD_USAGE_PATH, token, { signal, timeoutMs: 8_000 }),
			this.#tryRpc(CURSOR_GET_PLAN_INFO_PATH, token, { signal, timeoutMs: 8_000 }),
			this.#tryRpc(CURSOR_GET_ME_PATH, token, { signal, timeoutMs: 8_000 }),
			this.#tryRpc(CURSOR_GET_SAND_USAGE_STATUS_PATH, token, { signal, timeoutMs: 8_000 }),
		]);
		if (!usageResult.ok) {
			const failed = usageResult.error;
			throw failed instanceof Error ? failed : new Error("Could not read Cursor usage");
		}

		const rawOf = (result, decode) =>
			result?.value?.json !== undefined ? result.value.json : decode(result?.value?.bytes);
		const usage = projectCurrentPeriodUsage(rawOf(usageResult, decodeCurrentPeriodUsage));
		if (usage === undefined) throw new Error("Cursor usage response was unreadable");
		const me = projectGetMe(meResult.ok ? rawOf(meResult, decodeGetMe) : undefined);
		const planName = projectGetPlanInfo(planResult.ok ? rawOf(planResult, decodeGetPlanInfo) : undefined)?.planName;
		const grokRaw = projectSandUsageStatus(grokResult.ok ? rawOf(grokResult, decodeSandUsageStatus) : undefined);
		// Accounts without a Grok allowance report hasAvailableUsage=false;
		// collapse that to "no Grok card" instead of an explicit none state.
		const grok = grokRaw?.hasAvailableUsage === true ? grokRaw : undefined;

		const value = {
			fetchedAt: now,
			email: me?.email,
			planName,
			enabled: usage.enabled,
			displayMessage: usage.displayMessage,
			billingCycle: usage.billingCycleEnd === undefined ? undefined : {
				start: usage.billingCycleStart,
				end: usage.billingCycleEnd,
				daysLeft: usageDaysLeft(usage.billingCycleEnd, now),
			},
			plan: usage.plan,
			spendLimit: usage.spendLimit,
			grok,
		};
		this.#cache = { at: now, value };
		this.#log("info", "usage read: %s", JSON.stringify({
			email: value.email,
			planName: value.planName,
			apiPercentUsed: value.plan?.apiPercentUsed,
			grokAvailable: value.grok?.hasAvailableUsage,
		}));
		return structuredClone(value);
	}

	clear() {
		this.#cache = { at: 0, value: undefined };
	}
}
