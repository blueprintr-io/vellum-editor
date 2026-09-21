import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_EXPORT_PREFS,
  MAX_PADDING,
  MAX_RASTER_EDGE,
  MAX_RASTER_PIXELS,
  MAX_SCALE,
  clampScale,
  clampScaleToEdge,
  dpiForScale,
  exportFilename,
  formatDimensions,
  hasQuality,
  isRasterFormat,
  mimeTypeFor,
  nearestWeight,
  parseFamilyList,
  parseUnicodeRange,
  rangesCoverAny,
  rasterSize,
  resolveBackground,
  sanitizeExportPrefs,
  sanitizeFilenameBase,
  scaleForWidth,
  stripImageExtension,
  supportsAlpha,
  supportsEmbeddedSource,
} from '../src/editor/export/options';

/* ── prefs ─────────────────────────────────────────────────────────── */

test('sanitizeExportPrefs backfills missing keys with defaults', () => {
  assert.deepEqual(sanitizeExportPrefs({}), DEFAULT_EXPORT_PREFS);
  assert.deepEqual(sanitizeExportPrefs(undefined), DEFAULT_EXPORT_PREFS);
  assert.deepEqual(sanitizeExportPrefs('garbage'), DEFAULT_EXPORT_PREFS);
});

test('sanitizeExportPrefs clamps numbers and rejects unknown enum values', () => {
  const p = sanitizeExportPrefs({
    scale: 40,
    padding: -10,
    background: 'plaid',
    customColor: '  ',
    embedFonts: 'yes',
    format: 'bmp',
    quality: 0.1,
    theme: 'sepia',
    embedSource: 'no',
  });
  assert.equal(p.scale, MAX_SCALE);
  assert.equal(p.padding, 0);
  assert.equal(p.background, 'paper');
  assert.equal(p.customColor, DEFAULT_EXPORT_PREFS.customColor);
  assert.equal(p.embedFonts, DEFAULT_EXPORT_PREFS.embedFonts);
  assert.equal(p.format, 'png');
  assert.equal(p.quality, 0.5);
  assert.equal(p.theme, 'current');
  assert.equal(p.embedSource, false);
  assert.equal(sanitizeExportPrefs({ padding: 9999 }).padding, MAX_PADDING);
  assert.equal(sanitizeExportPrefs({ padding: 12.6 }).padding, 13);
  assert.equal(sanitizeExportPrefs({ quality: 7 }).quality, 1);
});

test('sanitizeExportPrefs keeps valid explicit values', () => {
  const p = sanitizeExportPrefs({
    scale: 3,
    padding: 40,
    background: 'custom',
    customColor: '#123456',
    embedFonts: false,
    format: 'webp',
    quality: 0.8,
    theme: 'light',
    embedSource: false,
  });
  assert.deepEqual(p, {
    scale: 3,
    padding: 40,
    background: 'custom',
    customColor: '#123456',
    embedFonts: false,
    format: 'webp',
    quality: 0.8,
    theme: 'light',
    embedSource: false,
  });
});

test('format capability helpers', () => {
  assert.deepEqual(['png', 'jpg', 'webp', 'svg', 'pdf', 'gif'].map(supportsAlpha as (f: never) => boolean), [
    true, false, true, true, false, false,
  ]);
  assert.deepEqual(['png', 'jpg', 'webp', 'svg', 'pdf', 'gif'].map(supportsEmbeddedSource as (f: never) => boolean), [
    true, false, false, true, false, false,
  ]);
  assert.deepEqual(['png', 'jpg', 'webp', 'svg', 'vellum'].map(isRasterFormat as (f: never) => boolean), [
    true, true, true, false, false,
  ]);
  assert.deepEqual(['png', 'jpg', 'webp', 'svg'].map(hasQuality as (f: never) => boolean), [false, true, true, false]);
  assert.equal(mimeTypeFor('png'), 'image/png');
  assert.equal(mimeTypeFor('jpg'), 'image/jpeg');
  assert.equal(mimeTypeFor('webp'), 'image/webp');
});

test('clampScale honours both the edge and the total-pixel ceilings', () => {
  assert.equal(clampScale(1000, 500, 2), 2);
  // 12000 × 12000 at 1× = 144 MP > 100 MP → scale = sqrt(100e6 / 144e6)
  const s = clampScale(12000, 12000, 1);
  assert.ok(Math.abs(s - Math.sqrt(MAX_RASTER_PIXELS / 144e6)) < 1e-9);
  assert.equal(clampScale(10000, 100, 4), MAX_RASTER_EDGE / 10000);
});

test('scaleForWidth and dpiForScale', () => {
  assert.equal(scaleForWidth(1000, 2000), 2);
  assert.equal(scaleForWidth(1000, 500), 0.5);
  assert.equal(scaleForWidth(0, 500), 1);
  assert.equal(scaleForWidth(1000, NaN), 1);
  assert.equal(scaleForWidth(10, 100000), MAX_SCALE);
  assert.equal(dpiForScale(1), 96);
  assert.equal(dpiForScale(2), 192);
  assert.equal(dpiForScale(1.5), 144);
});

test('filename helpers', () => {
  assert.equal(sanitizeFilenameBase(' my / diagram '), 'my diagram');
  assert.equal(sanitizeFilenameBase(undefined), 'untitled');
  assert.equal(stripImageExtension('thing.PNG'), 'thing');
  assert.equal(stripImageExtension('thing.zip'), 'thing');
  assert.equal(stripImageExtension('thing.vellum'), 'thing');
  assert.equal(stripImageExtension('thing.tar.gz'), 'thing.tar.gz');
});

/* ── geometry ──────────────────────────────────────────────────────── */

test('rasterSize rounds and never drops below 1px', () => {
  assert.deepEqual(rasterSize(1020, 560, 2), { width: 2040, height: 1120 });
  assert.deepEqual(rasterSize(10.4, 10.6, 1), { width: 10, height: 11 });
  assert.deepEqual(rasterSize(0.1, 0.1, 1), { width: 1, height: 1 });
});

test('clampScaleToEdge leaves a fitting scale alone and caps an oversize one', () => {
  assert.equal(clampScaleToEdge(1000, 500, 2), 2);
  // 10000 × 4 = 40000 > 16384 → cap at 16384 / 10000
  assert.equal(clampScaleToEdge(10000, 500, 4), MAX_RASTER_EDGE / 10000);
  assert.equal(clampScaleToEdge(0, 0, 3), 3);
  assert.equal(clampScaleToEdge(100, 100, 4, 200), 2);
});

test('formatDimensions', () => {
  assert.equal(formatDimensions(2040, 1120), '2040 × 1120 px');
  assert.equal(formatDimensions(10.4, 9.6), '10 × 10 px');
});

/* ── background ────────────────────────────────────────────────────── */

test('resolveBackground: paper uses the effective paper colour', () => {
  const c = resolveBackground({
    background: 'paper',
    customColor: '#ff0000',
    paperColour: 'rgb(23, 27, 33)',
    format: 'png',
  });
  assert.equal(c, 'rgb(23, 27, 33)');
});

test('resolveBackground: transparent is honoured only by alpha formats', () => {
  const base = { background: 'transparent' as const, customColor: '#fff', paperColour: '#abcdef' };
  assert.equal(resolveBackground({ ...base, format: 'png' }), null);
  assert.equal(resolveBackground({ ...base, format: 'webp' }), null);
  assert.equal(resolveBackground({ ...base, format: 'svg' }), null);
  // JPEG / PDF / GIF have no alpha: fall back to the paper the user is
  // looking at, never to the encoder's black.
  assert.equal(resolveBackground({ ...base, format: 'jpg' }), '#abcdef');
  assert.equal(resolveBackground({ ...base, format: 'pdf' }), '#abcdef');
  assert.equal(resolveBackground({ ...base, format: 'gif' }), '#abcdef');
});

test('resolveBackground: white and custom', () => {
  assert.equal(
    resolveBackground({ background: 'white', customColor: '#000', paperColour: '#111', format: 'jpg' }),
    '#ffffff',
  );
  assert.equal(
    resolveBackground({ background: 'custom', customColor: ' #123456 ', paperColour: '#111', format: 'png' }),
    '#123456',
  );
  assert.equal(
    resolveBackground({ background: 'custom', customColor: '', paperColour: '#111', format: 'png' }),
    '#ffffff',
  );
});

/* ── filenames ─────────────────────────────────────────────────────── */

test('exportFilename sanitises titles and falls back to untitled', () => {
  assert.equal(exportFilename('render-pipeline', 'png'), 'render-pipeline.png');
  assert.equal(exportFilename('a/b\\c:d*e?f"g<h>i|j', 'svg'), 'abcdefghij.svg');
  assert.equal(exportFilename('  spaced   out  ', '.jpg'), 'spaced out.jpg');
  assert.equal(exportFilename('', 'png'), 'untitled.png');
  assert.equal(exportFilename(undefined, 'gif'), 'untitled.gif');
  assert.equal(exportFilename('trailing...', 'png'), 'trailing.png');
});

/* ── font matching ─────────────────────────────────────────────────── */

test('parseUnicodeRange handles points, ranges and wildcards', () => {
  assert.deepEqual(parseUnicodeRange('U+0-FF, U+131, U+152-153'), [
    [0x0, 0xff],
    [0x131, 0x131],
    [0x152, 0x153],
  ]);
  assert.deepEqual(parseUnicodeRange('u+4??'), [[0x400, 0x4ff]]);
  assert.deepEqual(parseUnicodeRange('nonsense, U+ZZ'), []);
  assert.deepEqual(parseUnicodeRange(''), []);
});

test('rangesCoverAny: empty ranges match everything, otherwise intersect', () => {
  assert.equal(rangesCoverAny([], [0x41]), true);
  const latin = parseUnicodeRange('U+0-FF');
  const greek = parseUnicodeRange('U+370-3FF');
  assert.equal(rangesCoverAny(latin, 'Hello'.split('').map((c) => c.codePointAt(0)!)), true);
  assert.equal(rangesCoverAny(greek, 'Hello'.split('').map((c) => c.codePointAt(0)!)), false);
  assert.equal(rangesCoverAny(greek, ['λ'.codePointAt(0)!]), true);
});

test('nearestWeight follows the CSS font-matching rule', () => {
  assert.equal(nearestWeight([400, 700], 400), 400);
  assert.equal(nearestWeight([400, 700], 600), 700); // ≥500 prefers heavier
  assert.equal(nearestWeight([400, 700], 300), 400); // ≤400 prefers lighter, none → heavier
  assert.equal(nearestWeight([300, 700], 400), 300);
  assert.equal(nearestWeight([400, 500], 500), 500);
  assert.equal(nearestWeight([500, 700], 400), 500); // 400 ↔ 500 are each other's first fallback
  assert.equal(nearestWeight([400, 700], 500), 400);
  assert.equal(nearestWeight([], 400), 400);
});

test('parseFamilyList strips quotes and whitespace', () => {
  assert.deepEqual(parseFamilyList(`'Outfit', system-ui, sans-serif`), [
    'Outfit',
    'system-ui',
    'sans-serif',
  ]);
  assert.deepEqual(parseFamilyList(`"JetBrains Mono",ui-monospace , monospace`), [
    'JetBrains Mono',
    'ui-monospace',
    'monospace',
  ]);
  assert.deepEqual(parseFamilyList(''), []);
});
