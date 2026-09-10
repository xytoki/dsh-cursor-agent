/**
 * Cursor Agent image ingress: user-message SelectedImage and LocalRead
 * binary classification. Matches agent.v1 SelectedImage / ReadSuccess.data.
 */
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { LlmError } from "@deepseek-ai/dsh-llm";
import {
	DEFAULT_MAX_IMAGE_BYTES,
	DEFAULT_MAX_IMAGE_DIMENSION,
	DEFAULT_MAX_IMAGE_PIXELS,
	DEFAULT_MAX_IMAGES_PER_MESSAGE,
	DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
	DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
	DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
	DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS,
	prepareImageFile,
} from "@deepseek-ai/dsh-attachment-local";
import { Writer } from "./proto";

/** Cloud Agent / CLI per-image byte cap. */
export const READ_IMAGE_MAX_BYTES = 15 * 1024 * 1024;

/** Cloud Agent prompt.images maximum. */
export const MAX_USER_IMAGES = 5;

/** Request-version policy for DSH attachment projection. */
export const IMAGE_REQUEST_POLICY = Object.freeze({
	maxPixels: 2048 * 2048,
	maxBytes: READ_IMAGE_MAX_BYTES,
});

/** Workspace-read resize: DSH normalizeImage policy (via prepareImageFile). */
export const READ_IMAGE_NORMALIZATION = Object.freeze({
	maxPixels: DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS,
	maxDimension: DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
	maxBytes: DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
});

const READ_IMAGE_LIMITS = Object.freeze({
	maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
	maxImagesPerMessage: DEFAULT_MAX_IMAGES_PER_MESSAGE,
	maxMessageImageBytes: DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
	maxImagePixels: DEFAULT_MAX_IMAGE_PIXELS,
	maxImageDimension: DEFAULT_MAX_IMAGE_DIMENSION,
	mediaTypes: Object.freeze(["image/png", "image/jpeg", "image/webp", "image/gif"]),
});

/**
 * Decode and resize one workspace image with DSH's prepareImageFile
 * (detectImage + canPassThroughNormalization + normalizeImage).
 */
export async function resizeReadImage(data, mediaType, name): Promise<{
	data: Uint8Array;
	mime: string;
	bytes: number;
	width?: number;
	height?: number;
	originalDimensions?: unknown;
}> {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data ?? []);
	const prepared = await prepareImageFile(
		{ data: bytes, mediaType, ...name ? { name } : {} },
		READ_IMAGE_LIMITS as any,
		READ_IMAGE_NORMALIZATION,
	);
	return {
		data: prepared.data,
		mime: prepared.ref.mediaType,
		bytes: prepared.ref.bytes,
		width: prepared.ref.width,
		height: prepared.ref.height,
		originalDimensions: prepared.ref.originalDimensions,
	};
}

const IMAGE_EXT = Object.freeze({
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
});

/** Magic-byte sniff used by Cursor's getFormatForFile. */
export function sniffImageMime(bytes) {
	const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
	if (data.length >= 8
		&& data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71
		&& data[4] === 13 && data[5] === 10 && data[6] === 26 && data[7] === 10) {
		return "image/png";
	}
	if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
	if (data.length >= 3 && data[0] === 71 && data[1] === 73 && data[2] === 70) return "image/gif";
	if (data.length >= 12
		&& data[0] === 82 && data[1] === 73 && data[2] === 70 && data[3] === 70
		&& data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80) {
		return "image/webp";
	}
	return undefined;
}

export function imageMimeFromPath(path) {
	return IMAGE_EXT[extname(String(path ?? "")).toLowerCase()];
}

export function isNotTextError(error) {
	const code = error?.code;
	if (code === "FS_NOT_TEXT") return true;
	return /binary file|invalid UTF-8 text/i.test(String(error?.message ?? ""));
}

export function binaryUnsupportedReason(path) {
	const ext = extname(String(path ?? "")).toLowerCase();
	if (ext === "") return "Binary files without an extension are not supported by the read executor";
	return `Binary files of type ${ext} are not supported by the read executor`;
}

export function contentHasImages(content) {
	return (content ?? []).some((block) => block?.type === "image" && block.attachment !== undefined);
}

/** Top-level image blocks on human user messages (plugin injects excluded). */
export function collectImageBlocks(messages = []) {
	const blocks = [];
	for (const message of messages ?? []) {
		if (message?.source?.kind === "plugin") continue;
		for (const block of message?.content ?? []) {
			if (block?.type === "image" && block.attachment !== undefined) blocks.push(block);
		}
	}
	return blocks;
}

/**
 * Project DSH attachments into SelectedImage payloads (inline `data`).
 * Caps at {@link MAX_USER_IMAGES}.
 */
export async function resolveSelectedImages(blocks, attachments, signal?) {
	if (!Array.isArray(blocks) || blocks.length === 0) return [];
	if (attachments === undefined || typeof attachments.readImageRequest !== "function") {
		throw new LlmError("Cursor image input requires the DSH attachment service", "UNSUPPORTED_CONTENT");
	}
	const selected = [];
	for (const block of blocks.slice(0, MAX_USER_IMAGES)) {
		const attachment = block.attachment;
		const stored = await attachments.readImageRequest(attachment, IMAGE_REQUEST_POLICY, signal);
		if (stored === undefined) throw new LlmError("Could not read an attached image", "INVALID_REQUEST");
		selected.push({
			uuid: randomUUID(),
			path: attachment.name || String(attachment.attachmentId ?? "image"),
			mimeType: stored.mediaType || attachment.mediaType || "image/png",
			width: stored.width,
			height: stored.height,
			data: stored.data instanceof Uint8Array ? stored.data : new Uint8Array(stored.data ?? []),
		});
	}
	return selected;
}

/** SelectedImage.Dimension { width=1, height=2 }. */
function encodeSelectedImageDimension(width, height) {
	return new Writer().varint(1, width).varint(2, height).finish();
}

/**
 * SelectedImage { blob_id=1 | data=8 | …, uuid=2, path=3, dimension=4, mime_type=7 }.
 * Official SDK `agent.send({ images: [{ data, mimeType, dimension }] })` uses `data`.
 */
export function encodeSelectedImage(image) {
	const writer = new Writer();
	if (image?.data instanceof Uint8Array && image.data.length > 0) writer.bytes(8, image.data);
	if (image?.uuid) writer.string(2, image.uuid);
	if (image?.path) writer.string(3, image.path);
	if (Number.isFinite(image?.width) && Number.isFinite(image?.height) && image.width > 0 && image.height > 0) {
		writer.message(4, encodeSelectedImageDimension(image.width, image.height));
	}
	if (image?.mimeType) writer.string(7, image.mimeType);
	return writer.finish();
}

/** SelectedContext { selected_images=1 }. */
export function encodeSelectedContext(images = []) {
	const writer = new Writer();
	for (const image of images) writer.message(1, encodeSelectedImage(image));
	return writer.finish();
}

export function formatImageReadJoinText(path, mime, bytes, dimensions) {
	const name = String(path ?? "").trim() || "image";
	const kind = mime || "image";
	const size = Number.isFinite(bytes) ? `${bytes} bytes` : "image";
	const px = Number.isFinite(dimensions?.width) && Number.isFinite(dimensions?.height)
		? `${dimensions.width}x${dimensions.height}`
		: undefined;
	const original = dimensions?.originalDimensions;
	const scaled = original !== undefined
		? `; downscaled from ${original.width}x${original.height}`
		: "";
	if (px !== undefined) return `${name} (${kind}, ${px}, ${size}${scaled})`;
	return `${name} (${kind}, ${size}${scaled})`;
}
