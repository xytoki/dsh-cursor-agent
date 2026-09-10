/**
 * AvailableModels catalog mapping: one picker row per canonical model,
 * variant suffixes as DSH reasoning efforts.
 */
import { test } from "@rstest/core";
import assert from "node:assert/strict";
import { Reader, Writer } from "../src/proto";
import {
	CursorAdapter,
	DEFAULT_EFFORT_ID,
	catalogFromAvailableModels,
	decodeAvailableModels,
	encodeAvailableModelsRequest,
	encodeRequestedModel,
	formatParamSummary,
	inputModalitiesFromCatalog,
	reasoningFromCatalogEntry,
	resolveCursorModelSelection,
	synthesizeEffortId,
	variantEffortId,
	variantEffortLabel,
	buildRunPayload,
} from "../src/index";

function encodeParameter(id, value) {
	return new Writer().string(1, id).string(2, value).finish();
}

function encodeVariant({
	parameters = [],
	displayName = "",
	isMaxMode = false,
	isDefaultNonMax = false,
	representation = "",
	legacySlug = "",
} = {}) {
	const writer = new Writer();
	for (const parameter of parameters) writer.message(1, encodeParameter(parameter.id, parameter.value));
	if (displayName) writer.string(2, displayName);
	if (isMaxMode) writer.varint(3, 1);
	if (isDefaultNonMax) writer.varint(5, 1);
	if (representation) writer.string(9, representation);
	if (legacySlug) writer.string(11, legacySlug);
	return writer.finish();
}

function encodeAvailableModel({
	name,
	displayName = "",
	hidden = false,
	supportsImages = false,
	contextTokenLimit,
	contextTokenLimitForMaxMode,
	variants = [],
	legacySlugs = [],
} = {}) {
	const writer = new Writer();
	writer.string(1, name);
	if (supportsImages) writer.varint(10, 1);
	if (Number.isFinite(contextTokenLimit)) writer.varint(15, contextTokenLimit);
	if (Number.isFinite(contextTokenLimitForMaxMode)) writer.varint(16, contextTokenLimitForMaxMode);
	if (displayName) writer.string(17, displayName);
	if (hidden) writer.varint(35, 1);
	for (const variant of variants) writer.message(30, encodeVariant(variant));
	for (const slug of legacySlugs) writer.string(36, slug);
	return writer.finish();
}

function composerVariants() {
	return [
		{
			parameters: [{ id: "thinking", value: "false" }],
			displayName: "Composer 2.5",
			isDefaultNonMax: true,
			representation: "composer-2.5",
			legacySlug: "composer-2.5",
		},
		{
			parameters: [{ id: "thinking", value: "true" }, { id: "reasoning", value: "high" }],
			displayName: "Composer 2.5 High",
			representation: "thinking-high",
			legacySlug: "composer-2.5-thinking-high",
		},
		{
			parameters: [
				{ id: "thinking", value: "true" },
				{ id: "reasoning", value: "high" },
				{ id: "fast", value: "true" },
			],
			displayName: "Composer 2.5 High Fast",
			representation: "composer-2.5-thinking-high-fast",
			legacySlug: "composer-2.5-thinking-high-fast",
		},
		{
			parameters: [{ id: "reasoning", value: "high" }, { id: "fast", value: "true" }],
			displayName: "Composer 2.5 High Fast (max)",
			isMaxMode: true,
			representation: "high-fast",
			legacySlug: "composer-2.5-high-fast",
		},
		{
			parameters: [{ id: "reasoning", value: "high" }, { id: "fast", value: "true" }],
			displayName: "Composer 2.5 High Fast",
			representation: "high-fast",
			legacySlug: "composer-2.5-high-fast",
		},
	];
}

test("encodeAvailableModelsRequest sets use_model_parameters and do_not_use_markdown", () => {
	const bytes = encodeAvailableModelsRequest();
	assert.deepEqual([...bytes], [40, 1, 56, 1]);
});

test("decodeAvailableModels reads name, display, and variant suffixes", () => {
	const writer = new Writer();
	writer.message(2, encodeAvailableModel({
		name: "composer-2.5",
		displayName: "Composer 2.5",
		supportsImages: false,
		contextTokenLimit: 200_000,
		contextTokenLimitForMaxMode: 1_000_000,
		variants: composerVariants(),
	}));
	writer.string(1, "ignored-model-name");
	const models = decodeAvailableModels(writer.finish());
	assert.equal(models.length, 1);
	assert.equal(models[0].name, "composer-2.5");
	assert.equal(models[0].clientDisplayName, "Composer 2.5");
	assert.equal(models[0].supportsImages, false);
	assert.equal(models[0].contextTokenLimit, 200_000);
	assert.equal(models[0].contextTokenLimitForMaxMode, 1_000_000);
	assert.equal(models[0].variants.length, 5);
	assert.equal(models[0].variants[1].variantStringRepresentation, "thinking-high");
	assert.equal(models[0].variants[1].parameters[1].value, "high");
});

test("variantEffortId prefers representation, then strips the model prefix", () => {
	assert.equal(variantEffortId("composer-2.5", { variantStringRepresentation: "thinking-high" }), "thinking-high");
	assert.equal(variantEffortId("composer-2.5", { variantStringRepresentation: "composer-2.5-thinking-high-fast" }), "thinking-high-fast");
	assert.equal(variantEffortId("composer-2.5", { variantStringRepresentation: "composer-2.5" }), DEFAULT_EFFORT_ID);
	assert.equal(variantEffortId("composer-2.5", { legacySlug: "composer-2.5-high-fast" }), "high-fast");
	assert.equal(
		synthesizeEffortId([
			{ id: "thinking", value: "true" },
			{ id: "reasoning", value: "high" },
			{ id: "fast", value: "true" },
		]),
		"thinking-high-fast",
	);
});

test("formatParamSummary uses Cursor parameter labels, not the model id", () => {
	assert.equal(
		formatParamSummary(
			[
				{ id: "context", value: "1m" },
				{ id: "reasoning", value: "max" },
				{ id: "fast", value: "true" },
			],
			[
				{
					id: "reasoning",
					name: "Reasoning",
					kind: "enum",
					values: [
						{ value: "high", displayName: "High" },
						{ value: "max", displayName: "Max" },
					],
				},
				{
					id: "context",
					name: "Context",
					kind: "enum",
					values: [
						{ value: "200k", displayName: "200K" },
						{ value: "1m", displayName: "1M" },
					],
				},
				{ id: "fast", name: "Fast", kind: "boolean", values: [] },
			],
		),
		"Max 1M Fast",
	);
	assert.equal(
		formatParamSummary([
			{ id: "reasoning", value: "max" },
			{ id: "context", value: "1m" },
			{ id: "fast", value: "true" },
		]),
		"Max 1M Fast",
	);
	assert.equal(
		variantEffortLabel("grok-4.6", {
			parameters: [{ id: "thinking", value: "false" }],
			displayName: "Grok 4.6",
		}),
		"No Thinking",
	);
});

test("catalogFromAvailableModels keeps one row and suffix efforts, dropping max duplicates", () => {
	const catalog = catalogFromAvailableModels([{
		name: "composer-2.5",
		clientDisplayName: "Composer 2.5",
		supportsImages: false,
		contextTokenLimit: 200_000,
		contextTokenLimitForMaxMode: 1_000_000,
		variants: composerVariants().map((variant) => ({
			parameters: variant.parameters,
			displayName: variant.displayName,
			isMaxMode: variant.isMaxMode === true,
			isDefaultNonMax: variant.isDefaultNonMax === true,
			variantStringRepresentation: variant.representation,
			legacySlug: variant.legacySlug,
		})),
	}]);
	assert.equal(catalog.length, 1);
	assert.equal(catalog[0].id, "composer-2.5");
	assert.deepEqual(catalog[0].efforts.map((effort) => effort.id), [
		DEFAULT_EFFORT_ID,
		"thinking-high",
		"thinking-high-fast",
		"high-fast",
	]);
	assert.equal(catalog[0].defaultEffort, DEFAULT_EFFORT_ID);
	assert.equal(catalog[0].efforts.find((effort) => effort.id === "high-fast").maxMode, false);
	assert.deepEqual(catalog[0].efforts.map((effort) => effort.name), [
		"No Thinking",
		"High",
		"High Fast",
		"High Fast",
	]);
	assert.equal(catalog[0].supportsImages, false);
	assert.equal(catalog[0].contextWindow, 200_000);
	assert.equal(catalog[0].contextWindowMaxMode, 1_000_000);
});

test("catalogFromAvailableModels skips hidden models", () => {
	const catalog = catalogFromAvailableModels([
		{ name: "hidden", isHidden: true, variants: [] },
		{ name: "plain", clientDisplayName: "Plain", variants: [] },
	]);
	assert.deepEqual(catalog.map((entry) => entry.id), ["plain"]);
	assert.equal(reasoningFromCatalogEntry(catalog[0]), undefined);
});

test("resolveCursorModelSelection maps effort and exploded slugs onto parameters", () => {
	const catalog = catalogFromAvailableModels([{
		name: "composer-2.5",
		clientDisplayName: "Composer 2.5",
		variants: composerVariants().map((variant) => ({
			parameters: variant.parameters,
			displayName: variant.displayName,
			isMaxMode: variant.isMaxMode === true,
			isDefaultNonMax: variant.isDefaultNonMax === true,
			variantStringRepresentation: variant.representation,
			legacySlug: variant.legacySlug,
		})),
	}]);
	assert.deepEqual(
		resolveCursorModelSelection(catalog, "composer-2.5", "thinking-high-fast").parameters,
		[
			{ id: "thinking", value: "true" },
			{ id: "reasoning", value: "high" },
			{ id: "fast", value: "true" },
		],
	);
	const exploded = resolveCursorModelSelection(catalog, "composer-2.5-thinking-high", undefined);
	assert.equal(exploded.modelId, "composer-2.5");
	assert.equal(exploded.fromCatalog, true);
	assert.deepEqual(exploded.parameters, [
		{ id: "thinking", value: "true" },
		{ id: "reasoning", value: "high" },
	]);
	assert.equal(resolveCursorModelSelection([], "grok-4.6").fromCatalog, false);
	assert.equal(resolveCursorModelSelection(catalog, "composer-2.5").contextWindow, 200_000);
});

function runRequestFields(payload) {
	const envelope = new Reader(payload);
	assert.equal(envelope.tag().field, 1);
	const request = new Reader(envelope.bytes());
	const fields = [];
	const values = {};
	while (!request.done) {
		const tag = request.tag();
		fields.push(tag.field);
		values[tag.field] = tag.wireType === 2 ? request.bytes() : request.varint();
	}
	return { fields, values };
}

test("buildRunPayload omits model_details when requested_model is supplied", () => {
	const { payload } = buildRunPayload({
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		useRequestedModel: true,
		requestedModelParameters: [{ id: "fast", value: "true" }],
	}, "grok-4.6");
	const { fields, values } = runRequestFields(payload);
	assert.ok(fields.includes(9), "requested_model (field 9) must be present");
	assert.equal(fields.includes(3), false, "model_details must be omitted for canonical ids");
	const requested = new Reader(values[9]);
	assert.equal(requested.tag().field, 1);
	assert.equal(requested.string(), "grok-4.6");
});

test("buildRunPayload keeps model_details when the catalog did not resolve", () => {
	const { payload } = buildRunPayload({
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
	}, "claude-3.5-sonnet");
	const { fields, values } = runRequestFields(payload);
	assert.ok(fields.includes(3), "model_details (field 3) is the GetUsableModels path");
	assert.equal(fields.includes(9), false, "requested_model must stay off without a catalog hit");
	const details = new Reader(values[3]);
	assert.equal(details.tag().field, 1);
	assert.equal(details.string(), "claude-3.5-sonnet");
});

test("CursorAdapter listModels is canonical and resolveModel exposes suffix efforts", async () => {
	const adapter = new CursorAdapter({
		auth: { accessToken: async () => "token" },
		fetchAvailableModels: async () => [{
			name: "composer-2.5",
			clientDisplayName: "Composer 2.5",
			supportsImages: false,
			contextTokenLimit: 200_000,
			contextTokenLimitForMaxMode: 1_000_000,
			variants: composerVariants().map((variant) => ({
				parameters: variant.parameters,
				displayName: variant.displayName,
				isMaxMode: variant.isMaxMode === true,
				isDefaultNonMax: variant.isDefaultNonMax === true,
				variantStringRepresentation: variant.representation,
				legacySlug: variant.legacySlug,
			})),
		}],
		fetchModels: async () => {
			throw new Error("GetUsableModels should not run when AvailableModels succeeds");
		},
	});
	const listed = await adapter.listModels("cursor-agent");
	assert.deepEqual(listed.map((model) => model.id), ["composer-2.5"]);
	assert.equal(listed[0].name, "Composer 2.5");
	assert.deepEqual(listed[0].inputModalities, ["text"]);
	assert.equal(listed[0].contextWindow, 200_000);
	const resolved = await adapter.resolveModel("cursor-agent", "composer-2.5");
	assert.deepEqual(resolved.inputModalities, ["text"]);
	assert.equal(resolved.context.contextWindow, 200_000);
	assert.deepEqual(resolved.reasoning.efforts.map((effort) => effort.id), [
		DEFAULT_EFFORT_ID,
		"thinking-high",
		"thinking-high-fast",
		"high-fast",
	]);
	assert.equal(resolved.reasoning.defaultEffort, DEFAULT_EFFORT_ID);
	const exploded = await adapter.resolveModel("cursor-agent", "composer-2.5-thinking-high-fast");
	assert.equal(exploded.id, "composer-2.5-thinking-high-fast");
	assert.ok(exploded.reasoning.efforts.some((effort) => effort.id === "thinking-high-fast"));
});

test("catalog context follows contextTokenLimit and 1m variants use the max-mode window", () => {
	const catalog = catalogFromAvailableModels([{
		name: "grok-4.6",
		clientDisplayName: "Grok 4.6",
		supportsImages: true,
		contextTokenLimit: 256_000,
		contextTokenLimitForMaxMode: 1_000_000,
		variants: [
			{
				parameters: [{ id: "context", value: "200k" }],
				displayName: "Grok 4.6",
				isDefaultNonMax: true,
				variantStringRepresentation: "grok-4.6",
				legacySlug: "grok-4.6",
			},
			{
				parameters: [{ id: "context", value: "1m" }],
				displayName: "Grok 4.6 1M",
				variantStringRepresentation: "1m",
				legacySlug: "grok-4.6-1m",
			},
		],
	}]);
	assert.equal(catalog[0].supportsImages, true);
	assert.equal(catalog[0].contextWindow, 256_000);
	assert.equal(resolveCursorModelSelection(catalog, "grok-4.6").contextWindow, 256_000);
	assert.equal(resolveCursorModelSelection(catalog, "grok-4.6", "1m").contextWindow, 1_000_000);
});

test("listModels and resolveModel follow AvailableModels supportsImages", async () => {
	const writer = new Writer();
	writer.message(2, encodeAvailableModel({
		name: "gpt-5",
		displayName: "GPT-5",
		supportsImages: true,
		contextTokenLimit: 272_000,
	}));
	const decoded = decodeAvailableModels(writer.finish());
	assert.equal(decoded[0].supportsImages, true);
	assert.equal(decoded[0].contextTokenLimit, 272_000);
	assert.deepEqual(inputModalitiesFromCatalog({ supportsImages: true }), ["text", "image"]);
	assert.deepEqual(inputModalitiesFromCatalog({ supportsImages: false }), ["text"]);
	const adapter = new CursorAdapter({
		auth: { accessToken: async () => "token" },
		fetchAvailableModels: async () => decoded,
		fetchModels: async () => [],
	});
	const listed = await adapter.listModels("cursor-agent");
	assert.deepEqual(listed[0].inputModalities, ["text", "image"]);
	assert.equal(listed[0].contextWindow, 272_000);
	const resolved = await adapter.resolveModel("cursor-agent", "gpt-5");
	assert.deepEqual(resolved.inputModalities, ["text", "image"]);
	assert.equal(resolved.context.contextWindow, 272_000);
});
