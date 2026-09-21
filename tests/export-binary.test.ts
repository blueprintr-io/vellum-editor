import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync, inflateSync } from 'node:zlib';

import {
  buildPdf,
  concatBytes,
  crc32,
  insertPngChunks,
  isPng,
  jpegWithDensity,
  pngPhysChunk,
  pngTextChunk,
  readPngChunks,
  readPngText,
  writePngChunk,
  zipStore,
  PNG_SIGNATURE,
} from '../src/editor/export/binary';
import {
  extractEmbeddedSource,
  extractSourceFromPng,
  extractSourceFromSvg,
  looksLikeSvg,
  PNG_SOURCE_KEYWORD,
} from '../src/editor/export/source';

const enc = new TextEncoder();

/** A minimal, decoder-valid 1×1 PNG: signature, IHDR, IDAT (deflated
 *  filter byte + RGBA pixel), IEND. */
function tinyPng(): Uint8Array {
  const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const raw = new Uint8Array([0, 255, 0, 0, 255]); // filter 0 + red pixel
  const idat = new Uint8Array(deflateSync(raw));
  return concatBytes([
    PNG_SIGNATURE,
    writePngChunk('IHDR', ihdr),
    writePngChunk('IDAT', idat),
    writePngChunk('IEND', new Uint8Array(0)),
  ]);
}

/* ── CRC32 ─────────────────────────────────────────────────────────── */

test('crc32 matches the reference vectors', () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(enc.encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

/* ── PNG ───────────────────────────────────────────────────────────── */

test('PNG chunk writer produces the canonical IEND bytes', () => {
  const iend = writePngChunk('IEND', new Uint8Array(0));
  assert.deepEqual(Array.from(iend), [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
});

test('PNG chunks round-trip and ancillary chunks land after IHDR', () => {
  const png = tinyPng();
  assert.equal(isPng(png), true);
  assert.deepEqual(
    readPngChunks(png).map((c) => c.type),
    ['IHDR', 'IDAT', 'IEND'],
  );
  const yaml = 'version: workspace-1.0\ntabs:\n  - id: t1\n    diagram: {}\n';
  const out = insertPngChunks(png, [pngPhysChunk(192), pngTextChunk(PNG_SOURCE_KEYWORD, yaml)]);
  const types = readPngChunks(out).map((c) => c.type);
  assert.deepEqual(types, ['IHDR', 'pHYs', 'iTXt', 'IDAT', 'IEND']);
  // pHYs: 192 dpi → 7559 pixels per metre, unit 1.
  const phys = readPngChunks(out).find((c) => c.type === 'pHYs')!;
  assert.deepEqual(Array.from(phys.data), [0, 0, 0x1d, 0x87, 0, 0, 0x1d, 0x87, 1]);
  assert.equal(readPngText(out, PNG_SOURCE_KEYWORD), yaml);
  assert.equal(readPngText(out, 'other'), null);
  // Every chunk CRC still validates.
  let o = 8;
  while (o < out.length) {
    const len = (out[o] << 24) | (out[o + 1] << 16) | (out[o + 2] << 8) | out[o + 3];
    const body = out.subarray(o + 4, o + 8 + len);
    const crc =
      ((out[o + 8 + len] << 24) |
        (out[o + 9 + len] << 16) |
        (out[o + 10 + len] << 8) |
        out[o + 11 + len]) >>>
      0;
    assert.equal(crc32(body), crc);
    o += 12 + len;
  }
  // The image data is untouched.
  const idat = readPngChunks(out).find((c) => c.type === 'IDAT')!;
  assert.deepEqual(Array.from(inflateSync(idat.data)), [0, 255, 0, 0, 255]);
});

test('readPngText decodes UTF-8 and rejects non-PNG input', () => {
  const text = 'label: “naïve” — λ';
  const out = insertPngChunks(tinyPng(), [pngTextChunk('k', text)]);
  assert.equal(readPngText(out, 'k'), text);
  assert.equal(readPngText(enc.encode('not a png'), 'k'), null);
  assert.throws(() => readPngChunks(enc.encode('nope')), /Not a PNG/);
});

/* ── JPEG ──────────────────────────────────────────────────────────── */

test('jpegWithDensity rewrites an existing JFIF APP0 and inserts one when missing', () => {
  // SOI + JFIF APP0 (density 1×1, no units) + EOI
  const withApp0 = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
  ]);
  const a = jpegWithDensity(withApp0, 288);
  assert.equal(a.length, withApp0.length);
  assert.equal(a[13], 1); // units = dpi
  assert.equal((a[14] << 8) | a[15], 288);
  assert.equal((a[16] << 8) | a[17], 288);
  const bare = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const b = jpegWithDensity(bare, 96);
  assert.equal(b.length, bare.length + 18);
  assert.deepEqual(Array.from(b.subarray(0, 4)), [0xff, 0xd8, 0xff, 0xe0]);
  assert.equal((b[14] << 8) | b[15], 96);
  assert.deepEqual(Array.from(b.subarray(b.length - 2)), [0xff, 0xd9]);
  // Not a JPEG → untouched copy.
  assert.deepEqual(Array.from(jpegWithDensity(enc.encode('abcd'), 96)), Array.from(enc.encode('abcd')));
});

/* ── ZIP ───────────────────────────────────────────────────────────── */

test('zipStore writes a parseable stored archive', () => {
  const a = enc.encode('hello');
  const b = enc.encode('wörld');
  const zip = zipStore(
    [
      { name: '01-first.png', data: a },
      { name: 'dir/02-zwei.svg', data: b },
    ],
    new Date(2026, 7, 22, 12, 30, 0),
  );
  // Local header signature at 0, central directory + EOCD at the end.
  assert.deepEqual(Array.from(zip.subarray(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
  const eocd = zip.length - 22;
  assert.deepEqual(Array.from(zip.subarray(eocd, eocd + 4)), [0x50, 0x4b, 0x05, 0x06]);
  const entries = zip[eocd + 10] | (zip[eocd + 11] << 8);
  assert.equal(entries, 2);
  const cdSize = zip[eocd + 12] | (zip[eocd + 13] << 8) | (zip[eocd + 14] << 16) | (zip[eocd + 15] << 24);
  const cdOffset = zip[eocd + 16] | (zip[eocd + 17] << 8) | (zip[eocd + 18] << 16) | (zip[eocd + 19] << 24);
  assert.equal(cdOffset + cdSize, eocd);
  assert.deepEqual(Array.from(zip.subarray(cdOffset, cdOffset + 4)), [0x50, 0x4b, 0x01, 0x02]);
  // First local entry: method 0, crc of "hello", sizes, name, data.
  const method = zip[8] | (zip[9] << 8);
  assert.equal(method, 0);
  const crc = (zip[14] | (zip[15] << 8) | (zip[16] << 16) | (zip[17] << 24)) >>> 0;
  assert.equal(crc, crc32(a));
  const nameLen = zip[26] | (zip[27] << 8);
  assert.equal(new TextDecoder().decode(zip.subarray(30, 30 + nameLen)), '01-first.png');
  assert.equal(new TextDecoder().decode(zip.subarray(30 + nameLen, 30 + nameLen + a.length)), 'hello');
});

/* ── PDF ───────────────────────────────────────────────────────────── */

test('buildPdf emits a well-formed multi-page image PDF', () => {
  const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]); // 2×2
  const page = { width: 2, height: 2, dpi: 96, rgb, filter: null as null };
  const deflated = {
    width: 2,
    height: 2,
    dpi: 192,
    rgb: new Uint8Array(deflateSync(rgb)),
    filter: 'FlateDecode' as const,
  };
  const pdf = buildPdf([page, deflated], { title: 'Tëst ✓', date: new Date(2026, 7, 22, 9, 0, 0) });
  const text = new TextDecoder('latin1').decode(pdf);
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Type \/Catalog \/Pages 2 0 R/);
  assert.match(text, /\/Type \/Pages \/Kids \[\d+ 0 R \d+ 0 R\] \/Count 2/);
  // 2 px at 96 dpi = 1.5 pt; at 192 dpi = 0.75 pt.
  assert.match(text, /\/MediaBox \[0 0 1\.5000 1\.5000\]/);
  assert.match(text, /\/MediaBox \[0 0 0\.7500 0\.7500\]/);
  assert.match(text, /\/Filter \/FlateDecode/);
  assert.match(text, /\/Title <FEFF005400EB0073007400202713>/i);
  assert.match(text, /\/CreationDate \(D:20260822090000\)/);
  // xref offsets point at "N 0 obj".
  const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
  assert.equal(text.slice(startxref, startxref + 4), 'xref');
  const lines = text.slice(startxref).split('\n');
  const count = Number(lines[1].split(' ')[1]);
  for (let i = 1; i < count; i++) {
    const off = Number(lines[2 + i].slice(0, 10));
    assert.equal(text.slice(off, off + `${i} 0 obj`.length), `${i} 0 obj`);
  }
});

/* ── embedded source ───────────────────────────────────────────────── */

test('extractEmbeddedSource finds the diagram in PNG and SVG, not elsewhere', () => {
  const yaml = 'version: workspace-1.0\nactiveTabId: a\ntabs: []\n';
  const png = insertPngChunks(tinyPng(), [pngTextChunk(PNG_SOURCE_KEYWORD, yaml)]);
  assert.equal(extractSourceFromPng(png), yaml);
  assert.equal(extractEmbeddedSource(png), yaml);
  assert.equal(extractEmbeddedSource(tinyPng()), null);

  const svg = `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><style/><metadata id="vellum-source" data-type="application/x-vellum+yaml">label: a &lt;b&gt; &amp; c\nversion: 1</metadata><rect/></svg>`;
  assert.equal(looksLikeSvg(svg), true);
  assert.equal(extractSourceFromSvg(svg), 'label: a <b> & c\nversion: 1');
  assert.equal(extractEmbeddedSource(enc.encode(svg)), 'label: a <b> & c\nversion: 1');
  assert.equal(
    extractSourceFromSvg('<svg><metadata id="vellum-source"><![CDATA[x: <1>]]></metadata></svg>'),
    'x: <1>',
  );
  assert.equal(extractSourceFromSvg('<svg><metadata>nope</metadata></svg>'), null);
  assert.equal(extractEmbeddedSource(enc.encode('plain text, not svg')), null);
  assert.equal(extractEmbeddedSource(new Uint8Array([0, 1, 2, 3])), null);
});
