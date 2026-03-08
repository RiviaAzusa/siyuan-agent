#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) {
			crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function paethPredictor(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

function parsePng(buffer) {
	if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
		throw new Error("Not a PNG file");
	}

	let offset = 8;
	const chunks = [];

	while (offset < buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
		const data = buffer.subarray(offset + 8, offset + 8 + length);
		const crc = buffer.readUInt32BE(offset + 8 + length);
		chunks.push({ length, type, data, crc });
		offset += 12 + length;
		if (type === "IEND") break;
	}

	const ihdr = chunks.find((chunk) => chunk.type === "IHDR");
	if (!ihdr) throw new Error("PNG missing IHDR");

	const width = ihdr.data.readUInt32BE(0);
	const height = ihdr.data.readUInt32BE(4);
	const bitDepth = ihdr.data.readUInt8(8);
	const colorType = ihdr.data.readUInt8(9);
	const compression = ihdr.data.readUInt8(10);
	const filterMethod = ihdr.data.readUInt8(11);
	const interlace = ihdr.data.readUInt8(12);

	if (bitDepth !== 8 || colorType !== 6 || compression !== 0 || filterMethod !== 0 || interlace !== 0) {
		throw new Error("Only supports non-interlaced 8-bit RGBA PNGs");
	}

	const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
	const raw = zlib.inflateSync(idat);
	const stride = width * 4;
	const pixels = Buffer.alloc(width * height * 4);

	for (let y = 0; y < height; y++) {
		const rowStart = y * (stride + 1);
		const filter = raw[rowStart];
		const row = raw.subarray(rowStart + 1, rowStart + 1 + stride);
		const prevRowStart = (y - 1) * stride;
		const outRowStart = y * stride;

		for (let x = 0; x < stride; x++) {
			const left = x >= 4 ? pixels[outRowStart + x - 4] : 0;
			const up = y > 0 ? pixels[prevRowStart + x] : 0;
			const upLeft = y > 0 && x >= 4 ? pixels[prevRowStart + x - 4] : 0;
			let value = row[x];
			switch (filter) {
				case 0:
					break;
				case 1:
					value = (value + left) & 0xff;
					break;
				case 2:
					value = (value + up) & 0xff;
					break;
				case 3:
					value = (value + Math.floor((left + up) / 2)) & 0xff;
					break;
				case 4:
					value = (value + paethPredictor(left, up, upLeft)) & 0xff;
					break;
				default:
					throw new Error(`Unsupported PNG filter type: ${filter}`);
			}
			pixels[outRowStart + x] = value;
		}
	}

	return { chunks, width, height, pixels };
}

function encodePng(parsed) {
	const { chunks, width, height, pixels } = parsed;
	const stride = width * 4;
	const raw = Buffer.alloc(height * (stride + 1));

	for (let y = 0; y < height; y++) {
		const rowStart = y * (stride + 1);
		raw[rowStart] = 0;
		pixels.copy(raw, rowStart + 1, y * stride, y * stride + stride);
	}

	const compressed = zlib.deflateSync(raw);
	const out = [PNG_SIGNATURE];

	for (const chunk of chunks) {
		if (chunk.type === "IDAT") continue;
		if (chunk.type === "IEND") {
			out.push(makeChunk("IDAT", compressed));
		}
		out.push(makeChunk(chunk.type, chunk.data));
	}

	return Buffer.concat(out);
}

function makeChunk(type, data) {
	const typeBuffer = Buffer.from(type, "ascii");
	const lengthBuffer = Buffer.alloc(4);
	lengthBuffer.writeUInt32BE(data.length, 0);
	const crcBuffer = Buffer.alloc(4);
	crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
	return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function drawValidationMark(parsed) {
	const { width, height, pixels } = parsed;
	const accent = { r: 255, g: 0, b: 200, a: 255 };
	const markSize = Math.max(18, Math.round(Math.min(width, height) * 0.18));

	for (let y = 0; y < markSize; y++) {
		for (let x = 0; x < markSize; x++) {
			const idx = (y * width + x) * 4;
			pixels[idx] = accent.r;
			pixels[idx + 1] = accent.g;
			pixels[idx + 2] = accent.b;
			pixels[idx + 3] = accent.a;
		}
	}

	const startX = Math.round(width * 0.22);
	const startY = Math.round(height * 0.55);
	const midX = Math.round(width * 0.42);
	const midY = Math.round(height * 0.74);
	const endX = Math.round(width * 0.78);
	const endY = Math.round(height * 0.28);
	const thickness = Math.max(5, Math.round(width * 0.045));

	drawLine(parsed, startX, startY, midX, midY, accent, thickness);
	drawLine(parsed, midX, midY, endX, endY, accent, thickness);
}

function drawLine(parsed, x0, y0, x1, y1, color, thickness) {
	const dx = Math.abs(x1 - x0);
	const dy = Math.abs(y1 - y0);
	const sx = x0 < x1 ? 1 : -1;
	const sy = y0 < y1 ? 1 : -1;
	let err = dx - dy;

	while (true) {
		drawDot(parsed, x0, y0, color, thickness);
		if (x0 === x1 && y0 === y1) break;
		const e2 = err * 2;
		if (e2 > -dy) {
			err -= dy;
			x0 += sx;
		}
		if (e2 < dx) {
			err += dx;
			y0 += sy;
		}
	}
}

function drawDot(parsed, cx, cy, color, radius) {
	const { width, height, pixels } = parsed;
	for (let y = cy - radius; y <= cy + radius; y++) {
		if (y < 0 || y >= height) continue;
		for (let x = cx - radius; x <= cx + radius; x++) {
			if (x < 0 || x >= width) continue;
			if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue;
			const idx = (y * width + x) * 4;
			pixels[idx] = color.r;
			pixels[idx + 1] = color.g;
			pixels[idx + 2] = color.b;
			pixels[idx + 3] = color.a;
		}
	}
}

function main() {
	const target = path.resolve(process.cwd(), process.argv[2] || "dist/icon.png");
	const backup = `${target}.bak`;

	const input = fs.readFileSync(target);
	if (!fs.existsSync(backup)) {
		fs.writeFileSync(backup, input);
	}

	const parsed = parsePng(input);
	drawValidationMark(parsed);
	const output = encodePng(parsed);
	fs.writeFileSync(target, output);

	console.log(`Updated ${path.relative(process.cwd(), target)} for validation.`);
	console.log(`Backup saved at ${path.relative(process.cwd(), backup)}.`);
}

main();
