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
import { encodeValue, decodeValue, Reader, Writer } from "../proto";
import {
	catalogFromAvailableModels,
	decodeAvailableModels,
	encodeAvailableModelsRequest,
	encodeRequestedModel,
	FALLBACK_CONTEXT_WINDOW,
	inputModalitiesFromCatalog,
	reasoningFromCatalogEntry,
	resolveCursorModelSelection,
} from "../models";
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
} from "../exec-plane";
import {
	failCursorJoin,
	openCursorJoin,
	settleCursorJoin,
} from "../joins";
import { registerCursorShims } from "../shims";
import { collectCursorRules, encodeCursorRule, mergeDshSystemRule } from "../rules";
import {
	collectImageBlocks,
	contentHasImages,
	encodeSelectedContext,
	formatImageReadJoinText,
	resolveSelectedImages,
} from "../images";
import { CHECKPOINT_OBJECTS_SEGMENTS, createCheckpointStore, createLocalObjectStore } from "../checkpoint-store";
import {
	CURSOR_CHECKPOINT_SCHEMA_VERSION,
	appendCursorCheckpointEvent,
	listCursorCheckpointEvents,
	pickCursorCheckpointEvent,
} from "../checkpoint-log";
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
} from "../compaction";

export function splitShellDelta(delta) {
	const parts = String(delta ?? "").split("\n[stderr]\n");
	return { stdout: parts.shift() ?? "", stderr: parts.join("\n[stderr]\n") };
}

/** Marker prefix of the NSpid probe line the background prologue echoes. */
export const BACKGROUND_PID_MARKER = "CURSOR_BG_PID=";

/**
 * Prologue prepended to commands that may run in the background: it echoes the
 * process's OUTER-namespace pid (NSpid's first field — the host pid under
 * bwrap, the process's own pid under landlock/unconfined execution) as one
 * marker line. The bridge parses and strips it; the model receives the pid
 * through the protocol's pid fields.
 *
 * The probe MUST read /proc/$$/status (the background bash itself), never
 * /proc/self/status: inside the $(...) command substitution `self` is the
 * transient awk process, whose pid dies with the echo — the model would kill
 * a pid that no longer exists.
 */
export const BACKGROUND_PID_PROLOGUE = 'echo "CURSOR_BG_PID=$(awk \'/^NSpid:/ {print $2}\' /proc/$$/status)"';

/**
 * Stateful marker-line stripper for one ShellProcess output stream. Feed every
 * output delta; it returns the pid (once parsed) and the delta with the marker
 * line removed. Deltas may split the marker anywhere; unrelated leading output
 * disables the probe permanently and passes everything through.
 */
export function createPidProbe() {
	let buf = "";
	let resolved = false;
	let failed = false;
	const consume = (delta) => {
		if (resolved || failed) return { pid: undefined, rest: String(delta ?? "") };
		const text = String(delta ?? "");
		if (text.length === 0) return { pid: undefined, rest: "" };
		buf += text;
		const newline = buf.indexOf("\n");
		if (buf.startsWith(BACKGROUND_PID_MARKER) && newline !== -1) {
			const raw = buf.slice(BACKGROUND_PID_MARKER.length, newline).trim();
			const rest = buf.slice(newline + 1);
			buf = "";
			resolved = true;
			const pid = /^\d+$/.test(raw) ? Number(raw) : undefined;
			return { pid, rest };
		}
		if (BACKGROUND_PID_MARKER.startsWith(buf) || (buf.startsWith(BACKGROUND_PID_MARKER) && newline === -1)) {
			return { pid: undefined, rest: "" };
		}
		failed = true;
		const rest = buf;
		buf = "";
		return { pid: undefined, rest };
	};
	return { consume };
}

/**
 * Extract the numeric suffix of a registry-issued bash job id (`bash-7` → 7).
 * The registry contract (`@deepseek-ai/dsh-jobs/brand`) generates `<kind>-N`;
 * `undefined` for any other shape — the caller falls back to its own counter.
 */
/**
 * Cursor agent terminal files (`~/.cursor/projects/<workspace>/terminals/<id>.txt`)
 * keep `running_for_ms` left-aligned in a 9-character field so the header can
 * be patched in place every 5s without rewriting the body.
 */
const CURSOR_TERMINAL_RUNNING_FOR_WIDTH = 9;
const CURSOR_TERMINAL_RUNNING_FOR_KEY = "running_for_ms: ";

function yamlQuoted(value) {
	return JSON.stringify(String(value ?? ""));
}

function padRunningForMs(ms) {
	return String(Math.max(0, Math.trunc(ms) || 0)).padEnd(CURSOR_TERMINAL_RUNNING_FOR_WIDTH);
}

function countTextLines(text) {
	if (text.length === 0) return 0;
	const endsWithNl = text.endsWith("\n");
	const parts = text.split(/\r?\n/);
	return endsWithNl ? parts.length - 1 : parts.length;
}

/**
 * YAML front matter Cursor writes at the top of each agent terminal file.
 * Matches the local Cursor project terminals/*.txt samples:
 * pid, quoted cwd/command/title, status, started_at, padded running_for_ms.
 */
export function formatCursorTerminalHeader({
	pid = -1,
	cwd = "",
	command = "",
	title,
	status = "running",
	startedAt,
	runningForMs = 0,
}: any) {
	const lines = [
		"---",
		`pid: ${Number.isSafeInteger(pid) ? pid : -1}`,
		`cwd: ${yamlQuoted(cwd)}`,
		`command: ${yamlQuoted(command)}`,
	];
	if (typeof title === "string" && title.length > 0) lines.push(`title: ${yamlQuoted(title)}`);
	lines.push(`status: ${status}`);
	lines.push(`started_at: ${startedAt}`);
	lines.push(`running_for_ms: ${padRunningForMs(runningForMs)}`);
	lines.push("---");
	return `${lines.join("\n")}\n`;
}

/** Trailer Cursor appends after the body once the command settles. */
export function formatCursorTerminalFooter({ exitCode, elapsedMs, endedAt }: any) {
	return `\n---\nexit_code: ${exitCode}\nelapsed_ms: ${elapsedMs}\nended_at: ${endedAt}\n---\n`;
}

/**
 * One Cursor-format terminal file: header, append-only body, footer on settle.
 * `running_for_ms` is patched in place every 5s while the command is live.
 */
export function createCursorTerminalLog(filePath, initial : any = {}) {
	const startedAtMs = Number.isFinite(initial.startedAtMs) ? initial.startedAtMs : Date.now();
	const meta = {
		pid: Number.isSafeInteger(initial.pid) && initial.pid > 0 ? initial.pid : -1,
		cwd: initial.cwd ?? "",
		command: initial.command ?? "",
		title: initial.title,
		status: initial.status ?? "running",
		startedAt: initial.startedAt ?? new Date(startedAtMs).toISOString(),
		startedAtMs,
		runningForMs: 0,
	};
	let body = "";
	let footer = "";
	let header = "";
	let finished = false;

	const snapshot = () => header + body + footer;
	const stats = () => {
		const text = snapshot();
		return { filePath, sizeBytes: Buffer.byteLength(text), lineCount: countTextLines(text) };
	};

	const writeAll = () => {
		mkdirSync(dirname(filePath), { recursive: true });
		header = formatCursorTerminalHeader(meta);
		writeFileSync(filePath, snapshot());
	};

	const patchRunningFor = (now = Date.now()) => {
		if (finished || header.length === 0) return;
		const next = Math.max(0, now - meta.startedAtMs);
		const padded = padRunningForMs(next);
		if (padded.length > CURSOR_TERMINAL_RUNNING_FOR_WIDTH) {
			meta.runningForMs = next;
			try {
				writeAll();
			} catch {}
			return;
		}
		const idx = header.indexOf(CURSOR_TERMINAL_RUNNING_FOR_KEY);
		if (idx < 0) return;
		meta.runningForMs = next;
		const offset = idx + CURSOR_TERMINAL_RUNNING_FOR_KEY.length;
		try {
			const fd = openSync(filePath, "r+");
			try {
				writeSync(fd, padded, offset);
			} finally {
				closeSync(fd);
			}
			header = formatCursorTerminalHeader(meta);
		} catch {
			try {
				writeAll();
			} catch {}
		}
	};

	try {
		writeAll();
	} catch {
		// monitoring aid; never fail the shell over the file
	}

	const ticker = setInterval(() => patchRunningFor(), 5000);
	ticker.unref?.();

	return {
		filePath,
		get bytes() {
			return Buffer.byteLength(body);
		},
		stats,
		append(text) {
			if (finished || text == null || text.length === 0) return;
			body += text;
			try {
				appendFileSync(filePath, text);
			} catch {}
		},
		setPid(pid) {
			if (finished || !Number.isSafeInteger(pid) || pid <= 0 || meta.pid === pid) return;
			meta.pid = pid;
			meta.runningForMs = Math.max(0, Date.now() - meta.startedAtMs);
			try {
				writeAll();
			} catch {}
		},
		finish({ exitCode = 1, aborted = false, now = Date.now() } : any = {}) {
			if (finished) return;
			finished = true;
			clearInterval(ticker);
			const elapsed = Math.max(0, now - meta.startedAtMs);
			meta.runningForMs = elapsed;
			meta.status = aborted !== true && exitCode === 0 ? "succeeded" : "failed";
			footer = formatCursorTerminalFooter({
				exitCode: exitCode ?? 1,
				elapsedMs: elapsed,
				endedAt: new Date(now).toISOString(),
			});
			try {
				writeAll();
			} catch {}
		},
		dispose() {
			clearInterval(ticker);
		},
	};
}

export function parseJobIdN(jobId) {
	const match = /^bash-(\d+)$/.exec(String(jobId ?? ""));
	return match === null ? undefined : Number(match[1]);
}

