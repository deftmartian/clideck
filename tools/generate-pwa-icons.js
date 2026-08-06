#!/usr/bin/env node

const { readFileSync, writeFileSync, mkdirSync } = require('fs');
const { join } = require('path');
const zlib = require('zlib');

const root = join(__dirname, '..');
const sourcePath = join(root, 'public', 'img', 'clideck-logo-icon.png');
const outputDir = join(root, 'public', 'icons');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodeRgbaPng(buffer) {
  const signature = buffer.subarray(0, 8);
  if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('Source is not a PNG.');
  }

  let width;
  let height;
  const compressed = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error('Expected an 8-bit, non-interlaced RGBA PNG.');
      }
    } else if (type === 'IDAT') {
      compressed.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!width || !height || !compressed.length) throw new Error('PNG is missing image data.');
  const filtered = zlib.inflateSync(Buffer.concat(compressed));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;

  for (let y = 0; y < height; y++) {
    const filter = filtered[sourceOffset++];
    const rowOffset = y * stride;
    const previousOffset = rowOffset - stride;
    for (let x = 0; x < stride; x++) {
      const raw = filtered[sourceOffset++];
      const left = x >= 4 ? pixels[rowOffset + x - 4] : 0;
      const up = y > 0 ? pixels[previousOffset + x] : 0;
      const upLeft = y > 0 && x >= 4 ? pixels[previousOffset + x - 4] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) value = raw + paeth(left, up, upLeft);
      else throw new Error(`Unsupported PNG filter ${filter}.`);
      pixels[rowOffset + x] = value & 0xff;
    }
  }

  return { width, height, pixels };
}

function resize(image, width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.max(0, Math.min(image.height - 1, ((y + 0.5) * image.height / height) - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fy = sourceY - y0;
    for (let x = 0; x < width; x++) {
      const sourceX = Math.max(0, Math.min(image.width - 1, ((x + 0.5) * image.width / width) - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const fx = sourceX - x0;
      const weights = [
        [(y0 * image.width + x0) * 4, (1 - fx) * (1 - fy)],
        [(y0 * image.width + x1) * 4, fx * (1 - fy)],
        [(y1 * image.width + x0) * 4, (1 - fx) * fy],
        [(y1 * image.width + x1) * 4, fx * fy],
      ];
      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (const [offset, weight] of weights) {
        const a = image.pixels[offset + 3] / 255;
        alpha += a * weight;
        red += image.pixels[offset] * a * weight;
        green += image.pixels[offset + 1] * a * weight;
        blue += image.pixels[offset + 2] * a * weight;
      }
      const output = (y * width + x) * 4;
      pixels[output] = alpha ? Math.round(red / alpha) : 0;
      pixels[output + 1] = alpha ? Math.round(green / alpha) : 0;
      pixels[output + 2] = alpha ? Math.round(blue / alpha) : 0;
      pixels[output + 3] = Math.round(alpha * 255);
    }
  }
  return { width, height, pixels };
}

function composite(image, size, inset, background) {
  const canvas = {
    width: size,
    height: size,
    pixels: Buffer.alloc(size * size * 4),
  };
  for (let i = 0; i < size * size; i++) {
    canvas.pixels.set(background, i * 4);
  }

  const scaled = resize(image, inset, inset);
  const origin = Math.floor((size - inset) / 2);
  for (let y = 0; y < inset; y++) {
    for (let x = 0; x < inset; x++) {
      const source = (y * inset + x) * 4;
      const target = ((origin + y) * size + origin + x) * 4;
      const alpha = scaled.pixels[source + 3] / 255;
      for (let channel = 0; channel < 3; channel++) {
        canvas.pixels[target + channel] = Math.round(
          scaled.pixels[source + channel] * alpha
          + canvas.pixels[target + channel] * (1 - alpha),
        );
      }
      canvas.pixels[target + 3] = 255;
    }
  }
  return canvas;
}

function encodeRgbaPng(image) {
  const raw = Buffer.alloc((image.width * 4 + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    const target = y * (image.width * 4 + 1);
    raw[target] = 0;
    image.pixels.copy(raw, target + 1, y * image.width * 4, (y + 1) * image.width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND'),
  ]);
}

const source = decodeRgbaPng(readFileSync(sourcePath));
const dark = [15, 23, 42, 255];
const outputs = [
  ['clideck-192.png', resize(source, 192, 192)],
  ['clideck-512.png', resize(source, 512, 512)],
  ['clideck-maskable-512.png', composite(source, 512, 384, dark)],
  ['clideck-apple-180.png', composite(source, 180, 154, dark)],
];

mkdirSync(outputDir, { recursive: true });
for (const [name, image] of outputs) {
  writeFileSync(join(outputDir, name), encodeRgbaPng(image));
  console.log(`${name}: ${image.width}x${image.height}`);
}
