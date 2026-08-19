'use strict';

function splitUtf8Chunks(value, maxBytes) {
  const text = String(value || '');
  if (!text) return [];
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be positive');
  const totalBytes = Buffer.byteLength(text);
  if (totalBytes <= maxBytes) return [{ data: text, bytes: totalBytes }];

  const chunks = [];
  let start = 0;
  let index = 0;
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes && bytes + characterBytes > maxBytes) {
      chunks.push({ data: text.slice(start, index), bytes });
      start = index;
      bytes = 0;
    }
    bytes += characterBytes;
    index += character.length;
    if (bytes >= maxBytes) {
      chunks.push({ data: text.slice(start, index), bytes });
      start = index;
      bytes = 0;
    }
  }
  if (start < text.length) chunks.push({ data: text.slice(start), bytes });
  return chunks;
}

function trimUtf8Prefix(text, minimumBytes) {
  let removedBytes = 0;
  let removedUnits = 0;
  for (const character of text) {
    removedBytes += Buffer.byteLength(character);
    removedUnits += character.length;
    if (removedBytes >= minimumBytes) break;
  }
  return {
    data: text.slice(removedUnits),
    removedBytes,
    removedUnits,
  };
}

class ReplayRing {
  constructor(maxBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be positive');
    this.maxBytes = maxBytes;
    this.byteLength = 0;
    this.startSeq = 0;
    this.endSeq = 0;
    this.chunks = [];
    this.head = 0;
  }

  append(value, startSeq = this.endSeq) {
    const data = String(value || '');
    if (!data) return this.endSeq;
    if (!Number.isSafeInteger(startSeq) || startSeq !== this.endSeq) {
      throw new RangeError('ReplayRing appends must be contiguous');
    }
    const bytes = Buffer.byteLength(data);
    const endSeq = startSeq + data.length;
    this.chunks.push({ data, bytes, startSeq, endSeq });
    this.byteLength += bytes;
    this.endSeq = endSeq;
    this._trim();
    return endSeq;
  }

  _trim() {
    while (this.byteLength > this.maxBytes && this.head < this.chunks.length) {
      const excess = this.byteLength - this.maxBytes;
      const first = this.chunks[this.head];
      if (first.bytes <= excess) {
        this.byteLength -= first.bytes;
        this.startSeq = first.endSeq;
        this.head += 1;
        continue;
      }
      const trimmed = trimUtf8Prefix(first.data, excess);
      first.data = trimmed.data;
      first.bytes -= trimmed.removedBytes;
      first.startSeq += trimmed.removedUnits;
      this.byteLength -= trimmed.removedBytes;
      this.startSeq = first.startSeq;
    }
    if (this.head >= this.chunks.length) {
      this.chunks = [];
      this.head = 0;
      this.startSeq = this.endSeq;
    } else if (this.head > 1024 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  contains(startSeq, endSeq = this.endSeq) {
    return Number.isSafeInteger(startSeq)
      && Number.isSafeInteger(endSeq)
      && startSeq >= this.startSeq
      && startSeq <= endSeq
      && endSeq <= this.endSeq;
  }

  slice(startSeq, endSeq = this.endSeq) {
    if (!this.contains(startSeq, endSeq)) return null;
    if (startSeq === endSeq) return '';
    const parts = [];
    for (let index = this.head; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index];
      if (chunk.endSeq <= startSeq) continue;
      if (chunk.startSeq >= endSeq) break;
      const from = Math.max(startSeq, chunk.startSeq) - chunk.startSeq;
      const to = Math.min(endSeq, chunk.endSeq) - chunk.startSeq;
      parts.push(chunk.data.slice(from, to));
    }
    return parts.length === 1 ? parts[0] : parts.join('');
  }

  suffix(maxCodeUnits) {
    const start = Math.max(this.startSeq, this.endSeq - Math.max(0, Number(maxCodeUnits) || 0));
    return this.slice(start, this.endSeq) || '';
  }

  *segments(startSeq, endSeq = this.endSeq, maxBytes = this.maxBytes) {
    if (!this.contains(startSeq, endSeq)) return;
    for (let index = this.head; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index];
      if (chunk.endSeq <= startSeq) continue;
      if (chunk.startSeq >= endSeq) break;
      const from = Math.max(startSeq, chunk.startSeq) - chunk.startSeq;
      const to = Math.min(endSeq, chunk.endSeq) - chunk.startSeq;
      const selected = chunk.data.slice(from, to);
      let segmentStart = chunk.startSeq + from;
      for (const segment of splitUtf8Chunks(selected, maxBytes)) {
        const segmentEnd = segmentStart + segment.data.length;
        yield { ...segment, startSeq: segmentStart, endSeq: segmentEnd };
        segmentStart = segmentEnd;
      }
    }
  }
}

module.exports = { ReplayRing, splitUtf8Chunks, trimUtf8Prefix };
