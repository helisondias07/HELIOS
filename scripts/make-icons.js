"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const outDir = path.join(__dirname, "..", "build");

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
}

const TABLE = crcTable();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function sun(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const radius = size * 0.34;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      const dist = Math.hypot(dx, dy);
      const i = (y * size + x) * 4;
      const ray = Math.cos(Math.atan2(dy, dx) * 8) > 0.55 && dist < radius * 1.35 && dist > radius * 0.72;
      if (dist <= radius || ray) {
        const shade = dist <= radius ? dist / radius : 0.85;
        rgba[i] = Math.round(255 - shade * 28);
        rgba[i + 1] = Math.round(196 - shade * 70);
        rgba[i + 2] = Math.round(92 - shade * 30);
        rgba[i + 3] = 255;
      }
    }
  }
  return rgba;
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y += 1) {
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + (16 * images.length);
  const entries = images.map((image) => {
    const entry = Buffer.alloc(16);
    entry[0] = image.size >= 256 ? 0 : image.size;
    entry[1] = image.size >= 256 ? 0 : image.size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

const brandDir = path.join(outDir, "brand");
if (fs.existsSync(path.join(brandDir, "logo-mark.png")) && fs.existsSync(path.join(outDir, "icon.png"))) {
  console.log("Marca oficial em build/. Os ícones não foram gerados por cima.");
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
const sizes = [16, 32, 48, 256].map((size) => ({ size, png: png(size, sun(size)) }));
fs.writeFileSync(path.join(outDir, "icon.png"), sizes.find((image) => image.size === 256).png);
fs.writeFileSync(path.join(outDir, "tray.png"), sizes.find((image) => image.size === 32).png);
fs.writeFileSync(path.join(outDir, "icon.ico"), ico(sizes));
console.log("ícones em build/");
