import { test } from "@rstest/core";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Reader } from "../src/proto";
import {
	collectCursorRules,
	cursorRuleKindFromFrontmatter,
	DSH_SYSTEM_RULE_PATH,
	dshSystemPromptRule,
	encodeCursorRule,
	encodeRequestContextResult,
	mergeDshSystemRule,
	parseCursorRuleFrontmatter,
} from "../src/index";

const bytes = (text) => Array.from(new TextEncoder().encode(text));

function fields(payload) {
	const reader = new Reader(payload);
	const out = [];
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (wireType === 0) out.push([field, "v", reader.varint()]);
		else if (wireType === 2) out.push([field, "b", Array.from(reader.bytes())]);
		else {
			reader.skip(wireType);
			out.push([field, "s"]);
		}
	}
	return out;
}

function decodeType(ruleBytes) {
	const rule = fields(ruleBytes);
	const typeBytes = new Uint8Array(rule.find((entry) => entry[0] === 3)[2]);
	const type = fields(typeBytes);
	return type[0][0];
}

test("parseCursorRuleFrontmatter matches SDK alwaysApply / globs / description", () => {
	assert.equal(parseCursorRuleFrontmatter("no fence"), undefined);
	const always = parseCursorRuleFrontmatter("---\nalwaysApply: true\n---\nbody\n");
	assert.equal(always.frontmatter.alwaysApply, true);
	assert.equal(always.body, "body");
	assert.deepEqual(cursorRuleKindFromFrontmatter(always.frontmatter), { kind: "global" });

	const globs = parseCursorRuleFrontmatter("---\nglobs:\n  - \"*.ts\"\n  - src/**/*.js\n---\nscoped\n");
	assert.deepEqual(globs.frontmatter.globs, ["*.ts", "src/**/*.js"]);
	assert.deepEqual(cursorRuleKindFromFrontmatter(globs.frontmatter), { kind: "fileGlobbed", globs: ["*.ts", "src/**/*.js"] });

	const fetched = parseCursorRuleFrontmatter("---\ndescription: \"When testing\"\n---\n");
	assert.deepEqual(cursorRuleKindFromFrontmatter(fetched.frontmatter), { kind: "agentFetched", description: "When testing" });

	assert.deepEqual(cursorRuleKindFromFrontmatter({}), { kind: "manuallyAttached" });
});

test("encodeCursorRule writes type oneof and encodeRequestContextResult puts rules on field 2", () => {
	const encoded = encodeCursorRule({
		fullPath: "/ws/.cursor/rules/ts.mdc",
		content: "use ts",
		kind: "fileGlobbed",
		globs: ["*.ts"],
		frontmatter: "---\nglobs: \"*.ts\"\n---",
	});
	const rule = fields(encoded);
	assert.deepEqual(rule[0], [1, "b", bytes("/ws/.cursor/rules/ts.mdc")]);
	assert.deepEqual(rule[1], [2, "b", bytes("use ts")]);
	assert.equal(decodeType(encoded), 2);

	const wrapped = fields(encodeRequestContextResult([], [{
		fullPath: "/ws/AGENTS.md",
		content: "root",
		kind: "global",
	}]));
	assert.equal(wrapped.length, 1);
	assert.equal(wrapped[0][0], 1); // RequestContextResult.success
	const success = fields(new Uint8Array(wrapped[0][2]));
	const context = fields(new Uint8Array(success[0][2]));
	assert.equal(context[0][0], 2); // RequestContext.rules
	assert.equal(decodeType(new Uint8Array(context[0][2])), 1); // global
});

test("dshSystemPromptRule is a required always-apply rule prepended onto RequestContext", () => {
	const rule = dshSystemPromptRule("You are in DSH.");
	assert.equal(rule.fullPath, DSH_SYSTEM_RULE_PATH);
	assert.equal(rule.kind, "global");
	assert.equal(rule.plugin, "dsh");
	assert.equal(rule.required, true);
	const encoded = fields(encodeCursorRule(rule));
	assert.deepEqual(encoded[0], [1, "b", bytes(DSH_SYSTEM_RULE_PATH)]);
	assert.deepEqual(encoded[1], [2, "b", bytes("You are in DSH.")]);
	assert.equal(encoded.some((entry) => entry[0] === 9 && entry[2].join() === bytes("dsh").join()), true);
	assert.equal(encoded.some((entry) => entry[0] === 15 && entry[1] === "v" && entry[2] === 1), true);

	const merged = mergeDshSystemRule([{ fullPath: "/ws/AGENTS.md", content: "root", kind: "global" }], "sys");
	assert.equal(merged[0].fullPath, DSH_SYSTEM_RULE_PATH);
	assert.equal(merged[1].fullPath, "/ws/AGENTS.md");
	assert.deepEqual(mergeDshSystemRule([{ fullPath: "/ws/AGENTS.md", content: "root", kind: "global" }], "  "), [
		{ fullPath: "/ws/AGENTS.md", content: "root", kind: "global" },
	]);
});

test("collectCursorRules loads ancestor + nested AGENTS.md, .cursorrules, and mdc types", async () => {
	const outer = mkdtempSync(join(tmpdir(), "cursor-rules-outer-"));
	const root = join(outer, "repo");
	try {
		mkdirSync(root);
		writeFileSync(join(outer, "AGENTS.md"), "above git\n");
		mkdirSync(join(root, ".git"));
		writeFileSync(join(root, "AGENTS.md"), "root agents\n");
		writeFileSync(join(root, "CLAUDE.md"), "should stay out\n");
		writeFileSync(join(root, ".cursorrules"), "legacy always\n");
		mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
		writeFileSync(join(root, ".cursor", "rules", "always.mdc"), "---\nalwaysApply: true\n---\nalways body\n");
		writeFileSync(join(root, ".cursor", "rules", "glob.mdc"), "---\nglobs: \"*.ts\"\n---\nglob body\n");
		writeFileSync(join(root, ".cursor", "rules", "ask.mdc"), "---\ndescription: fetch me\n---\nask body\n");
		mkdirSync(join(root, "pkg", "deep"), { recursive: true });
		writeFileSync(join(root, "pkg", "AGENTS.md"), "nested agents\n");
		mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
		writeFileSync(join(root, "node_modules", "dep", "AGENTS.md"), "ignored\n");

		const rules = await collectCursorRules({ cwd: join(root, "pkg"), userRulesDir: false });
		const byPath = Object.fromEntries(rules.map((rule) => [rule.fullPath, rule]));
		assert.equal(byPath[join(root, "AGENTS.md")]?.content, "root agents\n");
		assert.equal(byPath[join(root, "AGENTS.md")]?.kind, "global");
		assert.equal(byPath[join(root, "pkg", "AGENTS.md")]?.content, "nested agents\n");
		assert.equal(byPath[join(root, ".cursorrules")]?.kind, "global");
		assert.equal(byPath[join(root, ".cursor", "rules", "always.mdc")]?.kind, "global");
		assert.deepEqual(byPath[join(root, ".cursor", "rules", "glob.mdc")]?.globs, ["*.ts"]);
		assert.equal(byPath[join(root, ".cursor", "rules", "ask.mdc")]?.kind, "agentFetched");
		assert.equal(byPath[join(root, "CLAUDE.md")], undefined);
		assert.equal(byPath[join(root, "node_modules", "dep", "AGENTS.md")], undefined);
		assert.equal(byPath[join(outer, "AGENTS.md")]?.content, "above git\n");
	} finally {
		rmSync(outer, { recursive: true, force: true });
	}
});

test("collectCursorRules walks ancestors past a gitless cwd to the filesystem root", async () => {
	const parent = mkdtempSync(join(tmpdir(), "cursor-rules-parent-"));
	const cwd = join(parent, "ws");
	try {
		mkdirSync(cwd);
		writeFileSync(join(parent, "AGENTS.md"), "parent\n");
		writeFileSync(join(cwd, "AGENTS.md"), "local\n");
		const rules = await collectCursorRules({ cwd, userRulesDir: false });
		assert.equal(rules.some((rule) => rule.fullPath === join(cwd, "AGENTS.md")), true);
		assert.equal(rules.some((rule) => rule.fullPath === join(parent, "AGENTS.md")), true);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});
