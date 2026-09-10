/**
 * Session-world execution plane for Cursor native exec frames.
 *
 * Runs against the caller agent's `ctx` seams (`fs`, `subprocess`, `shell`,
 * `jobs`, `approval`, `sandboxPolicy`). No DSH tools are registered; the
 * adapter encodes structured results onto the wire and paints cards itself.
 */
import { basename, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import {
	READ_IMAGE_MAX_BYTES,
	binaryUnsupportedReason,
	imageMimeFromPath,
	isNotTextError,
	resizeReadImage,
	sniffImageMime,
} from "./images";

export const SEARCH_TIMEOUT_MS = 30_000;
export const SEARCH_GRACE_MS = 3_000;
export const CURSOR_GREP_MAX_BYTES = 10 * 1024 * 1024;
export const CURSOR_GREP_STDERR_MAX_BYTES = 64 * 1024;
export const CURSOR_GLOB_MAX_FILES = 1000;
export const CURSOR_GLOB_VCS_EXCLUDES = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

const SANDBOX_WIDER_MODES = Object.freeze({
	"read-only": ["workspace-write", "danger-full-access"],
	"workspace-write": ["danger-full-access"],
});

const DSH_MODE_RANK = Object.freeze({
	"read-only": 0,
	"workspace-write": 1,
	"danger-full-access": 2,
});

const CURSOR_SANDBOX_TYPES = Object.freeze({
	UNSPECIFIED: 0,
	INSECURE_NONE: 1,
	WORKSPACE_READWRITE: 2,
	WORKSPACE_READONLY: 3,
});

/** Collect the execution-world seams from a live agent. Missing seams stay undefined. */
export function worldFromAgent(agent) {
	const ctx = agent?.ctx;
	if (ctx === undefined) return { agent };
	return {
		agent,
		ctx,
		fs: ctx.get?.("fs") ?? ctx.fs,
		subprocess: ctx.get?.("subprocess") ?? ctx.subprocess,
		shell: ctx.get?.("shell") ?? ctx.shell,
		jobs: ctx.get?.("jobs") ?? ctx.jobs,
		approval: ctx.get?.("approval") ?? ctx.approval,
		sandboxPolicy: ctx.get?.("sandboxPolicy") ?? ctx.sandboxPolicy,
	};
}

function resolveOptions(agent) {
	const cwd = agent?.session?.header?.cwd;
	return cwd === undefined ? undefined : { cwd };
}

function displayError(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Pre-judged sandbox escalation for atomic write/delete. Cursor's mutation
 * frames have no sandbox fields; the plane stands in for the client's dialog.
 */
export async function escalateSandboxMutation(world, { verb, path, operation, signal, callId }) {
	const policyService = world.sandboxPolicy;
	if (policyService === undefined) return undefined;
	const policy = policyService.resolve(world.agent === undefined ? {} : { session: world.agent.session });
	if (policy.mode === "danger-full-access") return policy;
	if (world.fs === undefined) {
		throw new Error(`cannot ${verb} "${path}": permission denied (no filesystem service is composed)`);
	}
	const roots = [...new Set([policy.workspaceRoot, "/tmp", os.tmpdir()].filter((value) => typeof value === "string" && value.length > 0))];
	let contained = false;
	const target = await world.fs.resolve(path, resolveOptions(world.agent));
	for (const root of roots) {
		try {
			if (await world.fs.contains(await world.fs.resolve(root), target)) {
				contained = true;
				break;
			}
		} catch {
			// a missing root contains nothing
		}
	}
	if (policy.mode === "workspace-write" && contained) return policy;
	const requested = contained ? "workspace-write" : "danger-full-access";
	const wider = SANDBOX_WIDER_MODES[policy.mode] ?? [];
	if (!wider.includes(requested)) {
		throw new Error(`cannot ${verb} "${target.displayPath}": permission denied (no wider sandbox mode is available)`);
	}
	if (world.approval === undefined) {
		throw new Error(`cannot ${verb} "${target.displayPath}": permission denied (no approval service is composed)`);
	}
	if (world.agent === undefined) {
		throw new Error(`cannot ${verb} "${target.displayPath}": permission denied (no owning agent session)`);
	}
	const outcome = await world.approval.request({
		agent: world.agent,
		toolName: `cursor_${verb}`,
		callId,
		reason: `escalate sandbox to ${requested}: ${operation} "${target.displayPath}"`,
		signal,
	});
	if (outcome === "allowed-once") return { ...policy, mode: requested };
	if (outcome === "cancelled") {
		throw new Error(`cannot ${verb} "${target.displayPath}": permission denied (approval was cancelled)`);
	}
	if (outcome === "unavailable") {
		throw new Error(`cannot ${verb} "${target.displayPath}": permission denied (no approval channel is available)`);
	}
	throw new Error(`cannot ${verb} "${target.displayPath}": permission denied (the user rejected the sandbox escalation)`);
}

export function cursorSandboxTypeToMode(requested) {
	const type = Number(requested?.type ?? 0);
	const extras = Array.isArray(requested?.additionalReadwritePaths)
		? requested.additionalReadwritePaths.filter((path) => String(path ?? "").length > 0)
		: [];
	if (extras.length > 0) return "danger-full-access";
	if (type === CURSOR_SANDBOX_TYPES.INSECURE_NONE) return "danger-full-access";
	if (type === CURSOR_SANDBOX_TYPES.WORKSPACE_READWRITE) return "workspace-write";
	if (type === CURSOR_SANDBOX_TYPES.WORKSPACE_READONLY) return "read-only";
	return undefined;
}

export async function resolveShellSandboxPolicy(world, requested, command, { signal, callId } : any = {}) {
	const policyService = world.sandboxPolicy;
	if (policyService === undefined) return undefined;
	const standing = policyService.resolve(world.agent === undefined ? {} : { session: world.agent.session });
	if (requested === undefined || requested === null) return standing;
	const requestedMode = cursorSandboxTypeToMode(requested);
	if (requestedMode === undefined) return standing;
	if (DSH_MODE_RANK[requestedMode] <= DSH_MODE_RANK[standing.mode]) {
		return { ...standing, mode: requestedMode };
	}
	if (world.approval === undefined) {
		throw new Error(`command "${command.slice(0, 80)}" requires sandbox escalation to ${requestedMode}, but no approval service is composed`);
	}
	if (world.agent === undefined) {
		throw new Error(`command "${command.slice(0, 80)}" requires sandbox escalation to ${requestedMode}, but the call has no owning agent session`);
	}
	const outcome = await world.approval.request({
		agent: world.agent,
		toolName: "bash",
		callId,
		reason: `escalate sandbox to ${requestedMode}: the model requested it for the shell command "${command.slice(0, 80)}"`,
		signal,
	});
	if (outcome === "allowed-once") return { ...standing, mode: requestedMode };
	if (outcome === "cancelled") {
		throw new Error(`command "${command.slice(0, 80)}" was not executed: the sandbox escalation approval was cancelled`);
	}
	if (outcome === "unavailable") {
		throw new Error(`command "${command.slice(0, 80)}" was not executed: no approval channel is available for the sandbox escalation`);
	}
	throw new Error(`command "${command.slice(0, 80)}" was not executed: the user rejected the sandbox escalation to ${requestedMode}`);
}

export async function execRead(world, { path, signal }) {
	if (world.fs === undefined) throw new Error("read requires the session filesystem service");
	const filePath = String(path ?? "");
	if (filePath.trim().length === 0) throw new Error("file_path must be a non-empty string");
	const target = await world.fs.resolve(filePath, resolveOptions(world.agent));
	const info = await world.fs.stat(target, signal);
	if (info === undefined) throw new Error(`cannot read "${target.displayPath}": not found`);
	if (info.type !== "file") throw new Error(`cannot read "${target.displayPath}": not a regular file`);
	try {
		const content = await world.fs.readText(target, signal);
		return { kind: "text", path: target.displayPath, content, bytes: new TextEncoder().encode(content).length };
	} catch (error) {
		if (!isNotTextError(error)) throw error;
		if (typeof world.fs.readBytes !== "function") throw error;
		const data = await world.fs.readBytes(target, signal, READ_IMAGE_MAX_BYTES);
		const mime = sniffImageMime(data) ?? imageMimeFromPath(target.displayPath);
		if (mime !== undefined) {
			const resized = await resizeReadImage(data, mime, basename(target.displayPath));
			return {
				kind: "image",
				path: target.displayPath,
				data: resized.data,
				mime: resized.mime,
				bytes: resized.bytes,
				fileSize: data.length,
				width: resized.width,
				height: resized.height,
				originalDimensions: resized.originalDimensions,
			};
		}
		const reason = binaryUnsupportedReason(target.displayPath);
		const invalid: any = new Error(reason);
		invalid.code = "READ_INVALID_FILE";
		invalid.path = target.displayPath;
		throw invalid;
	}
}

export async function execWrite(world, { path, content, signal, callId }) {
	if (world.fs === undefined) throw new Error("write requires the session filesystem service");
	const filePath = String(path ?? "");
	if (filePath.trim().length === 0) throw new Error("file_path must be a non-empty string");
	const target = await world.fs.resolve(filePath, resolveOptions(world.agent));
	const info = await world.fs.stat(target, signal);
	const policy = await escalateSandboxMutation(world, {
		verb: "write",
		path: filePath,
		operation: `write ${info === undefined ? "new file" : "file"}`,
		signal,
		callId,
	});
	if (info === undefined && typeof world.fs.processPath === "function") {
		try {
			mkdirSync(dirname(world.fs.processPath(target)), { recursive: true });
		} catch {
			// remote backends create parents inside writeText
		}
	}
	await world.fs.writeText(target, content, undefined, signal, policy);
	return { path: target.displayPath, operation: info === undefined ? "create" : "update" };
}

export async function execDelete(world, { path, signal, callId }) {
	if (world.fs === undefined) throw new Error("delete requires the session filesystem service");
	if (world.shell === undefined) throw new Error("delete requires the session shell service");
	const filePath = String(path ?? "");
	if (filePath.trim().length === 0) throw new Error("file_path must be a non-empty string");
	const target = await world.fs.resolve(filePath, resolveOptions(world.agent));
	const info = await world.fs.stat(target, signal);
	if (info === undefined) throw new Error(`cannot delete "${target.displayPath}": not found`);
	const fileSize = info.size;
	const policy = await escalateSandboxMutation(world, {
		verb: "delete",
		path: filePath,
		operation: "delete file",
		signal,
		callId,
	});
	const quoted = `'${target.displayPath.replace(/'/g, `'\\''`)}'`;
	const request: any = { command: `rm -f -- ${quoted}`, timeoutMs: 30_000, signal };
	if (policy !== undefined) request.sandboxPolicy = policy;
	const result = await world.shell.run(world.shell.resolve(request));
	if (result.exitCode !== 0) {
		const detail = (result.stderr?.text ?? "").trim();
		throw new Error(`rm failed with exit code ${result.exitCode}${detail.length > 0 ? `: ${detail}` : ""}`);
	}
	return { path: target.displayPath, fileSize };
}

let rgPathPromise;

export async function resolveRgPath() {
	rgPathPromise ??= import("@vscode/ripgrep").then((mod) => mod.rgPath);
	return rgPathPromise;
}

/**
 * Run packaged ripgrep. Prefer `subprocess` (session execution world); fall
 * back to host `spawn` only when no seam is mounted (unit tests).
 */
export async function runPackagedRipgrep({ cwd, signal, argv, subprocess, graceMs = SEARCH_GRACE_MS }: any = {}): Promise<any> {
	if (signal?.aborted) throw new Error("search was aborted before completion");
	const rgPath = await resolveRgPath().catch((error) => {
		throw new Error(`could not resolve the packaged ripgrep binary: ${displayError(error)}`);
	});
	if (subprocess !== undefined) {
		const handle = subprocess.spawn({
			argv: [rgPath, "--no-config", ...argv ?? []],
			cwd: cwd ?? process.cwd(),
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: CURSOR_GREP_MAX_BYTES },
				stderr: { maxBytes: CURSOR_GREP_STDERR_MAX_BYTES },
			},
			graceMs,
			signal,
		});
		const outcome = await handle.done;
		if (signal?.aborted) throw new Error("search was aborted before completion");
		const stdout = handle.collected?.stdout?.readFrom(0);
		const stderr = handle.collected?.stderr?.readFrom(0);
		if (stdout === undefined) throw new Error("search command produced no collected stdout");
		if (outcome.signal !== null && !stdout.lossy) {
			throw new Error(`search was killed by signal ${outcome.signal}`);
		}
		if (outcome.exitCode !== 0 && outcome.exitCode !== 1 && !stdout.lossy) {
			const detail = String(stderr?.text ?? "").trim();
			throw new Error(`search failed${detail.length > 0 ? `: ${detail}` : ` (exit ${outcome.exitCode})`}`);
		}
		return {
			text: stdout.text ?? "",
			lossy: stdout.lossy === true,
			noMatches: outcome.exitCode === 1 && stdout.lossy !== true,
		};
	}
	return await new Promise((resolve, reject) => {
		const child = spawn(rgPath, ["--no-config", ...argv ?? []], {
			cwd: cwd ?? process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const stdoutChunks = [];
		const stderrChunks = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let truncated = false;
		const onAbort = () => {
			try { child.kill("SIGTERM"); } catch { /* already gone */ }
		};
		if (signal !== undefined) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		child.stdout.on("data", (chunk) => {
			if (truncated) return;
			stdoutBytes += chunk.length;
			if (stdoutBytes > CURSOR_GREP_MAX_BYTES) {
				truncated = true;
				try { child.kill("SIGTERM"); } catch { /* already gone */ }
				return;
			}
			stdoutChunks.push(chunk);
		});
		child.stderr.on("data", (chunk) => {
			if (stderrBytes >= CURSOR_GREP_STDERR_MAX_BYTES) return;
			const room = CURSOR_GREP_STDERR_MAX_BYTES - stderrBytes;
			stderrChunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
			stderrBytes += Math.min(chunk.length, room);
		});
		child.once("error", (error) => {
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.once("close", (exitCode, killedSignal) => {
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) {
				reject(new Error("search was aborted before completion"));
				return;
			}
			if (killedSignal !== null && !truncated) {
				reject(new Error(`search was killed by signal ${killedSignal}`));
				return;
			}
			if (exitCode !== 0 && exitCode !== 1 && !truncated) {
				const detail = Buffer.concat(stderrChunks).toString("utf8").trim();
				reject(new Error(`search failed${detail.length > 0 ? `: ${detail}` : ` (exit ${exitCode})`}`));
				return;
			}
			resolve({
				text: Buffer.concat(stdoutChunks).toString("utf8"),
				lossy: truncated,
				noMatches: exitCode === 1 && !truncated,
			});
		});
	});
}

function mergeSearchSignal(signal, timeoutMs = SEARCH_TIMEOUT_MS) {
	const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof AbortSignal.timeout === "function"
		? AbortSignal.timeout(timeoutMs)
		: undefined;
	if (signal === undefined) return timeout;
	if (timeout === undefined) return signal;
	return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
}

export async function runCursorSearch(classified, { cwd, signal, subprocess, timeoutMs = SEARCH_TIMEOUT_MS } : any = {}) {
	const search = classified?.search ?? {};
	const combined = mergeSearchSignal(signal, timeoutMs);
	if (search.mode === "glob") {
		if (typeof search.pattern !== "string" || search.pattern.length === 0) {
			throw new Error("pattern must be a non-empty string");
		}
		const argv = [
			"--files",
			`--glob=${search.pattern}`,
			"--sort=modified",
			"--no-ignore",
			"--hidden",
			...CURSOR_GLOB_VCS_EXCLUDES.flatMap((name) => [`--glob=!**/${name}`, `--glob=!**/${name}/**`]),
		];
		if (typeof search.path === "string" && search.path.length > 0) argv.push("--", search.path);
		const run = await runPackagedRipgrep({ cwd, signal: combined, argv, subprocess });
		const all = run.noMatches ? [] : run.text.split("\n").filter((line) => line.length > 0);
		const files = all.slice(0, CURSOR_GLOB_MAX_FILES);
		return { mode: "glob", files, totalFiles: all.length, truncated: run.lossy || files.length < all.length };
	}
	if (typeof search.pattern !== "string" || search.pattern.length === 0) {
		throw new Error("pattern must be a non-empty string");
	}
	const argv = [];
	if (search.caseInsensitive === true) argv.push("-i");
	if (typeof search.glob === "string" && search.glob.length > 0) argv.push(`--glob=${search.glob}`);
	if (Number.isSafeInteger(search.headLimit) && search.headLimit > 0) argv.push(`--max-count=${search.headLimit}`);
	const target = typeof search.path === "string" && search.path.length > 0 ? search.path : ".";
	if (search.mode === "files_with_matches") {
		argv.push("--files-with-matches", "--", search.pattern, target);
		const run = await runPackagedRipgrep({ cwd, signal: combined, argv, subprocess });
		const files = run.noMatches ? [] : run.text.split("\n").filter((line) => line.length > 0);
		return { mode: "files_with_matches", files, totalFiles: files.length, truncated: run.lossy };
	}
	if (search.mode === "count") {
		argv.push("--count-matches", "--", search.pattern, target);
		const run = await runPackagedRipgrep({ cwd, signal: combined, argv, subprocess });
		const counts = [];
		let totalMatches = 0;
		if (!run.noMatches) {
			for (const line of run.text.split("\n")) {
				const cut = line.lastIndexOf(":");
				if (cut <= 0) continue;
				const count = Number(line.slice(cut + 1));
				if (!Number.isSafeInteger(count)) continue;
				counts.push({ file: line.slice(0, cut), count });
				totalMatches += count;
			}
		}
		return { mode: "count", counts, totalFiles: counts.length, totalMatches, truncated: run.lossy };
	}
	argv.push("--json", "--", search.pattern, target);
	const run = await runPackagedRipgrep({ cwd, signal: combined, argv, subprocess });
	const matches = [];
	const byFile = new Map();
	let totalMatchedLines = 0;
	if (!run.noMatches) {
		for (const line of run.text.split("\n")) {
			if (line.length === 0) continue;
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			if (event?.type !== "match") continue;
			const file = event.data?.path?.text ?? "";
			const content = event.data?.lines?.text ?? "";
			const rawLine = event.data?.line_number ?? event.data?.lines?.line_number;
			const lineNumber = Number.isSafeInteger(rawLine) ? rawLine : 0;
			let group = byFile.get(file);
			if (group === undefined) {
				group = { file, matches: [] };
				byFile.set(file, group);
				matches.push(group);
			}
			group.matches.push({ lineNumber, content });
			totalMatchedLines += 1;
		}
	}
	return { mode: "content", matches, totalMatchedLines, truncated: run.lossy };
}

export async function execSearch(world, classified, { signal } : any = {}) {
	const cwd = world.agent?.session?.header?.cwd ?? process.cwd();
	return await runCursorSearch(classified, { cwd, signal, subprocess: world.subprocess });
}

export const BACKGROUND_PID_PROLOGUE = 'echo "CURSOR_BG_PID=$(awk \'/^NSpid:/ {print $2}\' /proc/$$/status)"';

export function parseJobIdN(jobId) {
	const match = /^bash-(\d+)$/.exec(String(jobId ?? ""));
	return match === null ? undefined : Number(match[1]);
}

function startOwnedJob(world, { command, request }) {
	if (world.jobs === undefined) {
		return { proc: world.shell.start(world.shell.resolve(request)), jobId: undefined };
	}
	let proc;
	const jobId = world.jobs.start({
		kind: "bash",
		label: command,
		...world.agent !== undefined ? { owner: world.agent } : {},
		run: () => {
			proc = world.shell.start(world.shell.resolve(request));
			return {
				cancel: () => void proc.kill(),
				done: proc.done.then(
					() => ({ status: proc.status === "completed" ? "completed" : "killed", detail: `exit code: ${proc.exitCode ?? "signal"}` }),
					() => ({ status: "failed", detail: "spawn or run failed" }),
				),
				readOutput: () => proc.readOutput().delta,
			};
		},
	});
	return { proc, jobId };
}

/**
 * Spawn a shell in the session world and return a live channel the adapter
 * forwarder already understands. Does not register DSH tools.
 */
export async function startCursorShell(world, {
	command,
	workdir,
	timeoutMs = 120_000,
	timeoutBehavior = 0,
	background = false,
	sandboxPolicy,
	signal,
	callId,
} : any = {}) {
	if (world.shell === undefined) throw new Error("bash requires the session shell service");
	const cwd = typeof workdir === "string" && workdir.length > 0
		? workdir
		: world.agent?.session?.header?.cwd ?? process.cwd();
	const policy = await resolveShellSandboxPolicy(world, sandboxPolicy, command, { signal, callId });
	const mayBackground = background === true || timeoutBehavior === 2;
	const bgCommand = mayBackground ? `${BACKGROUND_PID_PROLOGUE}\n${command}` : command;
	const request: any = { command: bgCommand, workdir: cwd, stdoutMaxBytes: 4 * 1024 * 1024 };
	if (background !== true) request.timeoutMs = timeoutMs;
	if (policy !== undefined) request.sandboxPolicy = policy;
	if (signal !== undefined && background !== true) request.signal = signal;
	let proc;
	let jobId;
	if (mayBackground) {
		({ proc, jobId } = startOwnedJob(world, { command, request }));
	} else {
		proc = world.shell.start(world.shell.resolve(request));
	}
	const shellId = jobId === undefined ? undefined : parseJobIdN(jobId);
	const channel = {
		chunks: [],
		stdout: "",
		done: background === true,
		exitCode: null,
		error: undefined,
		policy,
		backgrounded: background === true,
		proc: background === true ? proc : undefined,
		pid: undefined,
		jobId,
	};
	return { channel, proc, jobId, shellId, workdir: cwd, command, timeoutMs, timeoutBehavior, background };
}

/**
 * Fill a live shell channel until the process exits or is backgrounded.
 * The adapter's stream forwarder polls the same channel.
 */
export async function pumpCursorShell(started, { sleep: sleepFn, createPidProbe } : any = {}) {
	const wait = sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const { channel, proc, timeoutMs = 120_000, timeoutBehavior = 0, background } = started;
	if (background === true) {
		channel.proc = proc;
		channel.backgrounded = true;
		channel.done = true;
		return started;
	}
	const mayBackground = timeoutBehavior === 2;
	let backgrounded = false;
	const timeoutTimer = setTimeout(() => {
		if (timeoutBehavior === 2) backgrounded = true;
		else {
			try { proc.kill(); } catch { /* already gone */ }
		}
	}, timeoutMs);
	timeoutTimer.unref?.();
	const pidProbe = mayBackground && typeof createPidProbe === "function" ? createPidProbe() : undefined;
	try {
		for (;;) {
			const read = proc.readOutput();
			const probed = pidProbe === undefined ? { pid: undefined, rest: read.delta } : pidProbe.consume(read.delta);
			if (probed.pid !== undefined && channel.pid === undefined) channel.pid = probed.pid;
			if (probed.rest.length > 0) {
				channel.chunks.push(probed.rest);
				channel.stdout += probed.rest;
			}
			if (read.lossy) {
				const note = "\n[output truncated by the shell capture cap]";
				channel.chunks.push(note);
				channel.stdout += note;
			}
			if (backgrounded) {
				channel.proc = proc;
				channel.backgrounded = true;
				channel.jobId = started.jobId;
				channel.done = true;
				return started;
			}
			if (proc.status !== "running") break;
			await wait(50);
		}
		const tail = proc.readOutput();
		const tailProbed = pidProbe === undefined ? { pid: undefined, rest: tail.delta } : pidProbe.consume(tail.delta);
		if (tailProbed.pid !== undefined && channel.pid === undefined) channel.pid = tailProbed.pid;
		if (tailProbed.rest.length > 0) {
			channel.chunks.push(tailProbed.rest);
			channel.stdout += tailProbed.rest;
		}
		channel.exitCode = proc.exitCode ?? 1;
		channel.done = true;
		return started;
	} catch (error) {
		channel.error = error instanceof Error ? error.message : String(error);
		channel.exitCode = 1;
		channel.done = true;
		throw error;
	} finally {
		clearTimeout(timeoutTimer);
	}
}

export function noteProbeRead(store, rawId, entry) {
	if (typeof rawId !== "string" || rawId.length === 0) return;
	store.set(rawId, entry);
}

export function takeProbeRead(store, rawId) {
	if (typeof rawId !== "string" || rawId.length === 0) return undefined;
	const entry = store.get(rawId);
	if (entry === undefined) return undefined;
	store.delete(rawId);
	return entry;
}
