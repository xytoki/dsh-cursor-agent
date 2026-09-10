/**
 * Cursor workspace rules for `RequestContext.rules`.
 *
 * Mirrors `@cursor/sdk` `LocalCursorRulesService`: AGENTS.md and `.cursorrules`
 * are always-apply; `.mdc` files under `.cursor/rules` use frontmatter
 * (`alwaysApply` / `globs` / `description`). Nested `AGENTS.md` files are
 * uploaded at context time so the server can apply them — the client does
 * not inject on read.
 *
 * Ancestor walk matches the official client: from the workspace directory
 * (`dirname` until the filesystem root). `.git` is only used to locate
 * `.cursorrules`. Nested discovery stays inside the workspace.
 *
 * @module dsh-cursor-agent/rules
 */
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { lstat, readdir, readFile } from "node:fs/promises";
import { Writer } from "./proto";

/** Description cap (`AZ6` in `@cursor/sdk`). */
export const RULE_DESCRIPTION_CAP = 1536;

/** Skip one source file larger than this (DSH `maxSourceBytes` / Cursor sanity). */
export const MAX_RULE_SOURCE_BYTES = 1_048_576;

/** Bound the RequestContext payload. */
export const MAX_RULES = 256;

const SKIP_DIR_NAMES = new Set([
	".git",
	".hg",
	".svn",
	".cache",
	".dsh",
	".next",
	".nuxt",
	".turbo",
	".venv",
	"__pycache__",
	"coverage",
	"node_modules",
	"venv",
]);

const defaultIo = {
	async readFile(path) {
		return readFile(path, "utf8");
	},
	async isFile(path) {
		try {
			return (await lstat(path)).isFile();
		} catch {
			return false;
		}
	},
	async isDirectory(path) {
		try {
			return (await lstat(path)).isDirectory();
		} catch {
			return false;
		}
	},
	async readdir(path) {
		return readdir(path, { withFileTypes: true });
	},
};

function parseFrontmatterScalar(value) {
	const trimmed = String(value ?? "").trim();
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (
		trimmed.length >= 2
		&& ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function splitGlobList(value) {
	const items = [];
	let start = 0;
	let depth = 0;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (ch === "{") depth++;
		else if (ch === "}" && depth > 0) depth--;
		else if (ch === "," && depth === 0) {
			const part = value.slice(start, i).trim();
			if (part.length > 0) items.push(part);
			start = i + 1;
		}
	}
	const last = value.slice(start).trim();
	if (last.length > 0) items.push(last);
	return items;
}

export function normalizeRuleGlobs(value) {
	if (typeof value === "string") {
		const items = splitGlobList(value);
		return items.length > 0 ? items : undefined;
	}
	if (Array.isArray(value)) {
		const items = value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean);
		return items.length > 0 ? items : undefined;
	}
	return undefined;
}

/**
 * Cursor's `Jo0` .mdc frontmatter parser (not full YAML).
 * @returns {{ frontmatter: Record<string, unknown>, rawFrontmatter: string, body: string } | undefined}
 */
export function parseCursorRuleFrontmatter(text) {
	const trimmed = String(text ?? "").trimStart();
	if (!trimmed.startsWith("---")) return undefined;
	const parts = trimmed.split("---").filter(Boolean);
	if (parts.length < 2) return undefined;
	const raw = parts[0].trim();
	const body = parts.slice(1).join("---").trim();
	const frontmatter: any = {};
	let metadataBlock = null;
	let listKey = null;
	for (const rawLine of raw.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const listItem = line.match(/^\s+-\s+(.*)$/);
		if (listItem && listKey) {
			let item = listItem[1].trim();
			if (
				(item.startsWith('"') && item.endsWith('"'))
				|| (item.startsWith("'") && item.endsWith("'"))
			) {
				item = item.slice(1, -1);
			}
			const existing = frontmatter[listKey];
			if (Array.isArray(existing)) existing.push(item);
			continue;
		}
		const indented = line.startsWith("  ") || line.startsWith("\t");
		if (metadataBlock && indented) {
			const inner = line.trim();
			const colon = inner.indexOf(":");
			if (colon === -1) continue;
			const key = inner.slice(0, colon).trim();
			const rest = inner.slice(colon + 1).trim();
			const parsed = parseFrontmatterScalar(rest);
			const path = `${metadataBlock}.${key}`;
			if (rest === "") {
				frontmatter[path] = [];
				listKey = path;
			} else if (path === "metadata.environments" || path === "metadata.disabledEnvironments" || path === "metadata.scopedTo") {
				frontmatter[path] = String(parsed).split(",").map((part) => part.trim()).filter(Boolean);
				listKey = null;
			} else {
				frontmatter[path] = parsed;
				listKey = null;
			}
			continue;
		}
		metadataBlock = null;
		listKey = null;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const rest = line.slice(colon + 1).trim();
		if (rest === "" && key === "metadata") {
			metadataBlock = key;
			continue;
		}
		if (key === "globs" && rest === "") {
			frontmatter.globs = [];
			listKey = "globs";
			continue;
		}
		const parsed = parseFrontmatterScalar(rest);
		if (key === "metadata.environments" || key === "metadata.disabledEnvironments" || key === "metadata.scopedTo") {
			frontmatter[key] = String(parsed).split(",").map((part) => part.trim()).filter(Boolean);
			continue;
		}
		frontmatter[key] = parsed;
	}
	return {
		frontmatter,
		rawFrontmatter: `---\n${raw}\n---`,
		body,
	};
}

/** Cursor `x31` type selection from parsed frontmatter. */
export function cursorRuleKindFromFrontmatter(frontmatter : any = {}) {
	if (frontmatter.alwaysApply === true) return { kind: "global" };
	const globs = normalizeRuleGlobs(frontmatter.globs);
	if (globs !== undefined) return { kind: "fileGlobbed", globs };
	if (typeof frontmatter.description === "string" && frontmatter.description.trim().length > 0) {
		return { kind: "agentFetched", description: frontmatter.description.trim().slice(0, RULE_DESCRIPTION_CAP) };
	}
	return { kind: "manuallyAttached" };
}

function stringList(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function toRule({ path, body, frontmatter = {}, rawFrontmatter = "", source = 0 }: any) {
	const kind = cursorRuleKindFromFrontmatter(frontmatter);
	return {
		fullPath: path,
		content: body,
		kind: kind.kind,
		...kind.globs !== undefined ? { globs: kind.globs } : {},
		...kind.description !== undefined ? { description: kind.description } : {},
		environments: stringList(frontmatter["metadata.environments"]),
		disabledEnvironments: stringList(frontmatter["metadata.disabledEnvironments"]),
		scopedTo: stringList(frontmatter["metadata.scopedTo"]),
		frontmatter: rawFrontmatter,
		source,
	};
}

function alwaysApplyMarkdownRule(path, body, source = 0) {
	return {
		fullPath: path,
		content: body,
		kind: "global",
		environments: [],
		disabledEnvironments: [],
		scopedTo: [],
		frontmatter: "",
		source,
	};
}

/** Virtual path for the DSH-assembled system prompt uploaded as a Cursor rule. */
export const DSH_SYSTEM_RULE_PATH = "dsh://system-prompt";

/**
 * DSH's composed system prompt (persona, harness identity, plugin sections)
 * as an always-apply Cursor rule. The official `root_prompt` / custom-system
 * slots replace Cursor's built-in agent prompt; rules append beside it.
 */
export function dshSystemPromptRule(text) {
	const rule: any = alwaysApplyMarkdownRule(DSH_SYSTEM_RULE_PATH, String(text ?? ""));
	rule.plugin = "dsh";
	rule.required = true;
	return rule;
}

/** Prepend the DSH system prompt rule when the assembled text is non-empty. */
export function mergeDshSystemRule(rules, systemText) {
	const text = String(systemText ?? "").trim();
	if (text.length === 0) return rules ?? [];
	return [dshSystemPromptRule(text), ...(rules ?? [])].slice(0, MAX_RULES);
}

export function encodeCursorRuleType(rule) {
	const writer = new Writer();
	if (rule.kind === "fileGlobbed") {
		const inner = new Writer();
		for (const glob of rule.globs ?? []) inner.string(1, glob);
		writer.message(2, inner.finish());
	} else if (rule.kind === "agentFetched") {
		writer.message(3, new Writer().string(1, rule.description ?? "").finish());
	} else if (rule.kind === "manuallyAttached") {
		writer.message(4, new Uint8Array());
	} else {
		writer.message(1, new Uint8Array());
	}
	return writer.finish();
}

export function encodeCursorRule(rule) {
	const writer = new Writer();
	writer.string(1, rule.fullPath ?? "");
	writer.string(2, rule.content ?? "");
	writer.message(3, encodeCursorRuleType(rule));
	if (Number.isSafeInteger(rule.source) && rule.source > 0) writer.varint(4, rule.source);
	for (const value of rule.environments ?? []) writer.string(7, value);
	for (const value of rule.disabledEnvironments ?? []) writer.string(8, value);
	if (typeof rule.plugin === "string" && rule.plugin.length > 0) writer.string(9, rule.plugin);
	for (const value of rule.scopedTo ?? []) writer.string(13, value);
	if (typeof rule.frontmatter === "string" && rule.frontmatter.length > 0) writer.string(14, rule.frontmatter);
	if (rule.required === true) writer.varint(15, 1);
	return writer.finish();
}

async function readBounded(io, path) {
	const text = await io.readFile(path);
	if (Buffer.byteLength(text, "utf8") > MAX_RULE_SOURCE_BYTES) return undefined;
	return text;
}

async function loadAlwaysApplyMarkdown(io, dir, name) {
	const path = join(dir, name);
	if (!await io.isFile(path)) return undefined;
	const body = await readBounded(io, path);
	if (body === undefined) return undefined;
	return alwaysApplyMarkdownRule(path, body);
}

async function loadMdc(io, path, source = 0) {
	if (!await io.isFile(path)) return undefined;
	const text = await readBounded(io, path);
	if (text === undefined) return undefined;
	const parsed = parseCursorRuleFrontmatter(text);
	if (parsed === undefined) return undefined;
	return toRule({
		path,
		body: parsed.body,
		frontmatter: parsed.frontmatter,
		rawFrontmatter: parsed.rawFrontmatter,
		source,
	});
}

async function loadMdcTree(io, dir, source = 0, out) {
	if (!await io.isDirectory(dir)) return;
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop();
		let entries;
		try {
			entries = await io.readdir(current);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const name = typeof entry.name === "string" ? entry.name : String(entry);
			const path = join(current, name);
			const isDir = typeof entry.isDirectory === "function" ? entry.isDirectory() : false;
			const isFile = typeof entry.isFile === "function" ? entry.isFile() : false;
			const isSymlink = typeof entry.isSymbolicLink === "function" ? entry.isSymbolicLink() : false;
			if (isSymlink) continue;
			if (isDir) {
				if (!SKIP_DIR_NAMES.has(name)) stack.push(path);
				continue;
			}
			if (isFile && name.endsWith(".mdc")) {
				const rule = await loadMdc(io, path, source);
				if (rule !== undefined) out.set(rule.fullPath, rule);
			}
		}
	}
}

async function findGitRoot(io, start) {
	let dir = start;
	for (;;) {
		if (await io.isDirectory(join(dir, ".git")) || await io.isFile(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Official `loadRulesFromDirAndAncestors`: dirname until parent === self. */
function ancestorDirs(start) {
	const dirs = [];
	let dir = start;
	for (;;) {
		dirs.push(dir);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirs;
}

async function walkNestedMarkdown(io, root, out) {
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		let entries;
		try {
			entries = await io.readdir(current);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const name = typeof entry.name === "string" ? entry.name : String(entry);
			const path = join(current, name);
			const isDir = typeof entry.isDirectory === "function" ? entry.isDirectory() : false;
			const isFile = typeof entry.isFile === "function" ? entry.isFile() : false;
			const isSymlink = typeof entry.isSymbolicLink === "function" ? entry.isSymbolicLink() : false;
			if (isSymlink) continue;
			if (isDir) {
				if (!SKIP_DIR_NAMES.has(name)) stack.push(path);
				continue;
			}
			if (isFile && name === "AGENTS.md") {
				const body = await readBounded(io, path);
				if (body !== undefined) out.set(path, alwaysApplyMarkdownRule(path, body));
			} else if (isFile && name.endsWith(".mdc") && path.includes(`${sep}.cursor${sep}rules${sep}`)) {
				const rule = await loadMdc(io, path);
				if (rule !== undefined) out.set(rule.fullPath, rule);
			}
		}
	}
}

/**
 * Collect Cursor rules for one workspace cwd.
 *
 * @param {{ cwd?: string, includeClaude?: boolean, userRulesDir?: string | false, fs?: typeof defaultIo }} [options]
 */
export async function collectCursorRules(options : any = {}) {
	const io = options.fs ?? defaultIo;
	const cwd = resolve(options.cwd ?? process.cwd());
	const includeClaude = options.includeClaude === true;
	const byPath = new Map();

	const gitRoot = await findGitRoot(io, cwd);
	const projectRoot = gitRoot ?? cwd;

	const cursorrules = join(projectRoot, ".cursorrules");
	if (await io.isFile(cursorrules)) {
		const body = await readBounded(io, cursorrules);
		if (body !== undefined) byPath.set(cursorrules, alwaysApplyMarkdownRule(cursorrules, body));
	}

	for (const dir of ancestorDirs(cwd)) {
		const agents = await loadAlwaysApplyMarkdown(io, dir, "AGENTS.md");
		if (agents !== undefined) byPath.set(agents.fullPath, agents);
		if (includeClaude) {
			for (const name of ["CLAUDE.md", "CLAUDE.local.md"]) {
				const extra = await loadAlwaysApplyMarkdown(io, dir, name);
				if (extra !== undefined) byPath.set(extra.fullPath, extra);
			}
		}
		await loadMdcTree(io, join(dir, ".cursor", "rules"), 0, byPath);
	}

	await walkNestedMarkdown(io, cwd, byPath);

	if (options.userRulesDir !== false) {
		const userDir = options.userRulesDir ?? join(homedir(), ".cursor", "rules");
		await loadMdcTree(io, userDir, 2, byPath);
	}

	return [...byPath.values()].slice(0, MAX_RULES);
}
