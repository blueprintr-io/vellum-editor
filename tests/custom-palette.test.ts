import assert from 'node:assert/strict';
import test from 'node:test';

/** The custom colour palette and the colour picker's model.
 *
 *   - palette entries are lower-case `#rrggbb`, de-duplicated and capped,
 *     whatever a saved preference or a host hands the store;
 *   - the store keeps the palette as a preference: it persists, survives a
 *     reload, backfills for preferences saved before it existed, and never
 *     enters undo history;
 *   - the picker reads hex, rgb(), hsl(), bare triplets and CSS names, and
 *     its conversions round-trip;
 *   - the library holds the counts the picker advertises, every entry is a
 *     valid colour, and search finds colours by name, alias and hex.
 *
 *  The store runs in Node, so a Map-backed localStorage goes in before the
 *  import (Node's stub throws on setItem). */
const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, String(v));
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  },
});
// Preferences saved by a build from before the palette existed.
mem.set(
  'vellum.editor',
  JSON.stringify({ state: { theme: 'light', showDots: false }, version: 1 }),
);

const { CUSTOM_PALETTE_MAX, normaliseHex, sanitizeCustomPalette, samePalette } =
  await import('../src/editor/custom-palette');
const colour = await import('../src/editor/colour');
const { colourLibrary, libraryCount, searchLibrary, SPECTRUM_STEPS } = await import(
  '../src/editor/colour-library'
);
const { CSS_COLOUR_NAMES, cssNamedColour } = await import('../src/editor/colour-names');
const { useEditor } = await import('../src/store/editor');

const HEX = /^#[0-9a-f]{6}$/;

test('palette colours normalise to lower-case six-digit hex', () => {
  assert.equal(normaliseHex('#ABCDEF'), '#abcdef');
  assert.equal(normaliseHex(' #abc '), '#aabbcc');
  for (const bad of ['abcdef', '#abcd', '#abcdef12', 'red', 'var(--ink)', 42, null, undefined]) {
    assert.equal(normaliseHex(bad), null, String(bad));
  }
});

test('a palette is sanitised: valid, de-duplicated, capped, in order', () => {
  assert.deepEqual(
    sanitizeCustomPalette(['#FF0000', 'nope', '#f00', '#00ff00', 7, '#0000FF']),
    ['#ff0000', '#00ff00', '#0000ff'],
  );
  for (const bad of [undefined, null, '#ff0000', { 0: '#ff0000' }, 3]) {
    assert.deepEqual(sanitizeCustomPalette(bad), []);
  }
  const many = Array.from({ length: 40 }, (_, i) => `#0000${i.toString(16).padStart(2, '0')}`);
  const capped = sanitizeCustomPalette(many);
  assert.equal(capped.length, CUSTOM_PALETTE_MAX);
  assert.deepEqual(capped, many.slice(0, CUSTOM_PALETTE_MAX));
  assert.ok(samePalette(['#000000'], ['#000000']));
  assert.ok(!samePalette(['#000000', '#ffffff'], ['#ffffff', '#000000']));
});

test('preferences saved before the palette existed load with an empty one', async () => {
  await useEditor.persist.rehydrate();
  const s = useEditor.getState();
  assert.deepEqual(s.customPalette, []);
  // The rest of the old preferences still came through.
  assert.equal(s.theme, 'light');
  assert.equal(s.showDots, false);
});

test('the palette persists, and a saved one is re-sanitised on load', async () => {
  const { setCustomPalette } = useEditor.getState();
  setCustomPalette(['#1F6FEB', '#1f6feb', 'tomato', '#0e7c86']);
  assert.deepEqual(useEditor.getState().customPalette, ['#1f6feb', '#0e7c86']);
  assert.deepEqual(
    JSON.parse(mem.get('vellum.editor')!).state.customPalette,
    ['#1f6feb', '#0e7c86'],
  );

  // A hand-edited or corrupt preference can't put junk in the swatch row.
  const saved = JSON.parse(mem.get('vellum.editor')!);
  saved.state.customPalette = ['#ABC', 12, '#abc', 'url(x)'];
  mem.set('vellum.editor', JSON.stringify(saved));
  await useEditor.persist.rehydrate();
  assert.deepEqual(useEditor.getState().customPalette, ['#aabbcc']);

  saved.state.customPalette = 'not a list';
  mem.set('vellum.editor', JSON.stringify(saved));
  await useEditor.persist.rehydrate();
  assert.deepEqual(useEditor.getState().customPalette, []);
});

test('setting the same palette is a no-op, and it never enters history', () => {
  const { setCustomPalette } = useEditor.getState();
  setCustomPalette(['#123456']);
  const before = useEditor.getState();
  let notified = 0;
  const off = useEditor.subscribe(() => notified++);
  setCustomPalette(['#123456']);
  off();
  assert.equal(notified, 0);
  assert.equal(useEditor.getState().past, before.past);
  setCustomPalette(['#123456', '#654321']);
  assert.equal(useEditor.getState().past.length, before.past.length);
});

test('the picker reads colours in every form it offers', () => {
  const cases: [string, string | null][] = [
    ['#1F6FEB', '#1f6feb'],
    ['1f6feb', '#1f6feb'],
    ['#abc', '#aabbcc'],
    ['rgb(12, 34, 56)', '#0c2238'],
    ['rgb(12 34 56 / 50%)', '#0c2238'],
    ['rgba(255,0,0,0.3)', '#ff0000'],
    ['rgb(10%, 20%, 30%)', '#1a334d'],
    ['hsl(210, 50%, 40%)', '#336699'],
    ['hsl(210deg 50% 40%)', '#336699'],
    ['12, 34, 56', '#0c2238'],
    ['12 34 56', '#0c2238'],
    ['Tomato', '#ff6347'],
    ['rebecca purple', '#663399'],
    ['darkgray', '#a9a9a9'],
    ['dark-slate-grey', '#2f4f4f'],
    ['', null],
    ['nope', null],
    ['#abcdef12', null],
    ['300, 0, 0', null],
    ['rgb(1deg, 2, 3)', null],
  ];
  for (const [text, want] of cases) assert.equal(colour.parseColour(text), want, text);
});

test('colour model conversions round-trip', () => {
  for (let i = 0; i < 500; i++) {
    const hex = colour.rgbToHex({
      r: (i * 97) % 256,
      g: (i * 57) % 256,
      b: (i * 31) % 256,
    });
    assert.equal(colour.hsvToHex(colour.hexToHsv(hex)), hex);
    const rgb = colour.hexToRgb(hex);
    assert.equal(colour.rgbToHex(colour.hslToRgb(colour.rgbToHsl(rgb))), hex);
  }
  assert.deepEqual(colour.hexToHsv('#808080'), { h: 0, s: 0, v: 128 / 255 });
  assert.equal(colour.inkOn('#ffffff'), '#000000');
  assert.equal(colour.inkOn('#1f2937'), '#ffffff');
});

test('OKLCH colours land in sRGB without changing lightness order', () => {
  // Far out of gamut: chroma is reduced, the result is still a colour.
  assert.match(colour.oklchToHex(0.5, 0.5, 150), HEX);
  const ramp = [0.9, 0.7, 0.5, 0.3].map((L) =>
    colour.luminance(colour.oklchToHex(L, 0.15, 260)),
  );
  for (let i = 1; i < ramp.length; i++) assert.ok(ramp[i] < ramp[i - 1]);
});

test('the library holds the colours the picker advertises', () => {
  const groups = colourLibrary();
  const spectrum = groups.find((g) => g.id === 'spectrum')!;
  assert.equal(spectrum.rows.length, 20);
  for (const row of spectrum.rows) {
    assert.equal(row.colours.length, SPECTRUM_STEPS.length);
    // Every ramp runs light to dark.
    const lum = row.colours.map((c) => colour.luminance(c.hex));
    for (let i = 1; i < lum.length; i++) assert.ok(lum[i] < lum[i - 1], row.colours[i].name);
  }
  // 148 CSS names, of which the grey/gray pairs are written once, and
  // Aqua/Cyan and Fuchsia/Magenta share a swatch.
  assert.equal(CSS_COLOUR_NAMES.length, 141);
  const named = groups.find((g) => g.id === 'named')!.rows[0].colours;
  assert.equal(named.length, 139);
  const all = groups.flatMap((g) => g.rows.flatMap((r) => r.colours));
  assert.equal(all.length, libraryCount());
  for (const c of all) assert.match(c.hex, HEX, c.name);
  assert.equal(cssNamedColour('lightslategray'), '#778899');
});

test('library search matches names, aliases, groups and hex', () => {
  assert.deepEqual(searchLibrary('cornflower').map((c) => c.hex), ['#6495ed']);
  assert.ok(searchLibrary('blue 500').some((c) => c.name === 'Blue 500'));
  assert.ok(searchLibrary('magenta').some((c) => c.name === 'Fuchsia'));
  assert.ok(searchLibrary('gray').some((c) => c.name === 'Dim grey'));
  assert.ok(searchLibrary('okabe').length === 8);
  assert.ok(searchLibrary('#ff63').some((c) => c.name === 'Tomato'));
  assert.deepEqual(searchLibrary('   '), []);
  assert.equal(searchLibrary('e', 5).length, 5);
});
