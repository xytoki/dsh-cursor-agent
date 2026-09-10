/**
 * Unit tests for dsh-cursor-agent wire helpers.
 *
 * These tests exercise the hand-rolled protobuf encoder/decoder, Connect
 * framing, and the DSH-history → Cursor-conversation mapping without touching
 * the network.
 */
import { test } from "@rstest/core";
import assert from "node:assert/strict";
import http2 from "node:http2";

import {
	varintEncode,
	Writer,
	Reader,
	encodeValue,
	decodeValue,
} from "../src/proto";
import {
	frameEncode,
	ConnectFrameReader,
	CONNECT_END_STREAM_FLAG,
	buildConversationState,
	buildInitialConversationState,
	buildRunPayload,
	classifyTurnIngress,
	decodeContextInjectionStateUpdate,
	encodeConversationActionMessage,
	encodeInjectContextAction,
	decodeAgentServerMessage,
	decodeConversationTokenDetails,
	decodeKvServerMessage,
	decodeTurnEndedUpdate,
	projectCursorTokenUsage,
	decodeMcpArgs,
	decodeUsableModels,
	encodeNameAgentRequest,
	decodeNameAgentResponse,
	unwrapSessionTitleFrame,
	extractSessionTitleUserMessage,
	fetchNameAgent,
	DSH_SESSION_TITLE_FRAME_PREFIX,
	CURSOR_NAME_AGENT_PATH,
	buildLoginUrl,
	CursorCredentialStore,
	CursorAuthService,
	CursorUsageReader,
	parseEndStream,
	parseTextToolCalls,
	classifyCursorError,
	encodeMcpResult,
	encodeSetBlobResult,
	encodeGetBlobResult,
	adoptBlobStore,
	partitionPendingExecs,
	CREDENTIAL_REF,
	getTokenExpiry,
	readJwtExpiry,
	classifyCursorSecret,
	maskApiKey,
	decodeCurrentPeriodUsage,
	decodeSandUsageStatus,
	decodeGetMe,
	decodeGetPlanInfo,
	projectCurrentPeriodUsage,
	projectSandUsageStatus,
	projectGetMe,
	projectGetPlanInfo,
	callDashboardRpc,
	CURSOR_BASE_URL,
	resolveCursorApiBaseUrl,
	resolveCursorSettings,
	shouldRetryHttpStatus,
	CursorAdapter,
	createCursorRpcHandler,
	createCursorRpcHttpHandler,
	AgentRun,
	isSuccessfulAgentResponse,
	awaitCursorJoin,
	resetCursorJoins,
	decodeExecServerMessage,
	decodeInteractionUpdate,
} from "../src/index";
import { AgentServerMessage } from "../src/generated/agent/v1/agent_service_pb.js";
import { InteractionUpdate, StepStartedUpdate } from "../src/generated/agent/v1/agent_pb.js";
import { ExecServerMessage } from "../src/generated/agent/v1/exec_pb.js";
import { SubagentArgs } from "../src/generated/agent/v1/subagent_exec_pb.js";

test("varintEncode encodes small and large values", () => {
	assert.deepEqual([...varintEncode(0)], [0]);
	assert.deepEqual([...varintEncode(1)], [1]);
	assert.deepEqual([...varintEncode(127)], [127]);
	assert.deepEqual([...varintEncode(128)], [128, 1]);
	assert.deepEqual([...varintEncode(300)], [172, 2]);
});

test("Writer/Reader round-trips strings, bytes, varints, doubles", () => {
	const writer = new Writer();
	writer.string(1, "hello");
	writer.varint(2, 300);
	writer.double(3, 1.5);
	const bytes = writer.finish();

	const reader = new Reader(bytes);
	const fields = {};
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) fields.a = reader.string();
		else if (field === 2 && wireType === 0) fields.b = reader.varint();
		else if (field === 3 && wireType === 1) fields.c = reader.double();
		else reader.skip(wireType);
	}
	assert.equal(fields.a, "hello");
	assert.equal(fields.b, 300);
	assert.equal(fields.c, 1.5);
});

test("encodeValue/decodeValue round-trip JSON values", () => {
	const samples = [
		null,
		true,
		false,
		42,
		-1.5,
		"text",
		[1, "two", false],
		{ a: 1, b: { c: ["x"] }, d: null },
	];
	for (const sample of samples) {
		const bytes = encodeValue(sample);
		assert.deepEqual(decodeValue(bytes), sample, JSON.stringify(sample));
	}
});

test("Connect framing round-trips through the incremental reader", async () => {
	const reader = new ConnectFrameReader();
	const payloadA = new Uint8Array([1, 2, 3]);
	const payloadB = new Uint8Array([4, 5, 6, 7, 8]);
	reader.push(frameEncode(payloadA));
	// Split the second frame across two pushes to exercise buffering.
	const frameB = frameEncode(payloadB, CONNECT_END_STREAM_FLAG);
	reader.push(frameB.slice(0, 3));
	reader.push(frameB.slice(3));
	reader.finish();

	const first = await reader.next();
	assert.deepEqual([...first.payload], [1, 2, 3]);
	assert.equal(first.flags, 0);
	const second = await reader.next();
	assert.deepEqual([...second.payload], [4, 5, 6, 7, 8]);
	assert.equal(second.flags & CONNECT_END_STREAM_FLAG, CONNECT_END_STREAM_FLAG);
	assert.equal(await reader.next(), undefined);
});

test("buildLoginUrl carries PKCE params on the cursor.com origin", () => {
	const url = buildLoginUrl({ challenge: "ch", uuid: "u" });
	const parsed = new URL(url);
	assert.equal(parsed.origin, "https://cursor.com");
	assert.equal(parsed.pathname, "/loginDeepControl");
	assert.equal(parsed.searchParams.get("challenge"), "ch");
	assert.equal(parsed.searchParams.get("uuid"), "u");
	assert.equal(parsed.searchParams.get("mode"), "login");
	assert.equal(parsed.searchParams.get("redirectTarget"), "cli");
});

test("buildConversationState maps DSH history to Cursor turns", () => {
	const options = {
		system: "You are a helpful assistant.",
		messages: [
			{ role: "user", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "reply one" }] },
			{ role: "user", content: [{ type: "text", text: "second" }] },
		],
	};
	const state = buildConversationState(options);
	assert.ok(state.conversationState instanceof Uint8Array);
	assert.ok(state.conversationState.length > 0);
	assert.ok(state.action instanceof Uint8Array);
	assert.ok(state.action.length > 0);
	// The system text is NOT sent through the root_prompt replace slot; it is
	// uploaded later as a RequestContext rule. No blob is created.
	assert.equal(state.blobStore.size, 0);
	assert.equal(state.systemText, "You are a helpful assistant.");
});

test("buildInitialConversationState never emits rejected field-8 turns", () => {
	const state = buildInitialConversationState({
		system: "sys",
		messages: [
			{ role: "user", content: [{ type: "text", text: "old question" }] },
			{ role: "assistant", content: [{ type: "text", text: "old answer" }] },
			{ role: "user", content: [{ type: "text", text: "current question" }] },
		],
	});
	const reader = new Reader(state.conversationState);
	const fields = [];
	while (!reader.done) {
		const tag = reader.tag();
		fields.push(tag.field);
		reader.skip(tag.wireType);
	}
	// No root prompt blobs, no hand-encoded turns: the cold-start state is empty.
	assert.deepEqual(fields, []);
	assert.equal(state.blobStore.size, 0);
	assert.equal(state.systemText, "sys");
});

test("cold-start run payload keeps the human prompt and leaves system/plugin off the action", () => {
	const built = buildRunPayload({
		system: "sys",
		messages: [
			{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "human prompt" }] },
			{ role: "user", source: { kind: "plugin" }, content: [{ type: "text", text: "runtime snapshot" }] },
		],
	}, "default");

	const envelope = new Reader(built.payload);
	assert.deepEqual(envelope.tag(), { field: 1, wireType: 2 });
	const request = new Reader(envelope.bytes());
	assert.deepEqual(request.tag(), { field: 1, wireType: 2 });
	const state = new Reader(request.bytes());
	while (!state.done) {
		const tag = state.tag();
		assert.notEqual(tag.field, 8);
		state.skip(tag.wireType);
	}
	assert.deepEqual(request.tag(), { field: 2, wireType: 2 });
	const action = new Reader(request.bytes());
	assert.deepEqual(action.tag(), { field: 1, wireType: 2 });
	const userAction = new Reader(action.bytes());
	assert.deepEqual(userAction.tag(), { field: 1, wireType: 2 });
	const userMessage = new Reader(userAction.bytes());
	assert.deepEqual(userMessage.tag(), { field: 1, wireType: 2 });
	const text = userMessage.string();
	// System text is a RequestContext rule, not a <system-reminder> user block.
	// Current-turn plugin injects are InjectContextAction, not action text.
	assert.equal(text.includes("<system-reminder>"), false);
	assert.equal(text.includes("sys"), false);
	assert.match(text, /human prompt/);
	assert.equal(text.includes("runtime snapshot"), false);
	assert.equal(built.systemText, "sys");
	assert.equal(built.injections.length, 1);
	assert.equal(built.injections[0].content, "runtime snapshot");
});

test("buildRunPayload without a checkpoint sends only this turn's user text", () => {
	const built = buildRunPayload({
		messages: [
			{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "old question" }] },
			{ role: "assistant", content: [{ type: "text", text: "old answer" }] },
			{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "new question" }] },
		],
	}, "default");
	const envelope = new Reader(built.payload);
	assert.deepEqual(envelope.tag(), { field: 1, wireType: 2 });
	const request = new Reader(envelope.bytes());
	assert.deepEqual(request.tag(), { field: 1, wireType: 2 });
	request.bytes();
	assert.deepEqual(request.tag(), { field: 2, wireType: 2 });
	const action = new Reader(request.bytes());
	assert.deepEqual(action.tag(), { field: 1, wireType: 2 });
	const userAction = new Reader(action.bytes());
	assert.deepEqual(userAction.tag(), { field: 1, wireType: 2 });
	const userMessage = new Reader(userAction.bytes());
	assert.deepEqual(userMessage.tag(), { field: 1, wireType: 2 });
	assert.equal(userMessage.string(), "new question");
});

test("buildRunPayload with a checkpoint and no new user uses resume_action", () => {
	const checkpoint = new Uint8Array([8, 42]);
	const built = buildRunPayload({
		messages: [
			{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "old question" }] },
			{
				role: "assistant",
				content: [
					{ type: "tool-call", id: "c1", name: "read", arguments: "{}" },
					{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "ok" }] },
				],
			},
		],
	}, "default", { checkpoint, blobs: new Map() });
	const envelope = new Reader(built.payload);
	assert.deepEqual(envelope.tag(), { field: 1, wireType: 2 });
	const request = new Reader(envelope.bytes());
	assert.deepEqual(request.tag(), { field: 1, wireType: 2 });
	assert.deepEqual([...request.bytes()], [...checkpoint]);
	assert.deepEqual(request.tag(), { field: 2, wireType: 2 });
	const action = new Reader(request.bytes());
	assert.deepEqual(action.tag(), { field: 2, wireType: 2 }, "resume_action, not a replay of the previous user question");
	action.bytes();
	assert.equal(action.done, true);
});

test("buildRunPayload produces a run request without throwing", () => {
	const options = {
		system: "sys",
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		tools: [
			{
				name: "pwsh",
				description: "run a command",
				parameters: { type: "object", properties: { command: { type: "string" } } },
			},
		],
	};
	const { payload, blobStore } = buildRunPayload(options, "claude-3.5-sonnet");
	assert.ok(payload instanceof Uint8Array);
	assert.ok(payload.length > 0);
	assert.equal(blobStore.size, 0);
});

test("buildRunPayload uses the persisted checkpoint and blob store", () => {
	const checkpoint = new Uint8Array([8, 42, 18, 3, 1, 2, 3]);
	const blobs = new Map([["aabb", new Uint8Array([9, 8, 7])]]);
	const options = {
		system: "new system text must not rebuild conversation state",
		messages: [
			{ role: "user", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "reply" }] },
			{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "follow-up" }] },
			{ role: "user", source: { kind: "plugin" }, content: [{ type: "text", text: "current runtime" }] },
		],
	};
	const built = buildRunPayload(options, "default", { checkpoint, blobs });
	assert.equal(built.blobStore, blobs);

	// AgentClientMessage.run_request=1, RunRequest.conversation_state=1.
	const envelope = new Reader(built.payload);
	const outerTag = envelope.tag();
	assert.deepEqual(outerTag, { field: 1, wireType: 2 });
	const request = new Reader(envelope.bytes());
	const stateTag = request.tag();
	assert.deepEqual(stateTag, { field: 1, wireType: 2 });
	assert.deepEqual([...request.bytes()], [...checkpoint]);
	assert.deepEqual(request.tag(), { field: 2, wireType: 2 });
	const action = new Reader(request.bytes());
	assert.deepEqual(action.tag(), { field: 1, wireType: 2 });
	const userAction = new Reader(action.bytes());
	assert.deepEqual(userAction.tag(), { field: 1, wireType: 2 });
	const userMessage = new Reader(userAction.bytes());
	assert.deepEqual(userMessage.tag(), { field: 1, wireType: 2 });
	assert.equal(userMessage.string(), "follow-up");
	assert.equal(built.injections.length, 1);
	assert.equal(built.injections[0].content, "current runtime");
});

test("classifyTurnIngress splits human steers from plugin injects", () => {
	const classified = classifyTurnIngress({
		system: "sys",
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
			{ role: "user", id: "u1", source: { kind: "user" }, content: [{ type: "text", text: "steer me" }] },
			{ role: "user", id: "p1", source: { kind: "plugin", plugin: "compaction-basic" }, content: [{ type: "text", text: "context high" }] },
			{ role: "user", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }] },
		],
	});
	assert.equal(classified.systemText, "sys");
	assert.deepEqual(classified.users.map((entry) => entry.text), ["steer me"]);
	assert.equal(classified.injections.length, 1);
	assert.equal(classified.injections[0].producer, "compaction-basic");
	assert.equal(classified.injections[0].content, "context high");
});

test("encodeInjectContextAction writes user_context and system_context oneofs", () => {
	const user = encodeInjectContextAction({
		injectionId: "inj-1",
		expectedRunId: "run-1",
		userContext: { text: "focus on tests", messageId: "m1" },
	});
	const userAction = new Reader(user);
	assert.deepEqual(userAction.tag(), { field: 19, wireType: 2 });
	const userInner = new Reader(userAction.bytes());
	assert.deepEqual(userInner.tag(), { field: 1, wireType: 2 });
	assert.equal(userInner.string(), "inj-1");
	assert.deepEqual(userInner.tag(), { field: 2, wireType: 2 });
	assert.equal(userInner.string(), "run-1");
	assert.deepEqual(userInner.tag(), { field: 3, wireType: 2 });
	const userCtx = new Reader(userInner.bytes());
	assert.deepEqual(userCtx.tag(), { field: 1, wireType: 2 });
	const userMessage = new Reader(userCtx.bytes());
	assert.deepEqual(userMessage.tag(), { field: 1, wireType: 2 });
	assert.equal(userMessage.string(), "focus on tests");

	const system = encodeInjectContextAction({
		injectionId: "inj-2",
		expectedRunId: "run-1",
		systemContext: { producer: "dsh-time", content: "it is Tuesday" },
	});
	const sysAction = new Reader(system);
	assert.deepEqual(sysAction.tag(), { field: 19, wireType: 2 });
	const sysInner = new Reader(sysAction.bytes());
	assert.deepEqual(sysInner.tag(), { field: 1, wireType: 2 });
	assert.equal(sysInner.string(), "inj-2");
	assert.deepEqual(sysInner.tag(), { field: 2, wireType: 2 });
	assert.equal(sysInner.string(), "run-1");
	assert.deepEqual(sysInner.tag(), { field: 4, wireType: 2 });
	const sysCtx = new Reader(sysInner.bytes());
	assert.deepEqual(sysCtx.tag(), { field: 1, wireType: 2 });
	assert.equal(sysCtx.string(), "dsh-time");
	assert.deepEqual(sysCtx.tag(), { field: 2, wireType: 2 });
	assert.equal(sysCtx.string(), "it is Tuesday");

	const envelope = new Reader(encodeConversationActionMessage(user));
	assert.deepEqual(envelope.tag(), { field: 4, wireType: 2 });
});

test("decodeContextInjectionStateUpdate reads queued / delivered / rejected", () => {
	const queued = new Writer().string(1, "inj-1").message(2, new Writer().message(1, new Uint8Array()).finish()).finish();
	assert.deepEqual(decodeContextInjectionStateUpdate(queued), { injectionId: "inj-1", state: "queued" });
	const delivered = new Writer().string(1, "inj-2").message(2, new Writer().message(2, new Uint8Array()).finish()).finish();
	assert.deepEqual(decodeContextInjectionStateUpdate(delivered), { injectionId: "inj-2", state: "delivered" });
	const rejected = new Writer().string(1, "inj-3").message(2, new Writer().message(5, new Uint8Array()).finish()).finish();
	assert.deepEqual(decodeContextInjectionStateUpdate(rejected), { injectionId: "inj-3", state: "rejected" });
});

test("buildRunPayload writes run_id when persisted.generationId is set", () => {
	const built = buildRunPayload({
		messages: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] }],
	}, "default", { generationId: "gen-123" });
	const envelope = new Reader(built.payload);
	assert.deepEqual(envelope.tag(), { field: 1, wireType: 2 });
	const request = new Reader(envelope.bytes());
	const fields = [];
	while (!request.done) {
		const tag = request.tag();
		if (tag.field === 25 && tag.wireType === 2) fields.push(request.string());
		else request.skip(tag.wireType);
	}
	assert.deepEqual(fields, ["gen-123"]);
});

test("decodeKvServerMessage preserves setBlobArgs ids and bytes", () => {
	const blobId = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
	const blobData = new Uint8Array([1, 2, 3, 4, 5]);
	const setArgs = new Writer().bytes(1, blobId).bytes(2, blobData).finish();
	const server = new Writer().varint(1, 17).message(3, setArgs).finish();
	const decoded = decodeKvServerMessage(server);
	assert.equal(decoded.id, 17);
	assert.equal(decoded.case, "setBlobArgs");
	assert.deepEqual([...decoded.blobId], [...blobId]);
	assert.deepEqual([...decoded.blobData], [...blobData]);
});

test("decodeUsableModels parses ModelDetails entries", () => {
	const writer = new Writer();
	const model1 = new Writer().string(1, "composer-2").string(3, "composer-2").string(4, "Composer 2").finish();
	const model2 = new Writer().string(1, "gpt-4o").string(4, "GPT-4o").finish();
	writer.message(1, model1);
	writer.message(1, model2);
	const models = decodeUsableModels(writer.finish());
	assert.equal(models.length, 2);
	assert.equal(models[0].id, "composer-2");
	assert.equal(models[0].name, "Composer 2");
	assert.equal(models[1].id, "gpt-4o");
	assert.equal(models[1].name, "GPT-4o");
});

test("decodeMcpArgs parses name, tool call id, and Value args", () => {
	const writer = new Writer();
	writer.string(1, "my-tool");
	for (const [key, value] of Object.entries({ path: "/tmp/a.txt", count: 3, ok: true })) {
		const entry = new Writer().string(1, key).bytes(2, encodeValue(value)).finish();
		writer.message(2, entry); // map<string, bytes>: repeated entry messages
	}
	writer.string(3, "call-123");
	writer.string(5, "my-tool");
	const decoded = decodeMcpArgs(writer.finish());
	assert.equal(decoded.name, "my-tool");
	assert.equal(decoded.toolCallId, "call-123");
	assert.equal(decoded.toolName, "my-tool");
	assert.equal(decodeValue(decoded.args["path"]), "/tmp/a.txt");
	assert.equal(decodeValue(decoded.args["count"]), 3);
	assert.equal(decodeValue(decoded.args["ok"]), true);
});

test("parseTextToolCalls recovers parameter-tag MCP calls", () => {
	const tools = [{
		name: "read",
		parameters: {
			type: "object",
			properties: { file_path: { type: "string" }, limit: { type: "integer" } },
		},
	}];
	const calls = parseTextToolCalls([
		'<tool_call id="mcp_dsh-cursor-agent_read">',
		'<parameter name="file_path">D:\\\\work\\\\a.txt</parameter>',
		'<parameter name="limit">100</parameter>',
		'</tool_call>',
	].join("\n"), tools);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, "read");
	assert.match(calls[0].id, /^text-tool-/);
	assert.deepEqual(JSON.parse(calls[0].arguments), { file_path: "D:\\\\work\\\\a.txt", limit: 100 });
});

test("parseTextToolCalls maps Cursor native aliases and attribute arguments", () => {
	const tools = [
		{ name: "read", parameters: { type: "object", properties: { file_path: { type: "string" }, limit: { type: "integer" } } } },
		{ name: "glob", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } } } },
		{ name: "pwsh", parameters: { type: "object", properties: { command: { type: "string" }, description: { type: "string" } } } },
	];
	const calls = parseTextToolCalls([
		'<tool_call id="Read" path="D:\\\\work\\\\a.txt" limit="25"></tool_call>',
		'<tool_call id="Glob" glob_pattern="*.gd" target_directory="D:\\\\work"></tool_call>',
		'<tool_call id="Shell" command="Write-Output &quot;ok&quot;" description="test"></tool_call>',
	].join("\n"), tools);
	assert.deepEqual(calls.map((call) => call.name), ["read", "glob", "pwsh"]);
	assert.deepEqual(JSON.parse(calls[0].arguments), { limit: 25, file_path: "D:\\\\work\\\\a.txt" });
	assert.deepEqual(JSON.parse(calls[1].arguments), { pattern: "*.gd", path: "D:\\\\work" });
	assert.deepEqual(JSON.parse(calls[2].arguments), { command: 'Write-Output "ok"', description: "test" });
});

test("decodeAgentServerMessage recognizes interaction updates", () => {
	// AgentServerMessage { interaction_update = 1 { text_delta = 1 { text = 1 } } }
	const textDelta = new Writer().string(1, "hello delta").finish();
	const interaction = new Writer().message(1, textDelta).finish();
	const server = new Writer().message(1, interaction).finish();
	const decoded = decodeAgentServerMessage(server);
	assert.equal(decoded.case, "interactionUpdate");
	assert.equal(decoded.value.type, "textDelta");
	assert.equal(decoded.value.text, "hello delta");
});

test("decodeTurnEndedUpdate reads billed token fields", () => {
	const ended = decodeTurnEndedUpdate(new Writer()
		.varint(1, 48_000)
		.varint(2, 800)
		.varint(3, 12_000)
		.varint(4, 256)
		.varint(5, 1_200)
		.finish());
	assert.deepEqual(ended, {
		inputTokens: 48_000,
		outputTokens: 800,
		cacheReadTokens: 12_000,
		cacheWriteTokens: 256,
		reasoningTokens: 1_200,
	});
	const interaction = decodeAgentServerMessage(new Writer()
		.message(1, new Writer().message(14, new Writer().varint(1, 9_001).varint(2, 40).finish()).finish())
		.finish());
	assert.equal(interaction.case, "interactionUpdate");
	assert.equal(interaction.value.type, "turnEnded");
	assert.equal(interaction.value.inputTokens, 9_001);
	assert.equal(interaction.value.outputTokens, 40);
});

test("decodeConversationTokenDetails reads used/max from a checkpoint", () => {
	const details = new Writer().varint(1, 62_400).varint(2, 200_000).finish();
	const checkpoint = new Writer().message(5, details).bytes(3, new TextEncoder().encode("{}")).finish();
	assert.deepEqual(decodeConversationTokenDetails(checkpoint), { usedTokens: 62_400, maxTokens: 200_000 });
	assert.equal(decodeConversationTokenDetails(new Writer().bytes(3, new Uint8Array([1])).finish()), undefined);
});

test("projectCursorTokenUsage prefers token_details.used_tokens for occupancy", () => {
	assert.deepEqual(projectCursorTokenUsage({
		turnEnded: { inputTokens: 48_000, outputTokens: 800, cacheReadTokens: 12_000, cacheWriteTokens: 40_000, reasoningTokens: 90 },
		outputTokens: 10,
		tokenDetails: { usedTokens: 42_400, maxTokens: 200_000 },
	}), {
		inputTokens: 41_600,
		outputTokens: 800,
		reasoningTokens: 90,
		totalTokens: 42_400,
	});
	assert.deepEqual(projectCursorTokenUsage({
		outputTokens: 250,
		tokenDetails: { usedTokens: 62_400, maxTokens: 200_000 },
	}), {
		inputTokens: 62_150,
		outputTokens: 250,
		totalTokens: 62_400,
	});
	assert.deepEqual(projectCursorTokenUsage({
		turnEnded: { inputTokens: 20_000, outputTokens: 400, cacheReadTokens: 5_000, cacheWriteTokens: 20_000 },
	}), {
		inputTokens: 20_000,
		outputTokens: 400,
		cacheReadTokens: 5_000,
		totalTokens: 25_400,
	});
	assert.deepEqual(projectCursorTokenUsage({ outputTokens: 40 }), {
		inputTokens: 0,
		outputTokens: 40,
		totalTokens: 40,
	});
});

test("getTokenExpiry decodes a JWT exp claim", () => {
	const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ exp: 2000000000 })).toString("base64url");
	const token = `${header}.${payload}.signature`;
	assert.equal(getTokenExpiry(token, () => 0), 2000000000 * 1000);
	assert.equal(readJwtExpiry(token), 2000000000 * 1000);
	assert.equal(readJwtExpiry("not-a-jwt"), undefined);
	assert.equal(classifyCursorSecret("crsr_abc"), "api-key");
	assert.equal(classifyCursorSecret("CRSR_ABC"), "api-key");
	assert.equal(classifyCursorSecret(token), "token");
	assert.equal(classifyCursorSecret("opaque-session"), "token");
	assert.equal(classifyCursorSecret("  "), undefined);
});

test("credential store accepts the exact credential shape produced by login()", async () => {
	// Regression: login() previously omitted `type: "oauth"`, which
	// assertOAuthCredential rejects, so the token was never persisted and the
	// coordinator reported "login failed" even though the poll returned 200.
	let stored;
	const credentials = {
		resolve: async () => (stored === undefined ? undefined : { value: stored }),
		set: async (_ref, value) => {
			stored = value;
		},
		unset: async () => {
			stored = undefined;
		},
	};
	const store = new CursorCredentialStore(credentials, CREDENTIAL_REF);
	const credential = {
		type: "oauth",
		access: "access-token",
		refresh: "refresh-token",
		expires: getTokenExpiry("x.y.z"),
	};
	const written = await store.modify(() => credential);
	assert.equal(written.access, "access-token");
	assert.equal(written.refresh, "refresh-token");
	assert.ok(Number.isFinite(written.expires));
	const readBack = await store.read();
	assert.equal(readBack.type, "oauth");
	assert.equal(readBack.access, "access-token");
	// A missing `type` must still be rejected loudly.
	await assert.rejects(
		store.modify(() => ({ access: "a", refresh: "r", expires: 1 })),
		/Cursor credential store received a malformed Cursor credential/,
	);
});

test("credential store accepts the api-key credential shape and rejects a keyless one", async () => {
	let stored;
	const credentials = {
		resolve: async () => (stored === undefined ? undefined : { value: stored }),
		set: async (_ref, value) => {
			stored = value;
		},
		unset: async () => {
			stored = undefined;
		},
	};
	const store = new CursorCredentialStore(credentials, CREDENTIAL_REF);
	const credential = {
		type: "api-key",
		apiKey: "cursor-key-123",
		access: "access-token",
		refresh: "",
		expires: getTokenExpiry("x.y.z"),
	};
	const written = await store.modify(() => credential);
	assert.equal(written.type, "api-key");
	assert.equal(written.apiKey, "cursor-key-123");
	assert.equal(written.refresh, "");
	const readBack = await store.read();
	assert.equal(readBack.type, "api-key");
	// An api-key credential without the key must be rejected.
	await assert.rejects(
		store.modify(() => ({ type: "api-key", access: "a", refresh: "r", expires: 1 })),
		/Cursor credential store received a malformed Cursor credential/,
	);
});

test("maskApiKey only exposes the first 7 and last 2 characters", () => {
	assert.equal(maskApiKey("cursor-key-1234567890"), "cursor-…90");
	assert.equal(maskApiKey("shortkey"), "sh…y");
	assert.equal(maskApiKey(""), undefined);
	assert.equal(maskApiKey(undefined), undefined);
});

test("decodeCurrentPeriodUsage reads plan, spend limit, and billing fields", () => {
	const plan = new Writer();
	plan.varint(1, 2000); // totalSpend cents
	plan.varint(2, 1500); // includedSpend
	plan.varint(6, 1); // remainingBonus (BOOL)
	plan.varint(8, 800); // autoSpend
	plan.varint(10, 2000); // autoLimit
	plan.varint(9, 1200); // apiSpend
	plan.varint(11, 2000); // apiLimit
	plan.double(12, 23.17); // autoPercentUsed (double on the wire)
	plan.varint(13, 100); // apiPercentUsed
	const spend = new Writer();
	spend.varint(1, 3000); // totalSpend
	spend.varint(2, 5000); // pooledLimit
	spend.varint(3, 1200); // pooledUsed
	spend.varint(4, 3800); // pooledRemaining
	spend.varint(5, 2000); // individualLimit
	spend.varint(6, 999); // individualUsed
	spend.varint(7, 1001); // individualRemaining
	spend.string(8, "user"); // limitType
	spend.varint(9, 6000); // overallLimit
	const message = new Writer();
	message.varint(1, 1750000000); // billingCycleStart (epoch seconds)
	message.varint(2, 1752675200); // billingCycleEnd
	message.message(3, plan.finish());
	message.message(4, spend.finish());
	message.varint(6, 1); // enabled
	message.string(7, "You've used 40% of your included API usage");

	const decoded = decodeCurrentPeriodUsage(message.finish());
	assert.equal(decoded.billingCycleStart, 1750000000 * 1000);
	assert.equal(decoded.billingCycleEnd, 1752675200 * 1000);
	assert.equal(decoded.enabled, true);
	assert.equal(decoded.displayMessage, "You've used 40% of your included API usage");
	assert.equal(decoded.planUsage.totalSpend, 2000);
	assert.equal(decoded.planUsage.remainingBonus, true);
	assert.equal(decoded.planUsage.autoSpend, 800);
	assert.equal(decoded.planUsage.autoPercentUsed, 23.17);
	assert.equal(decoded.planUsage.apiPercentUsed, 100);
	assert.equal(decoded.spendLimitUsage.pooledUsed, 1200);
	assert.equal(decoded.spendLimitUsage.individualUsed, 999);
	assert.equal(decoded.spendLimitUsage.individualRemaining, 1001);
	assert.equal(decoded.spendLimitUsage.limitType, "user");
	assert.equal(decoded.spendLimitUsage.overallLimit, 6000);
});

test("projectCurrentPeriodUsage converts cents to dollars and normalizes percents", () => {
	// `remaining` is intentionally omitted: protojson drops zero values, and
	// the projection must fall back to limit - includedSpend.
	const projected = projectCurrentPeriodUsage({
		billingCycleStart: "2026-07-20T00:00:00.000Z",
		billingCycleEnd: "2026-08-20T00:00:00.000Z",
		enabled: true,
		displayMessage: "msg",
		planUsage: {
			totalSpend: 2000,
			includedSpend: 1500,
			bonusSpend: 250,
			limit: 2000,
			remainingBonus: false,
			autoSpend: 800,
			autoLimit: 2000,
			apiSpend: 1200,
			apiLimit: 2000,
			autoPercentUsed: 40.05,
			apiPercentUsed: 60,
			totalPercentUsed: 55.555,
		},
		spendLimitUsage: {
			individualUsed: 999,
			individualLimit: 2000,
			individualRemaining: 1001,
			limitType: "user",
			pooledUsed: 1200,
			pooledLimit: 5000,
			pooledRemaining: 3800,
			totalSpend: 3000,
			overallLimit: 6000,
			overallUsed: 500,
		},
	});
	assert.equal(projected.billingCycleStart, new Date("2026-07-20T00:00:00.000Z").getTime());
	assert.equal(projected.plan.totalSpend, 20);
	assert.equal(projected.plan.includedSpend, 15);
	assert.equal(projected.plan.bonusSpend, 2.5);
	assert.equal(projected.plan.remaining, 5); // fallback: 2000 - 1500 cents
	assert.equal(projected.plan.remainingBonus, false);
	assert.equal(projected.plan.autoSpend, 8);
	assert.equal(projected.plan.apiLimit, 20);
	assert.equal(projected.plan.autoPercentUsed, 40.1);
	assert.equal(projected.plan.apiPercentUsed, 60);
	assert.equal(projected.plan.totalPercentUsed, 55.6);
	assert.equal(projected.spendLimit.individualUsed, 9.99);
	assert.equal(projected.spendLimit.individualRemaining, 10.01);
	assert.equal(projected.spendLimit.limitType, "user");
	assert.equal(projected.spendLimit.pooledLimit, 50);
	assert.equal(projected.spendLimit.totalSpend, 30);
	assert.equal(projected.spendLimit.overallLimit, 60);
	assert.equal(projected.spendLimit.overallUsed, 5);
});

test("decodeSandUsageStatus reads timestamps, percent, and the Grok none state", () => {
	const timestamp = (seconds) => {
		const writer = new Writer();
		writer.varint(1, seconds);
		return writer.finish();
	};
	const message = new Writer();
	message.message(1, timestamp(1750000000));
	message.message(2, timestamp(1752675200));
	message.double(3, 42.5); // usagePercent
	message.varint(7, 0); // hasAvailableUsage: false -> the "None" case
	message.varint(8, 1);
	message.varint(5, 2); // availableBankedResetCount

	const decoded = decodeSandUsageStatus(message.finish());
	assert.equal(decoded.usagePercent, 42.5);
	assert.equal(decoded.hasAvailableUsage, false);
	assert.equal(decoded.hasNonZeroIncludedLimit, true);
	assert.equal(decoded.availableBankedResetCount, "2");
	const projected = projectSandUsageStatus(decoded);
	assert.equal(projected.usagePercent, 42.5);
	assert.equal(projected.currentPeriodStart, 1750000000 * 1000);
	assert.equal(projected.nextReset, 1752675200 * 1000);
	assert.equal(projected.hasAvailableUsage, false);
});

test("decodeGetMe and decodeGetPlanInfo extract email and plan name", () => {
	const me = new Writer();
	me.string(3, "user@example.com");
	assert.deepEqual(decodeGetMe(me.finish()), { email: "user@example.com" });
	assert.deepEqual(projectGetMe(decodeGetMe(me.finish())), { email: "user@example.com" });

	const inner = new Writer();
	inner.string(1, "Pro");
	const outer = new Writer();
	outer.message(1, inner.finish());
	assert.deepEqual(decodeGetPlanInfo(outer.finish()), { planInfo: { planName: "Pro" } });
	assert.deepEqual(projectGetPlanInfo({ planInfo: { planName: "Pro" } }), { planName: "Pro" });
});

test("callDashboardRpc prefers JSON and falls back to protobuf framing on 415", async () => {
	const payload = new Writer().string(1, "hello").finish();
	const calls = [];
	const fetchImpl = async (_url, init) => {
		calls.push(init.headers["content-type"]);
		if (init.headers["content-type"] === "application/json") {
			return new Response("unsupported", { status: 415 });
		}
		return new Response(frameEncode(payload), { status: 200, headers: { "content-type": "application/proto" } });
	};
	const result = await callDashboardRpc(fetchImpl, "https://api2.cursor.sh/rpc", "token");
	assert.deepEqual(calls, ["application/json", "application/proto"]);
	assert.deepEqual([...result.bytes], [...payload]);
});

test("CursorUsageReader reads usage from DashboardService RPCs", async () => {
	const auth = {
		credential: async () => ({ access: "access-token", refresh: "r", expires: Date.now() + 1e6 }),
	};
	const seen = [];
	const fetchImpl = async (url, init) => {
		seen.push({ url: String(url), authorization: init?.headers?.authorization });
		const href = String(url);
		let body;
		if (href.endsWith("/GetCurrentPeriodUsage")) {
			// Real plan-account shape: percents but no auto/api dollar fields.
			body = {
				billingCycleStart: "2026-07-20T00:00:00.000Z",
				billingCycleEnd: "2026-08-20T00:00:00.000Z",
				enabled: true,
				planUsage: { totalSpend: 2000, includedSpend: 1500, limit: 2000, autoPercentUsed: 83.9, apiPercentUsed: 100 },
				spendLimitUsage: { individualLimit: 2000, individualUsed: 0, individualRemaining: 2000, limitType: "user" },
			};
		} else if (href.endsWith("/GetMe")) {
			body = { email: "user@example.com" };
		} else if (href.endsWith("/GetPlanInfo")) {
			body = { planInfo: { planName: "Pro" } };
		} else if (href.endsWith("/GetSandUsageStatus")) {
			body = { usagePercent: 42.5, hasAvailableUsage: true, nextResetTimestampUtc: "2026-08-20T00:00:00.000Z" };
		}
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	};
	const reader = new CursorUsageReader(auth, { fetch: fetchImpl, now: () => 1787000000000 });
	const usage = await reader.read();
	assert.equal(usage.email, "user@example.com");
	assert.equal(usage.planName, "Pro");
	assert.equal(usage.plan.autoSpend, undefined); // omitted for plan accounts
	assert.equal(usage.plan.autoPercentUsed, 83.9);
	assert.equal(usage.plan.apiPercentUsed, 100);
	assert.equal(usage.plan.remaining, 5); // fallback: 20.00 - 15.00
	assert.equal(usage.spendLimit.individualLimit, 20);
	assert.equal(usage.spendLimit.limitType, "user");
	assert.equal(usage.grok.usagePercent, 42.5);
	assert.equal(usage.grok.hasAvailableUsage, true);
	assert.equal(usage.billingCycle.daysLeft, 3);
	for (const entry of seen) assert.equal(entry.authorization, "Bearer access-token");
	assert.equal(seen.length, 4);
	// The successful read is cached.
	seen.length = 0;
	const again = await reader.read();
	assert.equal(again.email, "user@example.com");
	assert.equal(seen.length, 0);
});

test("CursorUsageReader tolerates the empty enterprise usage-based shell", async () => {
	// Real enterprise usage-based response: only billing timestamps and a
	// display threshold — no planUsage, no spendLimitUsage, no enabled.
	const auth = {
		credential: async () => ({ access: "a", refresh: "r", expires: Date.now() + 1e6 }),
	};
	const fetchImpl = async (url) => {
		const href = String(url);
		const body = href.endsWith("/GetCurrentPeriodUsage")
			? { billingCycleStart: "1788759388806", billingCycleEnd: "1788759388806", displayThreshold: 100 }
			: {};
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	};
	const usage = await new CursorUsageReader(auth, { fetch: fetchImpl, now: () => 1788759388806 }).read();
	assert.equal(usage.plan, undefined);
	assert.equal(usage.spendLimit, undefined);
	assert.equal(usage.billingCycle.start, 1788759388806);
	assert.equal(usage.billingCycle.daysLeft, 0);
});

test("CursorUsageReader hides the Grok card for accounts without Grok", async () => {
	const auth = {
		credential: async () => ({ access: "a", refresh: "r", expires: Date.now() + 1e6 }),
	};
	const fetchImpl = async (url) => {
		const href = String(url);
		const body = href.endsWith("/GetSandUsageStatus")
			? { hasAvailableUsage: false }
			: href.endsWith("/GetCurrentPeriodUsage")
				? { planUsage: {} }
				: {};
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	};
	const usage = await new CursorUsageReader(auth, { fetch: fetchImpl }).read();
	assert.equal(usage.grok, undefined);
});

test("CursorUsageReader surfaces HTTP status when the usage RPC fails", async () => {
	const auth = {
		credential: async () => ({ access: "a", refresh: "r", expires: Date.now() + 1e6 }),
	};
	const fetchImpl = async (url) => {
		const href = String(url);
		if (href.endsWith("/GetCurrentPeriodUsage")) return new Response("nope", { status: 401 });
		return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
	};
	await assert.rejects(
		() => new CursorUsageReader(auth, { fetch: fetchImpl }).read(),
		/HTTP 401/,
	);
});

test("CursorAuthService loginWithApiKey exchanges the key with local-cli-mode", async () => {
	let stored;
	const credentials = {
		resolve: async () => (stored === undefined ? undefined : { value: stored }),
		set: async (_ref, value) => {
			stored = value;
		},
		unset: async () => {
			stored = undefined;
		},
	};
	const store = new CursorCredentialStore(credentials, CREDENTIAL_REF);
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url: String(url), headers: init.headers });
		return new Response(JSON.stringify({ accessToken: "at-1", refreshToken: "rt-1" }), { status: 200 });
	};
	const auth = new CursorAuthService(store, { fetch: fetchImpl, now: () => 1787000000000 });
	const status = await auth.loginWithApiKey("cursor-key-123");
	assert.equal(status.authenticated, true);
	assert.equal(status.method, "api-key");
	assert.equal(status.type, "api-key");
	assert.equal(status.apiKeyLabel, maskApiKey("cursor-key-123"));
	assert.equal(calls.length, 1);
	assert.ok(calls[0].url.endsWith("/auth/exchange_user_api_key"));
	assert.equal(calls[0].headers.authorization, "Bearer cursor-key-123");
	assert.equal(calls[0].headers["local-cli-mode"], "true");
	const readBack = await store.read();
	assert.equal(readBack.type, "api-key");
	assert.equal(readBack.apiKey, "cursor-key-123");
	assert.equal(readBack.access, "at-1");
	assert.equal(readBack.refresh, "rt-1");
	assert.equal(calls[0].url, `${CURSOR_BASE_URL}/auth/exchange_user_api_key`);
});

test("CursorAuthService loginWithSecret treats crsr_* as an API key and other values as tokens", async () => {
	let stored;
	const credentials = {
		resolve: async () => (stored === undefined ? undefined : { value: stored }),
		set: async (_ref, value) => {
			stored = value;
		},
		unset: async () => {
			stored = undefined;
		},
	};
	const store = new CursorCredentialStore(credentials, CREDENTIAL_REF);
	const fetchImpl = async () => new Response(JSON.stringify({ accessToken: "at-1", refreshToken: "rt-1" }), { status: 200 });
	const auth = new CursorAuthService(store, { fetch: fetchImpl, now: () => 1787000000000 });
	const keyStatus = await auth.loginWithSecret("crsr_47abcdef9f");
	assert.equal(keyStatus.method, "api-key");
	assert.equal(keyStatus.apiKeyLabel, maskApiKey("crsr_47abcdef9f"));
	assert.equal((await store.read()).type, "api-key");

	const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ exp: 2000000000 })).toString("base64url");
	const jwt = `${header}.${payload}.signature`;
	const jwtStatus = await auth.loginWithSecret(jwt);
	assert.equal(jwtStatus.method, "token");
	assert.equal(jwtStatus.expiresAt, 2000000000 * 1000);
	assert.equal(jwtStatus.tokenLabel, maskApiKey(jwt));
	assert.equal((await store.read()).type, "token");
	assert.equal((await store.read()).access, jwt);

	const opaqueStatus = await auth.loginWithSecret("session-opaque-token");
	assert.equal(opaqueStatus.method, "token");
	assert.equal(opaqueStatus.expiresAt, undefined);
	assert.equal((await auth.credential()).access, "session-opaque-token");
});

test("CursorAuthService token exchange uses the configured API base URL", async () => {
	let stored;
	const credentials = {
		resolve: async () => (stored === undefined ? undefined : { value: stored }),
		set: async (_ref, value) => {
			stored = value;
		},
		unset: async () => {
			stored = undefined;
		},
	};
	const store = new CursorCredentialStore(credentials, CREDENTIAL_REF);
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url: String(url), headers: init.headers });
		return new Response(JSON.stringify({ accessToken: "at-1", refreshToken: "rt-1" }), { status: 200 });
	};
	const auth = new CursorAuthService(store, {
		fetch: fetchImpl,
		now: () => 1787000000000,
		resolveBaseUrl: () => "https://cursor-api.example.test",
	});
	await auth.loginWithApiKey("cursor-key-123");
	assert.equal(calls[0].url, "https://cursor-api.example.test/auth/exchange_user_api_key");
});

test("CursorAuthService loginWithApiKey rejects an invalid key", async () => {
	let stored;
	const credentials = {
		resolve: async () => (stored === undefined ? undefined : { value: stored }),
		set: async (_ref, value) => {
			stored = value;
		},
		unset: async () => {
			stored = undefined;
		},
	};
	const store = new CursorCredentialStore(credentials, CREDENTIAL_REF);
	const fetchImpl = async () => new Response("no", { status: 401 });
	const auth = new CursorAuthService(store, { fetch: fetchImpl });
	await assert.rejects(
		() => auth.loginWithApiKey("bad-key"),
		(error) => error.code === "INVALID_CREDENTIAL" && /invalid/.test(error.message),
	);
});

test("CursorAuthService refreshes an api-key credential by exchanging the key again", async () => {
	let stored = JSON.stringify({
		type: "api-key",
		apiKey: "cursor-key-123",
		access: "at-old",
		refresh: "rt-ignored",
		expires: 1787000000000 - 1000,
	});
	const credentials = {
		resolve: async () => (stored === undefined ? undefined : { value: stored }),
		set: async (_ref, value) => {
			stored = value;
		},
		unset: async () => {
			stored = undefined;
		},
	};
	const store = new CursorCredentialStore(credentials, CREDENTIAL_REF);
	const calls = [];
	const fetchImpl = async (_url, init) => {
		calls.push(init.headers.authorization);
		return new Response(JSON.stringify({ accessToken: "at-new" }), { status: 200 });
	};
	const auth = new CursorAuthService(store, { fetch: fetchImpl, now: () => 1787000000000 });
	const credential = await auth.credential();
	assert.equal(credential.access, "at-new");
	// The exchange used the api key — never the stored refresh token.
	assert.deepEqual(calls, ["Bearer cursor-key-123"]);
	const readBack = await store.read();
	assert.equal(readBack.type, "api-key");
	assert.equal(readBack.apiKey, "cursor-key-123");
	assert.equal(readBack.access, "at-new");
});

test("Cursor RPC login/apikey returns the status without exposing the key", async () => {
	const auth = {
		loginWithSecret: async (secret) => {
			assert.equal(secret.trim(), "cursor-key-123");
			return { authenticated: true, method: "token", tokenLabel: "cursor…23" };
		},
	};
	const coordinator = {};
	const usageReader = { clear: () => undefined };
	const handler = createCursorRpcHandler(coordinator, {
		auth,
		usageReader,
		settings: { read: () => ({}) },
		modelsProvider: { listModelsForRpc: async () => [] },
	});
	const result = await handler("login/apikey", { apiKey: "  cursor-key-123  " }, new AbortController().signal);
	assert.equal(result.ok, true);
	assert.equal(result.value.method, "token");
	assert.equal(result.value.tokenLabel, "cursor…23");
	const empty = await handler("login/apikey", { apiKey: "   " }, new AbortController().signal);
	assert.equal(empty.ok, false);
	assert.equal(empty.error.code, "bad-request");
});

test("createCursorRpcHttpHandler serves POST /cursor-agent/settings", async () => {
	const http = createCursorRpcHttpHandler(async (endpoint, payload) => {
		assert.equal(endpoint, "settings");
		assert.deepEqual(payload, {});
		return { ok: true, value: { revision: 1, maxToolRounds: 64 } };
	});
	const result = await invokeCursorRpcHttp(http, {
		method: "POST",
		url: "/cursor-agent/settings",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ type: "client-request", rpcId: "rpc-1", method: "settings", payload: {} }),
	});
	assert.equal(result.status, 200);
	assert.deepEqual(JSON.parse(result.body), {
		type: "server-response",
		rpcId: "rpc-1",
		result: { ok: true, value: { revision: 1, maxToolRounds: 64 } },
	});
});

test("createCursorRpcHttpHandler rejects GET so the prefix owns POST", async () => {
	const http = createCursorRpcHttpHandler(async () => ({ ok: true, value: null }));
	const result = await invokeCursorRpcHttp(http, { method: "GET", url: "/cursor-agent/settings", headers: {} });
	assert.equal(result.status, 405);
	assert.equal(result.headers.allow, "POST");
});

async function invokeCursorRpcHttp(handler, { method, url, headers, body = "" }) {
	const chunks = body.length > 0 ? [Buffer.from(body)] : [];
	const req = {
		method,
		url,
		headers,
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield chunk;
		},
	};
	let status = 0;
	let responseHeaders = {};
	const parts = [];
	const res = {
		writableEnded: false,
		writeHead(code, header) {
			status = code;
			responseHeaders = header ?? {};
		},
		end(chunk) {
			this.writableEnded = true;
			if (chunk !== undefined) parts.push(Buffer.from(chunk));
		},
		on() {},
	};
	await handler(req, res);
	return { status, headers: responseHeaders, body: Buffer.concat(parts).toString("utf8") };
}

test("parseEndStream extracts the real Cursor error and classifies quota exhaustion", () => {
	// Real end-stream payload captured from the live agent Run endpoint when the
	// team spend limit is hit.
	const payload = Buffer.from(
		JSON.stringify({
			error: {
				code: "resource_exhausted",
				message: "Error",
				details: [
					{
						type: "aiserver.v1.ErrorDetails",
						debug: {
							error: "ERROR_RATE_LIMITED_CHANGEABLE",
							details: {
								title: "Your team has reached its usage limit",
								detail: "Please reach out to an admin to increase your limit, or return on 8/20/2026 when your usage resets.",
							},
						},
					},
				],
			},
		}),
	);
	const end = parseEndStream(payload);
	assert.equal(end.code, "resource_exhausted");
	assert.equal(end.debugCode, "ERROR_RATE_LIMITED_CHANGEABLE");
	assert.ok(end.message.includes("Your team has reached its usage limit"));
	assert.ok(end.message.includes("return on 8/20/2026"));
	assert.equal(classifyCursorError(`${end.code} ${end.debugCode} ${end.message}`), "RATE_LIMIT");
	assert.equal(classifyCursorError("Cursor agent returned HTTP 408"), "TIMEOUT");
	// A non-error end-stream payload is a clean stop.
	assert.equal(parseEndStream(Buffer.from("{}")), undefined);
	assert.equal(parseEndStream(Buffer.from("not json")), undefined);
});

test("encodeMcpResult encodes text and is_error for bridge continuation", () => {
	const result = new Reader(encodeMcpResult({ content: "tool output", isError: true }));
	assert.deepEqual(result.tag(), { field: 1, wireType: 2 });
	const success = new Reader(result.bytes());
	assert.deepEqual(success.tag(), { field: 1, wireType: 2 });
	const item = new Reader(success.bytes());
	assert.deepEqual(item.tag(), { field: 1, wireType: 2 });
	const text = new Reader(item.bytes());
	assert.deepEqual(text.tag(), { field: 1, wireType: 2 });
	assert.equal(text.string(), "tool output");
	assert.deepEqual(success.tag(), { field: 2, wireType: 0 });
	assert.equal(success.varint(), 1);
});

test("encodeSetBlobResult acks a server blob write", () => {
	// KvClientMessage { id = 1 (varint 3), set_blob_result = 3 (empty message) }
	assert.deepEqual([...encodeSetBlobResult(3)], [8, 3, 26, 0]);
});

test("encodeGetBlobResult omits blob_data on a miss and carries bytes on a hit", () => {
	// Miss: KvClientMessage { id=1, get_blob_result=2 {} } — no field 1 inside.
	// A 0-byte blob_data field looks like a hit and stalls the server.
	const miss = encodeGetBlobResult(7);
	assert.deepEqual([...miss], [8, 7, 18, 0]);
	const payload = new Uint8Array([1, 2, 3]);
	const hit = new Reader(encodeGetBlobResult(7, payload));
	assert.deepEqual(hit.tag(), { field: 1, wireType: 0 });
	assert.equal(hit.varint(), 7);
	assert.deepEqual(hit.tag(), { field: 2, wireType: 2 });
	const result = new Reader(hit.bytes());
	assert.deepEqual(result.tag(), { field: 1, wireType: 2 });
	assert.deepEqual([...result.bytes()], [1, 2, 3]);
});

test("adoptBlobStore folds request-time blobs into the session map", () => {
	const session = new Map([["a", new Uint8Array([1])]]);
	const request = new Map([["b", new Uint8Array([2])], ["a", new Uint8Array([9])]]);
	const unified = adoptBlobStore(session, request);
	assert.equal(unified, session);
	assert.deepEqual([...unified.get("a")], [9]);
	assert.deepEqual([...unified.get("b")], [2]);
	assert.equal(adoptBlobStore(session, session), session);
	assert.equal(adoptBlobStore(undefined, undefined).size, 0);
});

test("partitionPendingExecs leaves unanswered execs leftover instead of fake-failing them", () => {
	const pending = [
		{ id: 1, kind: "exec", toolCallId: "read-1" },
		{ id: 2, kind: "shell", toolCallId: "bash-1" },
		{ id: 3, kind: "mcp", toolCallId: "mcp-1" },
		{ id: 4, kind: "bgshell", toolCallId: "bg-1" },
	];
	const { ready, leftover } = partitionPendingExecs(pending, [
		{ toolCallId: "read-1", content: "ok", isError: false },
		{ toolCallId: "mcp-1", content: "done", isError: false },
	]);
	assert.deepEqual(ready.map((entry) => entry.pending.id), [1, 3]);
	assert.deepEqual(leftover.map((entry) => entry.kind), ["shell", "bgshell"]);
	assert.equal(partitionPendingExecs(pending, []).leftover.length, 4);
	assert.equal(partitionPendingExecs([], [{ toolCallId: "x" }]).ready.length, 0);
	const joins = partitionPendingExecs(
		[{ kind: "join", toolCallId: "j1" }, { kind: "mcp", toolCallId: "m1" }],
		[{ toolCallId: "j1", content: "ok", isError: false }],
	);
	assert.equal(joins.ready[0].pending.kind, "join");
	assert.equal(joins.leftover[0].kind, "mcp");
});

test("AgentRun abort rejects a pending HTTP response wait immediately", async () => {
	const server = http2.createServer();
	server.on("stream", (stream) => stream.on("error", () => {}));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		const run = new AgentRun("test-token", { baseUrl: `http://127.0.0.1:${address.port}` });
		await run.start();
		assert.equal(run.writeMessage(new Uint8Array([1])), true);
		const waiting = run.waitForResponse(10_000);
		const cancelled = new Error("test cancellation");
		run.abort(cancelled);
		await assert.rejects(waiting, /test cancellation/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("Cursor Agent response requires HTTP 200 Connect protobuf", () => {
	assert.equal(isSuccessfulAgentResponse(200, "application/connect+proto"), true);
	assert.equal(isSuccessfulAgentResponse(200, "application/connect+proto; charset=binary"), true);
	assert.equal(isSuccessfulAgentResponse(201, "application/connect+proto"), false);
	assert.equal(isSuccessfulAgentResponse(204, "application/connect+proto"), false);
	assert.equal(isSuccessfulAgentResponse(200, "application/json"), false);
	assert.equal(isSuccessfulAgentResponse(200, undefined), false);
});

test("Cursor runtime settings validate retry and tool limits", () => {
	const defaults = resolveCursorSettings();
	assert.equal(defaults.maxToolRounds, 1000);
	assert.equal(defaults.apiBaseUrl, CURSOR_BASE_URL);
	assert.equal(defaults.retryCount, 0);
	assert.equal(defaults.retryIntervalMs, 1000);
	assert.deepEqual(defaults.retryHttpStatusCodes, [408, 425, 429, 500, 502, 503, 504]);
	const custom = resolveCursorSettings({
		maxToolRounds: 17,
		apiBaseUrl: "https://proxy.example.test/cursor/",
		retryCount: 3,
		retryIntervalMs: 250,
		retryHttpStatusCodes: [429, 503],
	});
	assert.equal(custom.apiBaseUrl, "https://proxy.example.test/cursor");
	assert.equal(shouldRetryHttpStatus(503, 2, custom), true);
	assert.equal(shouldRetryHttpStatus(503, 3, custom), false);
	assert.equal(shouldRetryHttpStatus(500, 0, custom), false);
	assert.throws(() => resolveCursorSettings({ retryHttpStatusCodes: [500, 500] }), /duplicates/);
	assert.throws(() => resolveCursorSettings({ maxToolRounds: 0 }), /maxToolRounds/);
	assert.throws(() => resolveCursorSettings({ retryCount: 11 }), /retryCount/);
	assert.throws(() => resolveCursorSettings({ apiBaseUrl: "not-a-url" }), /apiBaseUrl/);
	assert.throws(() => resolveCursorSettings({ apiBaseUrl: "ftp://api2.cursor.sh" }), /apiBaseUrl/);
	assert.equal(resolveCursorApiBaseUrl(""), CURSOR_BASE_URL);
	assert.equal(resolveCursorApiBaseUrl("https://api2.cursor.sh/"), CURSOR_BASE_URL);
});

test("Cursor adapter retries configured pre-output HTTP statuses", async () => {
	const statuses = [503, 200];
	const created = [];
	const delays = [];
	class FakeRun {
		constructor(status) {
			this.status = status;
			this.responseContentType = "application/connect+proto";
			this.finished = false;
			this.stream = { destroyed: false };
			this.frames = {
				next: async () => this.frameTaken++ === 0
					? { flags: CONNECT_END_STREAM_FLAG, payload: Buffer.from("{}") }
					: undefined,
			};
			this.frameTaken = 0;
		}
		async start() {}
		writeMessage() { return true; }
		async waitForResponse() { return this.status; }
		startHeartbeat() {}
		abort() { this.close(); }
		close() { this.finished = true; this.stream.destroyed = true; }
	}
	const adapter = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings({ retryCount: 2, retryIntervalMs: 1234, retryHttpStatusCodes: [503] }),
		createAgentRun: () => {
			const run = new FakeRun(statuses[created.length]);
			created.push(run);
			return run;
		},
		sleep: async (ms) => delays.push(ms),
	});
	const chunks = [];
	for await (const chunk of adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "retry-test",
		messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
	})) chunks.push(chunk);
	assert.equal(created.length, 2);
	assert.deepEqual(delays, [1234]);
	assert.equal(chunks.at(-1).type, "finish");
	assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
});

test("Cursor adapter stalls when the server only sends heartbeats", async () => {
	// AgentServerMessage { interaction_update = 1 } -> InteractionUpdate { heartbeat = 13 }
	const heartbeatAgentFrame = new Writer()
		.message(1, new Writer().message(13, new Uint8Array(0)).finish())
		.finish();
	let failed;
	let run;
	const frames = {
		next: async () => {
			if (failed !== undefined) throw failed;
			await new Promise((resolve) => setTimeout(resolve, 10));
			return { flags: 0, payload: heartbeatAgentFrame };
		},
		fail: (error) => {
			failed = error;
		},
		ended: false,
		finish: () => {},
	};
	class StalledRun {
		constructor() {
			this.finished = false;
			this.stream = { destroyed: false };
			this.responseContentType = "application/connect+proto";
		}
		async start() {}
		writeMessage() { return true; }
		async waitForResponse() { return 200; }
		startHeartbeat() {}
		abort(error) { this.frames.fail(error); this.close(); }
		close() { this.finished = true; this.stream.destroyed = true; }
	}
	run = new StalledRun();
	run.frames = frames;
	const adapter = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		createAgentRun: () => run,
		progressTimeoutMs: 80,
		idleCheckIntervalMs: 25,
	});
	const chunks = [];
	for await (const chunk of adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "stall-test",
		messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
	})) chunks.push(chunk);
	const finish = chunks.at(-1);
	assert.equal(finish.type, "finish");
	assert.equal(finish.reason.kind, "error");
	assert.equal(finish.reason.failure.code, "TIMEOUT");
	assert.match(finish.reason.failure.message, /progress timeout/);
});

test("Cursor settings RPC reads and updates only public runtime fields", async () => {
	let current = resolveCursorSettings();
	let revision = 4;
	const handler = createCursorRpcHandler({}, {
		settings: {
			read: () => ({ ...current, revision }),
			update: async (patch, expectedRevision) => {
				assert.equal(expectedRevision, revision);
				current = resolveCursorSettings({ ...current, ...patch });
				revision++;
				return { ...current, revision };
			},
		},
	});
	const signal = new AbortController().signal;
	const read = await handler("settings", {}, signal);
	assert.equal(read.ok, true);
	assert.equal(read.value.maxToolRounds, 1000);
	assert.equal(read.value.apiBaseUrl, CURSOR_BASE_URL);
	assert.equal(read.value.revision, 4);
	const updated = await handler("settings/update", {
		revision: 4,
		maxToolRounds: 25,
		apiBaseUrl: "https://cursor-api.example.test",
		retryCount: 1,
		retryIntervalMs: 10,
		retryHttpStatusCodes: [429, 503],
		accessToken: "must-not-pass-through",
	}, signal);
	assert.equal(updated.ok, true);
	assert.deepEqual(updated.value, {
		maxToolRounds: 25,
		apiBaseUrl: "https://cursor-api.example.test",
		retryCount: 1,
		retryIntervalMs: 10,
		retryHttpStatusCodes: [429, 503],
		requireCursorPreset: true,
		parkedBridgeTimeoutMs: 600000,
		revision: 5,
	});
});

//#region run pump / late-answer machinery

import {
	CursorRunPump,
	storeBlob,
	encodeAsyncAskQuestionCompletionAction,
	encodeMcpToolCallStep,
	encodeReplayTurnBlob,
	appendTurnsToCheckpoint,
	encodeResumeAction,
} from "../src/index";

/** A minimal AgentRun stand-in feeding a fixed frame queue through a ConnectFrameReader. */
function fakeRun(frameBytes = [], { endFrames = frameBytes.length === 0 } = {}) {
	const run = {
		finished: false,
		responseStatus: 200,
		responseContentType: "application/connect+proto",
		trailers: {},
		writes: [],
		stream: { destroyed: false, once: () => {} },
		frames: new ConnectFrameReader(),
		async start() {},
		write(payload) {
			this.writes.push(Uint8Array.from(payload));
			return true;
		},
		writeMessage(bytes) {
			return this.write(frameEncode(bytes));
		},
		async waitForResponse() {
			return 200;
		},
		startHeartbeat() {},
		abort(error) {
			this.frames.fail(error);
			this.close();
		},
		close() {
			this.finished = true;
			this.stream.destroyed = true;
			if (!this.frames.ended) this.frames.finish();
		},
	};
	for (const frame of frameBytes) run.frames.push(frame);
	if (endFrames) run.frames.finish();
	return run;
}

/** Pull every event out of an async generator into an array. */
async function drainStream(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return chunks;
}

function titleAdapter(overrides = {}) {
	return new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		createAgentRun: () => {
			throw new Error("session-title must not open AgentService/Run");
		},
		...overrides,
	});
}

/** Strip the Connect frame envelope (flags + u32 length) from a written frame. */
function framePayloadOf(write) {
	const length = new DataView(write.buffer, write.byteOffset + 1, 4).getUint32(0, false);
	return write.subarray(5, 5 + length);
}

/** Read the one AgentClientMessage.run_request payload out of a frame-encoded write. */
function runRequestOf(write) {
	const envelope = new Reader(framePayloadOf(write));
	let runRequest;
	while (!envelope.done) {
		const { field, wireType } = envelope.tag();
		if (field === 1 && wireType === 2) runRequest = envelope.bytes();
		else envelope.skip(wireType);
	}
	assert.ok(runRequest !== undefined, "write carries a run_request");
	return runRequest;
}

/** Read a specific field's raw bytes from a message. */
function fieldBytesOf(bytes, wanted) {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === wanted && wireType === 2) return reader.bytes();
		reader.skip(wireType);
	}
	return undefined;
}

function fieldStringOf(bytes, wanted) {
	const raw = fieldBytesOf(bytes, wanted);
	return raw === undefined ? undefined : new TextDecoder().decode(raw);
}

test("storeBlob keys blobs by SHA-256 and the pump serves them back", () => {
	const store = new Map();
	const data = new TextEncoder().encode("replayed turn");
	const id = storeBlob(store, data);
	assert.equal(store.get(Buffer.from(id).toString("hex"))[0], data[0]);
	assert.equal(store.size, 1);
});

test("encodeAsyncAskQuestionCompletionAction carries id, args, result", () => {
	const args = new Writer().string(1, "Pick one").finish();
	const result = new Writer().message(1, new Uint8Array(0)).finish();
	const action = encodeAsyncAskQuestionCompletionAction({
		originalToolCallId: "qc-1",
		originalArgsBytes: args,
		resultBytes: result,
	});
	// ConversationAction { async_ask_question_completion_action = 8 }
	const completion = fieldBytesOf(action, 8);
	assert.ok(completion !== undefined);
	assert.equal(fieldStringOf(completion, 1), "qc-1");
	assert.ok(fieldBytesOf(completion, 2).length > 0);
	assert.ok(fieldBytesOf(completion, 3).length > 0);
});

test("encodeMcpToolCallStep wraps args and result under the MCP ToolCall variant", () => {
	const step = encodeMcpToolCallStep(new Uint8Array([1]), new Uint8Array([2]));
	const toolCall = fieldBytesOf(step, 2); // ConversationStep.tool_call
	const mcp = fieldBytesOf(toolCall, 15); // ToolCall.mcp_tool_call
	assert.deepEqual([...fieldBytesOf(mcp, 1)], [1]); // McpToolCall.args
	assert.deepEqual([...fieldBytesOf(mcp, 2)], [2]); // McpToolCall.result
});

test("encodeReplayTurnBlob + appendTurnsToCheckpoint preserve foreign fields", () => {
	const store = new Map();
	const step = encodeMcpToolCallStep(new Uint8Array([7]), new Uint8Array([8]));
	const turnId = encodeReplayTurnBlob(store, { userText: "", stepBlobs: [step] });
	// A checkpoint with a foreign field (3 = todos) and one existing turn id.
	const checkpoint = new Writer()
		.bytes(3, new Uint8Array([9, 9]))
		.bytes(8, new Uint8Array([1, 2, 3]))
		.finish();
	const merged = appendTurnsToCheckpoint(checkpoint, [turnId]);
	const reader = new Reader(merged);
	const turns = [];
	let foreign = 0;
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 8 && wireType === 2) turns.push([...reader.bytes()]);
		else if (field === 3 && wireType === 2) {
			assert.deepEqual([...reader.bytes()], [9, 9]);
			foreign++;
		} else reader.skip(wireType);
	}
	assert.equal(foreign, 1);
	assert.equal(turns.length, 2);
	assert.deepEqual(turns[0], [1, 2, 3]);
	assert.deepEqual(turns[1], [...turnId]);
});

test("encodeResumeAction is the empty resume variant of ConversationAction", () => {
	const action = encodeResumeAction();
	assert.deepEqual([...fieldBytesOf(action, 2)], []);
});

test("pump answers housekeeping frames and routes the question to the consumer", async () => {
	const blobId = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
	const kvGet = new Writer().varint(1, 7).message(2, new Writer().bytes(1, blobId).finish()).finish();
	const execContext = new Writer().varint(1, 3).string(15, "exec-1").message(10, new Uint8Array(0)).finish();
	const askArgs = new Writer().string(1, "Pick one").finish();
	const askQuery = new Writer().varint(1, 42).message(3, new Writer().message(1, askArgs).string(2, "qc-9").finish()).finish();
	const run = fakeRun([
		frameEncode(new Writer().message(4, kvGet).finish()),
		frameEncode(new Writer().message(2, execContext).finish()),
		frameEncode(new Writer().message(7, askQuery).finish()),
	]);
	const pump = new CursorRunPump({
		run,
		persisted: { blobs: new Map() },
		sessionKey: undefined,
		mcpTools: [],
		parkedTimeoutMs: 60_000,
		syncTodos: undefined,
		debug: () => {},
	});
	pump.blobStore = new Map();
	// Wait until the routed askQuestion frame reaches the consumer queue.
	const routed = await pump.next();
	assert.equal(decodeAgentServerMessage(routed.payload).case, "interactionQuery");
	// The two housekeeping replies were written without a consumer attached.
	assert.equal(run.writes.length, 2);
	const kvEnvelope = new Reader(framePayloadOf(run.writes[0]));
	let kvClient;
	while (!kvEnvelope.done) {
		const { field, wireType } = kvEnvelope.tag();
		if (field === 3 && wireType === 2) kvClient = kvEnvelope.bytes();
		else kvEnvelope.skip(wireType);
	}
	let getBlobResult;
	const kvReply = new Reader(kvClient);
	while (!kvReply.done) {
		const { field, wireType } = kvReply.tag();
		if (field === 2 && wireType === 2) getBlobResult = kvReply.bytes();
		else kvReply.skip(wireType);
	}
	assert.ok(getBlobResult !== undefined, "getBlobResult written");
	pump.terminate(new Error("test done"));
	assert.equal(run.finished, true);
});

test("pump injectDshMessage writes user_context once and system_context for plugins", async () => {
	const run = fakeRun([], { endFrames: false });
	const pump = new CursorRunPump({
		run,
		persisted: { blobs: new Map(), generationId: "run-1" },
		sessionKey: undefined,
		mcpTools: [],
		parkedTimeoutMs: 60_000,
		syncTodos: undefined,
		debug: () => {},
		generationId: "run-1",
	});
	assert.equal(await pump.injectDshMessage({
		id: "u1",
		source: { kind: "user" },
		content: [{ type: "text", text: "steer me" }],
	}), true);
	assert.equal(await pump.injectDshMessage({
		id: "u1",
		source: { kind: "user" },
		content: [{ type: "text", text: "steer me" }],
	}), false);
	assert.equal(await pump.injectDshMessage({
		id: "p1",
		source: { kind: "plugin", plugin: "dsh-time" },
		content: [{ type: "text", text: "it is Tuesday" }],
	}), true);
	assert.equal(run.writes.length, 2);
	const first = new Reader(framePayloadOf(run.writes[0]));
	assert.deepEqual(first.tag(), { field: 4, wireType: 2 });
	const firstAction = new Reader(first.bytes());
	assert.deepEqual(firstAction.tag(), { field: 19, wireType: 2 });
	const firstInner = new Reader(firstAction.bytes());
	assert.deepEqual(firstInner.tag(), { field: 1, wireType: 2 });
	firstInner.string();
	assert.deepEqual(firstInner.tag(), { field: 2, wireType: 2 });
	assert.equal(firstInner.string(), "run-1");
	assert.deepEqual(firstInner.tag(), { field: 3, wireType: 2 });
	const second = new Reader(framePayloadOf(run.writes[1]));
	assert.deepEqual(second.tag(), { field: 4, wireType: 2 });
	const secondAction = new Reader(second.bytes());
	assert.deepEqual(secondAction.tag(), { field: 19, wireType: 2 });
	const secondInner = new Reader(secondAction.bytes());
	assert.deepEqual(secondInner.tag(), { field: 1, wireType: 2 });
	secondInner.string();
	assert.deepEqual(secondInner.tag(), { field: 2, wireType: 2 });
	assert.equal(secondInner.string(), "run-1");
	assert.deepEqual(secondInner.tag(), { field: 4, wireType: 2 });
	pump.terminate(new Error("test done"));
});

test("pump requestContext prepends the DSH system prompt rule", async () => {
	const execContext = new Writer().varint(1, 3).string(15, "exec-1").message(10, new Uint8Array(0)).finish();
	const run = fakeRun([
		frameEncode(new Writer().message(2, execContext).finish()),
	]);
	const pump = new CursorRunPump({
		run,
		persisted: { blobs: new Map() },
		sessionKey: undefined,
		mcpTools: [],
		parkedTimeoutMs: 60_000,
		syncTodos: undefined,
		debug: () => {},
		systemText: "You are in DSH.",
		userRulesDir: false,
	});
	const deadline = Date.now() + 2000;
	while (run.writes.length === 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.ok(run.writes.length >= 1, "requestContext result was written");
	const envelope = new Reader(framePayloadOf(run.writes[0]));
	assert.deepEqual(envelope.tag(), { field: 2, wireType: 2 });
	const exec = new Reader(envelope.bytes());
	let result;
	while (!exec.done) {
		const { field, wireType } = exec.tag();
		if (field === 10 && wireType === 2) result = exec.bytes();
		else exec.skip(wireType);
	}
	assert.ok(result !== undefined);
	const success = new Reader(result);
	assert.deepEqual(success.tag(), { field: 1, wireType: 2 });
	const ok = new Reader(success.bytes());
	assert.deepEqual(ok.tag(), { field: 1, wireType: 2 });
	const context = new Reader(ok.bytes());
	assert.deepEqual(context.tag(), { field: 2, wireType: 2 });
	const rule = new Reader(context.bytes());
	assert.deepEqual(rule.tag(), { field: 1, wireType: 2 });
	assert.equal(rule.string(), "dsh://system-prompt");
	assert.deepEqual(rule.tag(), { field: 2, wireType: 2 });
	assert.equal(rule.string(), "You are in DSH.");
	pump.terminate(new Error("test done"));
});

test("pump parked cap fires silently for pending MCP work", async () => {
	const run = fakeRun([]);
	const pump = new CursorRunPump({
		run,
		persisted: { blobs: new Map() },
		sessionKey: undefined,
		mcpTools: [],
		parkedTimeoutMs: 40,
		syncTodos: undefined,
		debug: () => {},
	});
	pump.bridge = { pendingExecs: [{ kind: "mcp" }] };
	pump.detach();
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(pump.stopped, true);
	assert.equal(run.finished, true);
	assert.equal(run.writes.length, 0, "cap is silent — no error replies are written");
});

test("askQuestion cancels the run and the late answer returns via async completion", async () => {
	const askArgs = new Writer()
		.string(1, "Pick one")
		.message(2, new Writer()
			.string(1, "q1")
			.string(2, "Which one?")
			.message(3, new Writer().string(1, "a").string(2, "Alpha").finish())
			.finish())
		.finish();
	const askQuery = new Writer()
		.varint(1, 42)
		.message(3, new Writer().message(1, askArgs).string(2, "qc-1").finish())
		.finish();
	const created = [];
	const adapter = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		createAgentRun: () => {
			const run = fakeRun(created.length === 0 ? [frameEncode(new Writer().message(7, askQuery).finish())] : []);
			created.push(run);
			return run;
		},
	});
	const first = await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "question-session",
		messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
	}));
	const toolCall = first.find((chunk) => chunk.type === "block-end" && chunk.block?.name === "ask_user_question");
	assert.ok(toolCall !== undefined, "question bridged as ask_user_question");
	assert.equal(first.at(-1).type, "finish");
	assert.equal(first.at(-1).reason.kind, "tool-calls");
	assert.equal(created[0].finished, true, "question run is cancelled, not parked");

	// The user answers: next stream delivers AsyncAskQuestionCompletionAction.
	const second = await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "question-session",
		messages: [
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{
				role: "assistant",
				content: [
					{ type: "tool-call", id: "qc-1", name: "ask_user_question", arguments: "{}" },
					{
						type: "tool-result",
						toolCallId: "qc-1",
						content: [{ type: "text", text: JSON.stringify({ answers: [{ id: "q1", selected: ["Alpha"] }] }) }],
					},
				],
			},
		],
	}));
	assert.equal(created.length, 2, "answer goes on a fresh run");
	const runRequest = runRequestOf(created[1].writes[0]);
	const action = fieldBytesOf(runRequest, 2);
	const completion = fieldBytesOf(action, 8);
	assert.ok(completion !== undefined, "action is async_ask_question_completion");
	assert.equal(fieldStringOf(completion, 1), "qc-1");
	assert.ok(fieldBytesOf(completion, 2).length > 0, "original args echoed");
	assert.ok(fieldBytesOf(completion, 3).length > 0, "result present");
	// conversation ids are stable across runs
	const firstConversationId = fieldStringOf(runRequestOf(created[0].writes[0]), 5);
	assert.equal(fieldStringOf(runRequest, 5), firstConversationId);

	// The question is consumed: a third stream with the same result is a plain turn.
	const third = await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "question-session",
		messages: [
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{
				role: "assistant",
				content: [
					{ type: "tool-call", id: "qc-1", name: "ask_user_question", arguments: "{}" },
					{ type: "tool-result", toolCallId: "qc-1", content: [{ type: "text", text: "x" }] },
				],
			},
		],
	}));
	assert.equal(created.length, 3);
	const thirdRequest = runRequestOf(created[2].writes[0]);
	assert.equal(fieldBytesOf(fieldBytesOf(thirdRequest, 2), 8), undefined, "no async completion on the third turn");
});

test("a dead bridge replays pending MCP results as turn steps", async () => {
	// McpArgs { tool_call_id = 3, tool_name = 5 } + raw args map entry.
	const mcpArgs = new Writer()
		.string(3, "mcp-call-1")
		.string(5, "dsh_tool")
		.message(2, new Writer().string(1, "query").bytes(2, new Uint8Array([5])).finish())
		.finish();
	const execFrame = new Writer().varint(1, 11).string(15, "exec-1").message(11, mcpArgs).finish();
	const checkpointBytes = new Writer().bytes(4, new TextEncoder().encode('["pending"]')).finish();
	const created = [];
	const adapter = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		createAgentRun: () => {
			const run = created.length === 0
				? fakeRun([
					frameEncode(new Writer().message(2, execFrame).finish()),
					frameEncode(new Writer().message(3, checkpointBytes).finish()),
				], { endFrames: false })
				: fakeRun([]);
			created.push(run);
			return run;
		},
	});
	const first = await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "replay-session",
		messages: [{ role: "user", content: [{ type: "text", text: "run the tool" }] }],
	}));
	assert.equal(first.at(-1).reason.kind, "tool-calls");
	assert.equal(created[0].finished, false, "bridge parked for the MCP result");

	// Simulate the server killing the run before the result arrives.
	created[0].close();

	const second = await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "replay-session",
		messages: [
			{ role: "user", content: [{ type: "text", text: "run the tool" }] },
			{
				role: "assistant",
				content: [
					{ type: "tool-call", id: "mcp-call-1", name: "dsh_tool", arguments: "{}" },
					{ type: "tool-result", toolCallId: "mcp-call-1", content: [{ type: "text", text: "done" }] },
				],
			},
		],
	}));
	assert.equal(created.length, 2, "replay happens on a fresh run");
	const runRequest = runRequestOf(created[1].writes[0]);
	const action = fieldBytesOf(runRequest, 2);
	assert.ok(fieldBytesOf(action, 2) !== undefined, "action is resume_action");
	assert.equal(fieldBytesOf(action, 8), undefined, "not an async completion");
	// The conversation state gained one replayed turn blob id.
	const conversationState = fieldBytesOf(runRequest, 1);
	const reader = new Reader(conversationState);
	let turnCount = 0;
	let turnId;
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 8 && wireType === 2) {
			turnCount++;
			turnId = reader.bytes();
		} else reader.skip(wireType);
	}
	assert.equal(turnCount, 1);
	assert.ok(turnId !== undefined && turnId.length === 32, "turn entry is a SHA-256 blob id");
});

test("a new user turn after a dead parked bridge keeps the checkpoint", async () => {
	const mcpArgs = new Writer()
		.string(3, "mcp-call-1")
		.string(5, "dsh_tool")
		.message(2, new Writer().string(1, "query").bytes(2, new Uint8Array([5])).finish())
		.finish();
	const execFrame = new Writer().varint(1, 11).string(15, "exec-1").message(11, mcpArgs).finish();
	const checkpointBytes = new Writer().bytes(4, new TextEncoder().encode('["done"]')).finish();
	const created = [];
	const adapter = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		createAgentRun: () => {
			const run = created.length === 0
				? fakeRun([
					frameEncode(new Writer().message(2, execFrame).finish()),
					frameEncode(new Writer().message(3, checkpointBytes).finish()),
				], { endFrames: false })
				: fakeRun([]);
			created.push(run);
			return run;
		},
	});
	await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "stale-bridge",
		messages: [{ role: "user", content: [{ type: "text", text: "你试一下你能不能使用dsh的上下文压缩工具" }] }],
	}));
	created[0].close();

	await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "stale-bridge",
		messages: [
			{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "你试一下你能不能使用dsh的上下文压缩工具" }] },
			{ role: "assistant", content: [{ type: "text", text: "先看当前上下文状态，再试一次 DSH 的压缩工具。" }] },
			{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "你读点长文本：联网一下deepseek harness的文档、使用方法等，之后停下来，我看看上下文是否足够" }] },
		],
	}));
	assert.equal(created.length, 2, "follow-up opens a fresh run");
	const request = runRequestOf(created[1].writes[0]);
	assert.deepEqual([...fieldBytesOf(request, 1)], [...checkpointBytes], "checkpoint must not be wiped by a dead bridge pointer");
	const action = fieldBytesOf(request, 2);
	const userAction = fieldBytesOf(action, 1);
	const user = fieldBytesOf(userAction, 1);
	const text = fieldStringOf(user, 1) ?? "";
	assert.equal(text, "你读点长文本：联网一下deepseek harness的文档、使用方法等，之后停下来，我看看上下文是否足够");
	assert.equal(text.includes("Continue the DSH conversation"), false);
	assert.equal(text.includes("上下文压缩"), false);
});

test("a new user turn on a live parked bridge opens a send() instead of injecting", async () => {
	const mcpArgs = new Writer()
		.string(3, "mcp-call-1")
		.string(5, "dsh_tool")
		.message(2, new Writer().string(1, "query").bytes(2, new Uint8Array([5])).finish())
		.finish();
	const execFrame = new Writer().varint(1, 11).string(15, "exec-1").message(11, mcpArgs).finish();
	const checkpointBytes = new Writer().bytes(4, new TextEncoder().encode('["parked"]')).finish();
	const created = [];
	const adapter = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		createAgentRun: () => {
			const run = created.length === 0
				? fakeRun([
					frameEncode(new Writer().message(2, execFrame).finish()),
					frameEncode(new Writer().message(3, checkpointBytes).finish()),
				], { endFrames: false })
				: fakeRun([]);
			created.push(run);
			return run;
		},
	});
	await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "live-bridge-followup",
		messages: [{ role: "user", content: [{ type: "text", text: "run the tool" }] }],
	}));
	assert.equal(created[0].finished, false, "bridge still parked");

	await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "live-bridge-followup",
		messages: [
			{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "run the tool" }] },
			{ role: "assistant", content: [{ type: "text", text: "calling the tool" }] },
			{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "stop and answer this instead" }] },
		],
	}));
	assert.equal(created.length, 2, "SDK send() is a new Run, not InjectContext on the parked MCP stream");
	assert.equal(created[0].finished, true, "the parked run is closed before the follow-up send");
	const request = runRequestOf(created[1].writes[0]);
	assert.deepEqual([...fieldBytesOf(request, 1)], [...checkpointBytes]);
	const action = fieldBytesOf(request, 2);
	const userAction = fieldBytesOf(action, 1);
	const user = fieldBytesOf(userAction, 1);
	assert.equal(fieldStringOf(user, 1), "stop and answer this instead");
	assert.equal(fieldBytesOf(action, 19), undefined, "follow-up is UserMessageAction, not InjectContextAction");
});

test("an unknown exec variant fails in band with throw + stream_close", async () => {
	// ExecServerMessage { id=9, subagent_args=28 } — a newer-protocol frame
	// this client does not decode. Silence would hang the server forever, so
	// the client must answer with ExecClientThrow + stream_close (T05).
	const execFrame = new Writer().varint(1, 9).message(28, new Uint8Array(0)).finish();
	const created = [];
	const adapter = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		createAgentRun: () => {
			const run = fakeRun([frameEncode(new Writer().message(2, execFrame).finish())], { endFrames: true });
			created.push(run);
			return run;
		},
	});
	const chunks = await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "unknown-exec",
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
	}));
	assert.equal(chunks.at(-1).type, "finish");
	// writes: [run_request, throw, stream_close]
	const writes = created[0].writes;
	assert.equal(writes.length, 3, "throw + stream_close written after the request");
	const readControl = (write) => {
		const envelope = new Reader(framePayloadOf(write));
		let control;
		while (!envelope.done) {
			const { field, wireType } = envelope.tag();
			if (field === 5 && wireType === 2) control = envelope.bytes();
			else envelope.skip(wireType);
		}
		assert.ok(control !== undefined);
		return control;
	};
	// throw { id=1, error=2, error_code=4 }
	const throwControl = new Reader(readControl(writes[1]));
	let throwBytes;
	while (!throwControl.done) {
		const { field, wireType } = throwControl.tag();
		if (field === 2 && wireType === 2) throwBytes = throwControl.bytes();
		else throwControl.skip(wireType);
	}
	assert.ok(throwBytes !== undefined);
	const thrown = new Reader(throwBytes);
	let throwId;
	let errorCode;
	while (!thrown.done) {
		const { field, wireType } = thrown.tag();
		if (field === 1 && wireType === 0) throwId = thrown.varint();
		else if (field === 4 && wireType === 2) errorCode = thrown.string();
		else thrown.skip(wireType);
	}
	assert.equal(throwId, 9);
	assert.equal(errorCode, "exec_variant_unsupported");
	// stream_close { id=1 }
	const closeControl = new Reader(readControl(writes[2]));
	let closeBytes;
	while (!closeControl.done) {
		const { field, wireType } = closeControl.tag();
		if (field === 1 && wireType === 2) closeBytes = closeControl.bytes();
		else closeControl.skip(wireType);
	}
	assert.ok(closeBytes !== undefined);
	const close = new Reader(closeBytes);
	let closeId;
	while (!close.done) {
		const { field, wireType } = close.tag();
		if (field === 1 && wireType === 0) closeId = close.varint();
		else close.skip(wireType);
	}
	assert.equal(closeId, 9);
});

test("Cursor adapter yields turn_ended + checkpoint token usage", async () => {
	const turnEnded = new Writer()
		.message(1, new Writer().message(14, new Writer()
			.varint(1, 48_000)
			.varint(2, 800)
			.varint(3, 12_000)
			.finish()).finish())
		.finish();
	const checkpoint = new Writer()
		.message(5, new Writer().varint(1, 62_400).varint(2, 256_000).finish())
		.finish();
	const adapter = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		createAgentRun: () => fakeRun([
			frameEncode(turnEnded),
			frameEncode(new Writer().message(3, checkpoint).finish()),
		], { endFrames: true }),
	});
	const chunks = await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "grok-4.6",
		sessionId: "token-usage",
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
	}));
	const usage = chunks.find((chunk) => chunk.type === "usage")?.usage;
	assert.deepEqual(usage, {
		inputTokens: 61_600,
		outputTokens: 800,
		totalTokens: 62_400,
	});
	const resolved = await adapter.resolveModel("cursor-agent", "grok-4.6");
	assert.equal(resolved.context.contextWindow, 256_000);
});

test("display join settles when completed races ahead of the DSH call id", async () => {
	resetCursorJoins();
	const reference = new Writer().string(1, "T").string(2, "https://x").string(3, "snippet").finish();
	const searchSuccess = new Writer().message(1, reference).finish();
	const searchResult = new Writer().message(1, searchSuccess).finish();
	const searchArgs = new Writer().string(1, "cursor agents.md").finish();
	const searchCall = new Writer().message(1, searchArgs).message(2, searchResult).finish();
	const display = new Writer().string(1, "cursor-search-14").message(2, new Writer().message(18, searchCall).finish()).finish();
	const started = new Writer().message(1, new Writer().message(2, display).finish()).finish();
	const completed = new Writer().message(1, new Writer().message(3, display).finish()).finish();
	const checkpoint = new Writer().message(3, new Writer().bytes(4, new TextEncoder().encode("ckpt")).finish()).finish();
	const adapter = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		createAgentRun: () => fakeRun([
			// Completed reaches the pump before this stream() binds a DSH id —
			// the 83b6e022 hang: parked completed, then started after drain-close.
			frameEncode(completed),
			frameEncode(started),
			frameEncode(checkpoint),
		], { endFrames: true }),
	});
	const chunks = await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "display-race",
		messages: [{ role: "user", content: [{ type: "text", text: "search" }] }],
	}));
	const call = chunks.find((chunk) => chunk.type === "block-end" && chunk.block?.type === "tool-call");
	assert.equal(call?.block?.name, "web_search");
	const result = await Promise.race([
		awaitCursorJoin(call.block.id),
		new Promise((_, reject) => {
			setTimeout(() => reject(new Error("display join was not settled")), 200);
		}),
	]);
	assert.equal(result.isError, false);
	assert.match(result.text, /https:\/\/x/);
	resetCursorJoins();
});

test("display join fails when the run ends without a completed frame", async () => {
	resetCursorJoins();
	const searchArgs = new Writer().string(1, "cursor agents.md").finish();
	const searchCall = new Writer().message(1, searchArgs).finish();
	const display = new Writer().string(1, "cursor-search-open").message(2, new Writer().message(18, searchCall).finish()).finish();
	const started = new Writer().message(1, new Writer().message(2, display).finish()).finish();
	const adapter = new CursorAdapter({
		auth: { accessToken: async () => "test-token" },
		settings: () => resolveCursorSettings(),
		createAgentRun: () => fakeRun([
			frameEncode(started),
		], { endFrames: true }),
	});
	const chunks = await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "test-model",
		sessionId: "display-ended",
		messages: [{ role: "user", content: [{ type: "text", text: "search" }] }],
	}));
	const call = chunks.find((chunk) => chunk.type === "block-end" && chunk.block?.type === "tool-call");
	assert.equal(call?.block?.name, "web_search");
	const result = await Promise.race([
		awaitCursorJoin(call.block.id),
		new Promise((_, reject) => {
			setTimeout(() => reject(new Error("display join was not failed after end-stream")), 200);
		}),
	]);
	assert.equal(result.isError, true);
	assert.match(result.text, /ended before this tool completed/);
	resetCursorJoins();
});

test("NameAgent request/response round-trip the user_message and name fields", () => {
	const encoded = encodeNameAgentRequest("fix the login timeout");
	assert.equal(new Reader(encoded).tag().field, 1);
	const reader = new Reader(encoded);
	reader.tag();
	assert.equal(reader.string(), "fix the login timeout");
	assert.equal(decodeNameAgentResponse(new Writer().string(1, "Login timeout").finish()), "Login timeout");
	assert.equal(decodeNameAgentResponse(new Uint8Array(0)), "");
});

test("unwrapSessionTitleFrame recovers the first human text from the DSH title frame", () => {
	const framed = `${DSH_SESSION_TITLE_FRAME_PREFIX}\n${JSON.stringify([
		{ seq: 3, text: "帮我修一下登录超时" },
		{ seq: 7, text: "later prompt" },
	])}`;
	assert.equal(unwrapSessionTitleFrame(framed), "帮我修一下登录超时");
	assert.equal(unwrapSessionTitleFrame("plain first prompt"), "plain first prompt");
	assert.equal(unwrapSessionTitleFrame("   "), "");
	assert.equal(unwrapSessionTitleFrame(`${DSH_SESSION_TITLE_FRAME_PREFIX}\nnot-json`), `${DSH_SESSION_TITLE_FRAME_PREFIX}\nnot-json`.trim());
	assert.equal(
		extractSessionTitleUserMessage({
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "ignore" }] },
				{ role: "user", content: [{ type: "text", text: framed }] },
			],
		}),
		"帮我修一下登录超时",
	);
	assert.equal(extractSessionTitleUserMessage({ messages: [] }), "");
});

test("session-title purpose calls NameAgent and never opens a Run", async () => {
	const calls = [];
	const adapter = titleAdapter({
		nameAgent: async (token, userMessage) => {
			calls.push({ token, userMessage });
			return "  Login timeout  ";
		},
	});
	const framed = `${DSH_SESSION_TITLE_FRAME_PREFIX}\n${JSON.stringify([{ seq: 1, text: "fix the login timeout" }])}`;
	const chunks = await drainStream(adapter.stream({
		provider: "cursor-agent",
		model: "grok-4.6",
		sessionId: "title-session",
		purpose: "session-title",
		system: "Create a concise title…",
		messages: [{ role: "user", content: [{ type: "text", text: framed }] }],
	}));
	assert.deepEqual(calls, [{ token: "test-token", userMessage: "fix the login timeout" }]);
	assert.deepEqual(chunks, [
		{ type: "block-start", index: 0, blockType: "text" },
		{ type: "text-delta", index: 0, text: "Login timeout" },
		{ type: "block-end", index: 0, block: { type: "text", text: "Login timeout" } },
		{ type: "finish", reason: { kind: "stop" } },
	]);
});

test("session-title purpose surfaces NameAgent and abort failures without a Run", async () => {
	const empty = titleAdapter({
		nameAgent: async () => {
			throw new Error("NameAgent should not run without a user message");
		},
	});
	const emptyChunks = await drainStream(empty.stream({
		provider: "cursor-agent",
		model: "grok-4.6",
		purpose: "session-title",
		messages: [{ role: "user", content: [{ type: "text", text: "   " }] }],
	}));
	assert.equal(emptyChunks.at(-1).type, "finish");
	assert.equal(emptyChunks.at(-1).reason.kind, "error");
	assert.equal(emptyChunks.at(-1).reason.failure.code, "INVALID_REQUEST");

	const failed = titleAdapter({
		nameAgent: async () => {
			throw new Error("Cursor NameAgent failed (HTTP 503)");
		},
	});
	const failedChunks = await drainStream(failed.stream({
		provider: "cursor-agent",
		model: "grok-4.6",
		purpose: "session-title",
		messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
	}));
	assert.equal(failedChunks.at(-1).reason.kind, "error");
	assert.equal(failedChunks.at(-1).reason.failure.code, "SERVER");

	const aborted = titleAdapter({
		nameAgent: async (_token, _message, options) => {
			options.signal.throwIfAborted();
			throw new Error("should have been aborted");
		},
	});
	const controller = new AbortController();
	controller.abort();
	const abortedChunks = await drainStream(aborted.stream({
		provider: "cursor-agent",
		model: "grok-4.6",
		purpose: "session-title",
		signal: controller.signal,
		messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
	}));
	assert.equal(abortedChunks.at(-1).reason.kind, "aborted");
	assert.equal(abortedChunks.at(-1).reason.failure.code, "ABORTED");
});

test("fetchNameAgent posts proto to NameAgent and reads raw or framed names", async () => {
	const requests = [];
	const rawFetch = async (url, init) => {
		requests.push({ url, init });
		return {
			ok: true,
			status: 200,
			arrayBuffer: async () => new Writer().string(1, "Raw title").finish(),
		};
	};
	const rawName = await fetchNameAgent("tok", "first prompt", { fetch: rawFetch, baseUrl: "https://example.test" });
	assert.equal(rawName, "Raw title");
	assert.equal(requests[0].url, `https://example.test${CURSOR_NAME_AGENT_PATH}`);
	assert.equal(requests[0].init.headers.authorization, "Bearer tok");
	assert.equal(decodeNameAgentResponse(requests[0].init.body), "first prompt");

	const framedFetch = async () => ({
		ok: true,
		status: 200,
		arrayBuffer: async () => frameEncode(new Writer().string(1, "Framed title").finish()),
	});
	assert.equal(await fetchNameAgent("tok", "prompt", { fetch: framedFetch }), "Framed title");

	await assert.rejects(
		() => fetchNameAgent("tok", "prompt", { fetch: async () => ({ ok: false, status: 401, arrayBuffer: async () => new ArrayBuffer(0) }) }),
		/HTTP 401/,
	);
});

test("generated decode keeps unknown interaction oneofs instead of dropping them", () => {
	const bytes = new AgentServerMessage({
		message: {
			case: "interactionUpdate",
			value: new InteractionUpdate({
				message: { case: "stepStarted", value: new StepStartedUpdate() },
			}),
		},
	}).toBinary();
	const decoded = decodeAgentServerMessage(bytes);
	assert.equal(decoded.case, "interactionUpdate");
	assert.equal(decoded.value.type, "stepStarted");
	assert.equal(decodeInteractionUpdate(new InteractionUpdate({
		message: { case: "stepStarted", value: new StepStartedUpdate() },
	}).toBinary()).type, "stepStarted");
});

test("generated decode keeps unknown exec oneofs instead of dropping them", () => {
	const bytes = new ExecServerMessage({
		id: 9,
		execId: "sub-1",
		message: { case: "subagentArgs", value: new SubagentArgs() },
	}).toBinary();
	const decoded = decodeExecServerMessage(bytes);
	assert.equal(decoded.id, 9);
	assert.equal(decoded.execId, "sub-1");
	assert.equal(decoded.case, "subagentArgs");
});
