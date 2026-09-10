/**
 * Cursor model catalog: AvailableModels proto + mapping onto DSH's single
 * reasoning-effort axis.
 *
 * The picker lists one row per canonical model. Each variant's suffix
 * (`high`, `thinking-high-fast`, …) becomes a `reasoning.efforts` id.
 */
import { Reader, Writer } from "./proto";

export const DEFAULT_EFFORT_ID = "default";

/** Assumed when AvailableModels omits `context_token_limit`. */
export const FALLBACK_CONTEXT_WINDOW = 200_000;

const OFF_VALUES = new Set(["", "false", "none", "off", "0"]);

/** AvailableModelsRequest { use_model_parameters=5, do_not_use_markdown=7 }. */
export function encodeAvailableModelsRequest() {
	return new Writer().varint(5, 1).varint(7, 1).finish();
}

/** RequestedModel { model_id=1, max_mode=2, parameters=3 }. */
export function encodeRequestedModel({ modelId, maxMode = false, parameters = [] }: any) {
	const writer = new Writer();
	if (modelId) writer.string(1, modelId);
	if (maxMode) writer.varint(2, 1);
	for (const parameter of parameters) {
		if (!parameter?.id) continue;
		writer.message(3, new Writer().string(1, parameter.id).string(2, parameter.value ?? "").finish());
	}
	return writer.finish();
}

export function decodeAvailableModels(bytes): any {
	const reader = new Reader(bytes);
	const models = [];
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 2 && wireType === 2) {
			const model = decodeAvailableModel(reader.bytes());
			if (model?.name) models.push(model);
		} else {
			reader.skip(wireType);
		}
	}
	return models;
}

function decodeAvailableModel(bytes): any {
	const reader = new Reader(bytes);
	const model: any = {
		name: "",
		clientDisplayName: "",
		isHidden: false,
		onlySupportsCmdK: false,
		supportsImages: false,
		legacySlugs: [],
		idAliases: [],
		parameterDefinitions: [],
		variants: [],
	};
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (wireType === 2) {
			if (field === 1) model.name = reader.string();
			else if (field === 17) model.clientDisplayName = reader.string();
			else if (field === 18) model.serverModelName = reader.string();
			else if (field === 29) model.parameterDefinitions.push(decodeParameterDefinition(reader.bytes()));
			else if (field === 30) model.variants.push(decodeVariant(reader.bytes()));
			else if (field === 36) model.legacySlugs.push(reader.string());
			else if (field === 37) model.idAliases.push(reader.string());
			else reader.bytes();
		} else if (wireType === 0) {
			const raw = reader.varint();
			if (field === 10) model.supportsImages = raw !== 0;
			else if (field === 15) model.contextTokenLimit = raw;
			else if (field === 16) model.contextTokenLimitForMaxMode = raw;
			else if (field === 27) model.onlySupportsCmdK = raw !== 0;
			else if (field === 35) model.isHidden = raw !== 0;
		} else {
			reader.skip(wireType);
		}
	}
	return model;
}

function decodeVariant(bytes): any {
	const reader = new Reader(bytes);
	const variant = {
		parameters: [],
		displayName: "",
		displayNameOutsidePicker: "",
		isMaxMode: false,
		isDefaultNonMax: false,
		isDefaultMax: false,
		variantStringRepresentation: "",
		legacySlug: "",
	};
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (wireType === 2) {
			if (field === 1) variant.parameters.push(decodeParameter(reader.bytes()));
			else if (field === 2) variant.displayName = reader.string();
			else if (field === 8) variant.displayNameOutsidePicker = reader.string();
			else if (field === 9) variant.variantStringRepresentation = reader.string();
			else if (field === 11) variant.legacySlug = reader.string();
			else reader.bytes();
		} else if (wireType === 0) {
			const value = reader.varint() !== 0;
			if (field === 3) variant.isMaxMode = value;
			else if (field === 4) variant.isDefaultMax = value;
			else if (field === 5) variant.isDefaultNonMax = value;
		} else {
			reader.skip(wireType);
		}
	}
	return variant;
}

function decodeParameter(bytes): any {
	const reader = new Reader(bytes);
	const parameter = { id: "", value: "" };
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) parameter.id = reader.string();
		else if (field === 2 && wireType === 2) parameter.value = reader.string();
		else reader.skip(wireType);
	}
	return parameter;
}

/** ModelParameterDefinition { id=1, name=2, parameter_type=4 }. */
function decodeParameterDefinition(bytes): any {
	const reader = new Reader(bytes);
	const definition = { id: "", name: "", kind: "", values: [] };
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) definition.id = reader.string();
		else if (field === 2 && wireType === 2) definition.name = reader.string();
		else if (field === 4 && wireType === 2) Object.assign(definition, decodeParameterType(reader.bytes()));
		else reader.skip(wireType);
	}
	return definition;
}

function decodeParameterType(bytes): any {
	const reader = new Reader(bytes);
	const type = { kind: "", values: [] };
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) {
			type.kind = "boolean";
			type.values = decodeNamedValues(reader.bytes(), 1);
		} else if (field === 2 && wireType === 2) {
			type.kind = "enum";
			type.values = decodeNamedValues(reader.bytes(), 1);
		} else {
			reader.skip(wireType);
		}
	}
	return type;
}

function decodeNamedValues(bytes, valuesField): any {
	const reader = new Reader(bytes);
	const values = [];
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === valuesField && wireType === 2) {
			const inner = new Reader(reader.bytes());
			const entry = { value: "", displayName: "" };
			while (!inner.done) {
				const tag = inner.tag();
				if (tag.field === 1 && tag.wireType === 2) entry.value = inner.string();
				else if (tag.field === 2 && tag.wireType === 2) entry.displayName = inner.string();
				else inner.skip(tag.wireType);
			}
			if (entry.value) values.push(entry);
		} else {
			reader.skip(wireType);
		}
	}
	return values;
}

function finiteTokenLimit(value) {
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

function aliasesOf(model) {
	return [model.serverModelName, ...(model.legacySlugs ?? []), ...(model.idAliases ?? [])]
		.filter((value) => typeof value === "string" && value.length > 0 && value !== model.name);
}

function stripModelPrefix(raw, prefixes) {
	if (typeof raw !== "string") return "";
	const value = raw.trim();
	if (!value) return "";
	for (const prefix of prefixes) {
		if (value === prefix) return "";
		if (value.startsWith(`${prefix}-`)) return value.slice(prefix.length + 1);
	}
	return value;
}

function isOffValue(value) {
	return OFF_VALUES.has(String(value ?? "").trim().toLowerCase());
}

/** Build a suffix from parameter values when the server omitted a representation. */
export function synthesizeEffortId(parameters = []) {
	const map = Object.fromEntries(
		parameters
			.filter((parameter) => parameter?.id)
			.map((parameter) => [parameter.id, parameter.value ?? ""]),
	);
	const parts = [];
	const thinking = map.thinking;
	if (thinking === "true") parts.push("thinking");
	else if (thinking && !isOffValue(thinking)) parts.push(thinking);
	for (const key of ["reasoning", "effort", "reasoning_effort"]) {
		const value = map[key];
		if (!value || isOffValue(value) || value === "true") continue;
		if (key === "reasoning" && thinking && thinking !== "true") continue;
		parts.push(value);
		break;
	}
	if (map.fast === "true") parts.push("fast");
	return parts.join("-");
}

function titleCaseToken(value) {
	const text = String(value ?? "").trim();
	if (!text) return "";
	if (/^\d+m$/i.test(text)) return `${text.slice(0, -1)}M`;
	if (/^\d+k$/i.test(text)) return `${text.slice(0, -1)}K`;
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Cursor CLI's param summary: definition display names, no model id.
 * `reasoning=max, context=1m, fast=true` → "Max 1M Fast".
 */
export function formatParamSummary(parameters = [], definitions = []) {
	const selected = new Map(
		parameters
			.filter((parameter) => parameter?.id)
			.map((parameter) => [parameter.id, parameter.value ?? ""]),
	);
	const parts = [];
	if (definitions.length > 0) {
		for (const definition of definitions) {
			const value = selected.get(definition.id);
			if (definition.kind === "boolean") {
				if (definition.id === "thinking") continue;
				if (value === "true") parts.push(definition.name || titleCaseToken(definition.id));
				continue;
			}
			if (definition.kind === "enum") {
				if ((definition.values?.length ?? 0) <= 1) continue;
				const match = definition.values.find((entry) => entry.value === value);
				const label = match?.displayName || value;
				if (label && !isOffValue(label)) parts.push(label);
			}
		}
	} else {
		const intensity = selected.get("reasoning") ?? selected.get("effort") ?? selected.get("reasoning_effort");
		if (intensity && !isOffValue(intensity) && intensity !== "true") parts.push(titleCaseToken(intensity));
		const context = selected.get("context");
		if (context && !isOffValue(context)) parts.push(titleCaseToken(context));
		if (selected.get("fast") === "true") parts.push("Fast");
	}
	if (selected.get("thinking") === "false") parts.push("No Thinking");
	return parts.join(" ").trim();
}

function containsModelName(label, modelName, displayName) {
	const haystack = String(label ?? "").toLowerCase();
	if (!haystack) return false;
	for (const token of [modelName, displayName]) {
		if (typeof token === "string" && token.length > 0 && haystack.includes(token.toLowerCase())) return true;
	}
	return false;
}

export function variantEffortLabel(modelName, variant, definitions = [], displayName = "") {
	const summary = formatParamSummary(variant.parameters, definitions);
	if (summary) return summary;
	const outside = variant.displayNameOutsidePicker?.trim();
	if (outside && !containsModelName(outside, modelName, displayName)) return outside;
	return "Default";
}

export function variantEffortId(modelName, variant, aliases = []) {
	const prefixes = [modelName, ...aliases]
		.filter((value) => typeof value === "string" && value.length > 0)
		.sort((left, right) => right.length - left.length);
	const fromRepresentation = stripModelPrefix(variant.variantStringRepresentation, prefixes);
	if (fromRepresentation) return fromRepresentation;
	const fromLegacy = stripModelPrefix(variant.legacySlug, prefixes);
	if (fromLegacy) return fromLegacy;
	return synthesizeEffortId(variant.parameters) || DEFAULT_EFFORT_ID;
}

/**
 * Collapse AvailableModels into one catalog row per canonical model.
 * Max-mode-only duplicates of the same suffix are dropped when a non-max
 * sibling exists — DSH has one effort axis, not a separate Max toggle.
 */
export function catalogFromAvailableModels(models = []) {
	const catalog = [];
	for (const model of models) {
		if (!model?.name || model.isHidden === true || model.onlySupportsCmdK === true) continue;
		const aliases = aliasesOf(model);
		const definitions = model.parameterDefinitions ?? [];
		const efforts = [];
		const seen = new Set();
		const ranked = [...(model.variants ?? [])].sort((left, right) => Number(left.isMaxMode) - Number(right.isMaxMode));
		for (const variant of ranked) {
			const effortId = variantEffortId(model.name, variant, aliases);
			if (seen.has(effortId)) continue;
			seen.add(effortId);
			const name = variantEffortLabel(model.name, variant, definitions, model.clientDisplayName);
			efforts.push({
				id: effortId,
				name,
				parameters: variant.parameters.filter((parameter) => parameter.id),
				maxMode: variant.isMaxMode === true,
				isDefault: variant.isDefaultNonMax === true || (variant.isDefaultMax === true && variant.isMaxMode === true),
				legacySlug: variant.legacySlug || "",
				variantStringRepresentation: variant.variantStringRepresentation || "",
			});
		}
		const defaultEffort = efforts.find((effort) => effort.isDefault && !effort.maxMode)?.id
			?? efforts.find((effort) => effort.isDefault)?.id
			?? efforts[0]?.id;
		catalog.push({
			id: model.name,
			name: model.clientDisplayName || model.name,
			aliases,
			efforts,
			parameterized: true,
			contextWindow: finiteTokenLimit(model.contextTokenLimit) ?? FALLBACK_CONTEXT_WINDOW,
			...finiteTokenLimit(model.contextTokenLimitForMaxMode) === undefined
				? {}
				: { contextWindowMaxMode: model.contextTokenLimitForMaxMode },
			supportsImages: model.supportsImages === true,
			...defaultEffort === undefined ? {} : { defaultEffort },
		});
	}
	return catalog;
}

/** DSH modalities from the catalog flag. Absent or false is text-only. */
export function inputModalitiesFromCatalog(entry) {
	return entry?.supportsImages === true ? ["text", "image"] : ["text"];
}

export function reasoningFromCatalogEntry(entry) {
	if (entry?.efforts?.length) {
		return {
			efforts: entry.efforts.map((effort) => ({
				id: effort.id,
				name: effort.name,
				...effort.description === undefined ? {} : { description: effort.description },
			})),
			...entry.defaultEffort === undefined ? {} : { defaultEffort: entry.defaultEffort },
		};
	}
	return undefined;
}

function effortMatchesToken(effort, token) {
	return effort.id === token
		|| effort.legacySlug === token
		|| effort.variantStringRepresentation === token;
}

function findCatalogEntry(catalog, modelId) {
	if (typeof modelId !== "string" || modelId.length === 0) return undefined;
	const exact = catalog.find((entry) => entry.id === modelId || entry.aliases.includes(modelId));
	if (exact) return { entry: exact, impliedEffort: undefined };
	for (const entry of catalog) {
		const implied = entry.efforts.find((effort) => effortMatchesToken(effort, modelId));
		if (implied) return { entry, impliedEffort: implied.id };
		if (modelId.startsWith(`${entry.id}-`)) {
			const suffix = modelId.slice(entry.id.length + 1);
			const bySuffix = entry.efforts.find((effort) => effort.id === suffix);
			if (bySuffix) return { entry, impliedEffort: bySuffix.id };
		}
	}
	return undefined;
}

/**
 * Resolve a DSH model id + optional reasoningEffort into the Cursor
 * RequestedModel payload (canonical id + parameters).
 */
function contextWindowForEffort(entry, effort) {
	const usesMaxContext = effort?.maxMode === true
		|| effort?.parameters.some((parameter) => parameter.id === "context" && /^1m$/i.test(parameter.value)) === true;
	if (usesMaxContext && finiteTokenLimit(entry?.contextWindowMaxMode) !== undefined) {
		return entry.contextWindowMaxMode;
	}
	return finiteTokenLimit(entry?.contextWindow) ?? FALLBACK_CONTEXT_WINDOW;
}

export function resolveCursorModelSelection(catalog, modelId, reasoningEffort?) {
	const match = findCatalogEntry(catalog ?? [], modelId);
	if (match === undefined) {
		return {
			modelId,
			parameters: [],
			maxMode: false,
			fromCatalog: false,
			contextWindow: FALLBACK_CONTEXT_WINDOW,
		};
	}
	const { entry, impliedEffort } = match;
	const wanted = typeof reasoningEffort === "string" && reasoningEffort.length > 0
		? reasoningEffort
		: impliedEffort ?? entry.defaultEffort;
	const effort = entry.efforts.find((item) => item.id === wanted)
		?? entry.efforts.find((item) => item.id === entry.defaultEffort)
		?? entry.efforts[0];
	return {
		modelId: entry.id,
		parameters: effort?.parameters ?? [],
		maxMode: effort?.maxMode === true,
		fromCatalog: entry.parameterized === true,
		contextWindow: contextWindowForEffort(entry, effort),
	};
}
