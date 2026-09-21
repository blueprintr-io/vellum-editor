import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { zipStore } from '../src/editor/export/binary';
import { extractZip, extractZipFile, svgEntriesFrom, ZIP_LIMITS } from '../src/lib/extract-zip';

const enc = new TextEncoder();
function archive(data: Uint8Array, declaredSize = data.length, method = 0) {
  const zip = zipStore([{ name: 'nested/icon.svg', data }]);
  const view = new DataView(zip.buffer);
  const central = view.getUint32(zip.length - 6, true);
  view.setUint16(8, method, true);
  view.setUint32(22, declaredSize, true);
  view.setUint16(central + 10, method, true);
  view.setUint32(central + 24, declaredSize, true);
  return { zip, view, central };
}

test('stored and raw-deflate library entries keep nested paths and bytes', async () => {
  const svg = '<svg><rect width="12" height="12"/></svg>';
  for (const method of [0, 8]) {
    const data = enc.encode(svg);
    const { zip } = archive(method ? deflateRawSync(data) : data, data.length, method);
    const extracted = await extractZip(zip.buffer);
    assert.deepEqual(extracted.skipped, []);
    assert.deepEqual(svgEntriesFrom(extracted), [{ baseName: 'icon', folder: 'nested', svg }]);
  }
});

test('false small size metadata is bounded while inflating', async () => {
  const data = new Uint8Array(1024 * 1024);
  const { zip } = archive(deflateRawSync(data), 1, 8);
  const result = await extractZip(zip.buffer, { entryBytes: 1024 });
  assert.equal(result.entries.length, 0);
  assert.equal(result.skipped[0].reason, 'entry exceeds size limit');
});

test('decompressed archive limit also applies when metadata lies', async () => {
  const { zip } = archive(deflateRawSync(new Uint8Array(4096)), 1, 8);
  const result = await extractZip(zip.buffer, { entryBytes: 8192, totalBytes: 2048 });
  assert.equal(result.entries.length, 0);
  assert.equal(result.skipped[0].reason, 'archive exceeds total size limit');
});

test('input bytes and entry count are rejected before processing', async () => {
  const { zip } = archive(enc.encode('abc'));
  await assert.rejects(extractZip(zip.buffer, { inputBytes: zip.length - 1 }), /input size limit/);
  await assert.rejects(extractZip(zip.buffer, { entries: 0 }), /entry count limit/);
});

test('truncated and invalid central/local offsets fail with a controlled error', async () => {
  for (const mutate of [
    (view: DataView, central: number) => view.setUint32(central + 42, 0xfffffff0, true),
    (view: DataView) => view.setUint32(0, 0, true),
    (view: DataView, central: number) => view.setUint32(central + 20, 0xfffffff0, true),
    (view: DataView, central: number) => view.setUint16(central + 28, 0xffff, true),
    (view: DataView, central: number) => view.setUint32(central, 0, true),
  ]) {
    const { zip, view, central } = archive(enc.encode('abc'));
    mutate(view, central);
    await assert.rejects(extractZip(zip.buffer), /invalid header or data bounds/);
  }
  for (const length of [0, 3, 21]) await assert.rejects(extractZip(new ArrayBuffer(length)), /end-of-central-directory/);
});

test('truncated output and false stored sizes are not accepted as assets', async () => {
  for (const method of [0, 8]) {
    const data = enc.encode('abcd');
    const { zip } = archive(method ? deflateRawSync(data) : data, data.length + 1, method);
    const result = await extractZip(zip.buffer);
    assert.equal(result.entries.length, 0);
    assert.match(result.skipped[0].reason, /size does not match/);
  }
});

test('inflation cancels the reader as soon as a chunk crosses the limit', async () => {
  const original = globalThis.DecompressionStream;
  let reads = 0;
  let cancelled = false;
  const fake = class {
    readable = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    writable = new WritableStream();
  };
  Object.defineProperty(globalThis, 'DecompressionStream', { configurable: true, value: fake });
  try {
    const { zip } = archive(enc.encode('compressed'), 1, 8);
    const result = await extractZip(zip.buffer, { entryBytes: 2048 });
    assert.equal(result.entries.length, 0);
    assert.equal(reads, 3);
    assert.equal(cancelled, true);
  } finally {
    Object.defineProperty(globalThis, 'DecompressionStream', { configurable: true, value: original });
  }
});


test('oversized input files are rejected before their bytes are allocated', async () => {
  let read = false;
  await assert.rejects(extractZipFile({
    size: ZIP_LIMITS.inputBytes + 1,
    arrayBuffer: async () => { read = true; return new ArrayBuffer(0); },
  }), /input size limit/);
  assert.equal(read, false);
});


test('unavailable raw-deflate support is reported as an import warning', async () => {
  const original = globalThis.DecompressionStream;
  Object.defineProperty(globalThis, 'DecompressionStream', {
    configurable: true,
    value: class { constructor() { throw new Error('raw-deflate unsupported'); } },
  });
  try {
    const { zip } = archive(deflateRawSync(enc.encode('abc')), 3, 8);
    const result = await extractZip(zip.buffer);
    assert.equal(result.entries.length, 0);
    assert.equal(result.skipped[0].reason, 'raw-deflate unsupported');
  } finally {
    Object.defineProperty(globalThis, 'DecompressionStream', { configurable: true, value: original });
  }
});
