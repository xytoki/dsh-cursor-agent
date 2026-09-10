/**
 * User-message SelectedImage and LocalRead image/binary classification.
 */
import { test } from "@rstest/core";
import assert from "node:assert/strict";
import { Reader } from "../src/proto";
import {
	binaryUnsupportedReason,
	buildRunPayload,
	classifyTurnIngress,
	collectImageBlocks,
	contentHasImages,
	encodeSelectedImage,
	execRead,
	imageMimeFromPath,
	isNotTextError,
	READ_IMAGE_NORMALIZATION,
	resizeReadImage,
	resolveSelectedImages,
	sniffImageMime,
	translateNativeExec,
} from "../src/index";

/** Valid 1×1 RGBA PNG (passthrough-sized). */
const PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a,
	0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00,
	0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
	0xae, 0x42, 0x60, 0x82,
]);
const JPEG = Uint8Array.from([255, 216, 255, 224, 0, 16]);
const BIN = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);

function imageRef(name = "shot.png") {
	return {
		attachmentId: `sha256:${"ab".repeat(32)}`,
		mediaType: "image/png",
		bytes: PNG.length,
		width: 2,
		height: 2,
		name,
	};
}

test("sniffImageMime and path fallback match Cursor's formats", () => {
	assert.equal(sniffImageMime(PNG), "image/png");
	assert.equal(sniffImageMime(JPEG), "image/jpeg");
	assert.equal(sniffImageMime(Uint8Array.from([71, 73, 70, 56, 57, 97])), "image/gif");
	assert.equal(sniffImageMime(Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80])), "image/webp");
	assert.equal(sniffImageMime(BIN), undefined);
	assert.equal(imageMimeFromPath("a.PNG"), "image/png");
	assert.equal(imageMimeFromPath("a.bin"), undefined);
	assert.equal(binaryUnsupportedReason("a.bin"), "Binary files of type .bin are not supported by the read executor");
	assert.match(binaryUnsupportedReason("a"), /without an extension/);
	assert.equal(isNotTextError({ code: "FS_NOT_TEXT" }), true);
	assert.equal(isNotTextError({ message: 'cannot read "x": binary file' }), true);
});

test("collectImageBlocks skips plugin injects and keeps human images", () => {
	const human = {
		role: "user",
		content: [
			{ type: "text", text: "see this" },
			{ type: "image", attachment: imageRef() },
		],
	};
	const plugin = {
		role: "user",
		source: { kind: "plugin", plugin: "x" },
		content: [{ type: "image", attachment: imageRef("plug.png") }],
	};
	assert.equal(contentHasImages(human.content), true);
	assert.equal(collectImageBlocks([human, plugin]).length, 1);
	const classified = classifyTurnIngress({
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", id: "img", content: [{ type: "image", attachment: imageRef() }] },
		],
	});
	assert.equal(classified.users.length, 1);
	assert.equal(classified.users[0].text, "");
});

test("resolveSelectedImages projects attachments onto SelectedImage payloads", async () => {
	const attachment = imageRef();
	const stored = {
		data: PNG,
		mediaType: "image/png",
		width: 8,
		height: 6,
	};
	const images = await resolveSelectedImages(
		[{ type: "image", attachment }],
		{ readImageRequest: async (ref) => {
			assert.equal(ref.attachmentId, attachment.attachmentId);
			return stored;
		} },
	);
	assert.equal(images.length, 1);
	assert.equal(images[0].mimeType, "image/png");
	assert.equal(images[0].width, 8);
	assert.deepEqual(images[0].data, PNG);
	await assert.rejects(
		() => resolveSelectedImages([{ type: "image", attachment }], undefined),
		/attachment service/,
	);
});

test("encodeSelectedImage writes inline data on field 8", () => {
	const encoded = encodeSelectedImage({
		uuid: "u1",
		path: "shot.png",
		mimeType: "image/png",
		width: 2,
		height: 2,
		data: PNG,
	});
	const reader = new Reader(encoded);
	const fields = [];
	while (!reader.done) {
		const tag = reader.tag();
		fields.push(tag.field);
		if (tag.wireType === 2) reader.bytes();
		else reader.skip(tag.wireType);
	}
	assert.deepEqual(fields, [8, 2, 3, 4, 7]);
});

test("buildRunPayload attaches selected_images on the user action", () => {
	const { payload } = buildRunPayload({
		messages: [{ role: "user", content: [{ type: "text", text: "what's this" }] }],
		selectedImages: [{
			uuid: "img-1",
			path: "shot.png",
			mimeType: "image/png",
			width: 2,
			height: 2,
			data: PNG,
		}],
	}, "grok-4.6");
	const envelope = new Reader(payload);
	assert.equal(envelope.tag().field, 1);
	const request = new Reader(envelope.bytes());
	let action;
	while (!request.done) {
		const tag = request.tag();
		if (tag.field === 2 && tag.wireType === 2) action = request.bytes();
		else if (tag.wireType === 2) request.bytes();
		else request.skip(tag.wireType);
	}
	const conversationAction = new Reader(action);
	assert.equal(conversationAction.tag().field, 1);
	const userAction = new Reader(conversationAction.bytes());
	assert.equal(userAction.tag().field, 1);
	const user = new Reader(userAction.bytes());
	const userFields = [];
	while (!user.done) {
		const tag = user.tag();
		userFields.push(tag.field);
		if (tag.wireType === 2) user.bytes();
		else user.skip(tag.wireType);
	}
	assert.ok(userFields.includes(3), "selected_context must be present");
});

test("execRead returns image data and rejects non-image binary", async () => {
	const files = new Map([
		["shot.png", { kind: "image", data: PNG }],
		["blob.bin", { kind: "binary", data: BIN }],
		["notes.txt", { kind: "text", data: "hello" }],
	]);
	const world = {
		agent: { session: { header: { cwd: "/work" } } },
		fs: {
			resolve: async (path) => ({ displayPath: String(path) }),
			stat: async (target) => (files.has(target.displayPath) ? { type: "file", size: 4 } : undefined),
			readText: async (target) => {
				const file = files.get(target.displayPath);
				if (file === undefined) throw new Error(`cannot read "${target.displayPath}": not found`);
				if (file.kind !== "text") {
					const error = new Error(`cannot read "${target.displayPath}": binary file`);
					error.code = "FS_NOT_TEXT";
					throw error;
				}
				return file.data;
			},
			readBytes: async (target) => files.get(target.displayPath).data,
		},
	};
	const image = await execRead(world, { path: "shot.png" });
	assert.equal(image.kind, "image");
	assert.equal(image.mime, "image/png");
	assert.equal(image.width, 1);
	assert.equal(image.height, 1);
	assert.ok(image.data instanceof Uint8Array);
	assert.equal(image.data[0], 137);
	await assert.rejects(() => execRead(world, { path: "blob.bin" }), /not supported by the read executor/);
	const text = await execRead(world, { path: "notes.txt" });
	assert.equal(text.kind, "text");
	assert.equal(text.content, "hello");
});

test("translateNativeExec encodes ReadSuccess.data for an image extras payload", () => {
	const translated = translateNativeExec({
		case: "readArgs",
		args: { path: "shot.png" },
	});
	const encoded = translated.encode("", false, { data: PNG, fileSize: PNG.length });
	const result = new Reader(encoded);
	assert.equal(result.tag().field, 1);
	const success = new Reader(result.bytes());
	const fields = [];
	while (!success.done) {
		const tag = success.tag();
		fields.push(tag.field);
		if (tag.wireType === 2) success.bytes();
		else success.skip(tag.wireType);
	}
	assert.ok(fields.includes(5));
	assert.equal(fields.includes(2), false);
	const invalid = translated.encode("Binary files of type .bin are not supported by the read executor", true, {
		invalidFile: true,
	});
	assert.equal(new Reader(invalid).tag().field, 6);
});

test("resizeReadImage downscales past the DSH pixel budget", async () => {
	const { crc32, deflateSync } = await import("node:zlib");
	const side = Math.ceil(Math.sqrt(READ_IMAGE_NORMALIZATION.maxPixels)) + 1;
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(side, 0);
	ihdr.writeUInt32BE(side, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const stride = side * 3 + 1;
	const raw = Buffer.alloc(stride * side);
	for (let y = 0; y < side; y++) {
		const row = y * stride;
		for (let x = 0; x < side; x++) {
			raw[row + 1 + x * 3] = 200;
			raw[row + 2 + x * 3] = 40;
			raw[row + 3 + x * 3] = 40;
		}
	}
	const chunk = (type, data) => {
		const typeBytes = Buffer.from(type);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0);
		return Buffer.concat([length, typeBytes, data, crc]);
	};
	const source = Uint8Array.from(Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]));
	const resized = await resizeReadImage(source, "image/png", "wide.png");
	assert.ok(resized.width * resized.height <= READ_IMAGE_NORMALIZATION.maxPixels);
	assert.ok(resized.width < side || resized.height < side);
	assert.deepEqual(resized.originalDimensions, { width: side, height: side });
	assert.ok(resized.data.length > 0);
});
