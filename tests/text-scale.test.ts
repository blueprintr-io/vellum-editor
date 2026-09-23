import assert from 'node:assert/strict';
import test from 'node:test';
import postcss from 'postcss';

/** Settings ▸ Text size.
 *
 *   - the PostCSS pass rewrites every px / rem font-size to multiply by
 *     `--vellum-text-scale`, and leaves everything else alone - relative
 *     sizes, keywords, other properties, and a size marked `text-scale: fixed`;
 *   - saved preferences snap to an offered step, and anything unreadable
 *     falls back to 100%;
 *   - the store keeps the setting as a preference: it persists, survives a
 *     reload, and a corrupt saved value can't reach the stylesheet.
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
// A preference written by hand (or by a future build with more steps).
mem.set(
  'vellum.editor',
  JSON.stringify({ state: { uiTextScale: 1.27 }, version: 1 }),
);

const { default: textScale } = await import('../src/styles/postcss-text-scale.js');
const { sanitizeTextScale, TEXT_SCALE_OPTIONS, DEFAULT_TEXT_SCALE } = await import(
  '../src/editor/text-scale'
);
const { useEditor } = await import('../src/store/editor');

const run = async (css: string) =>
  (await postcss([textScale()]).process(css, { from: undefined })).css;

test('px and rem font sizes multiply by the text-scale variable', async () => {
  assert.equal(
    await run('.a{font-size:10px}'),
    '.a{font-size:calc(10px * var(--vellum-text-scale, 1))}',
  );
  assert.equal(
    await run('.b{font-size:0.75rem}'),
    '.b{font-size:calc(0.75rem * var(--vellum-text-scale, 1))}',
  );
  assert.equal(
    await run('.c{font-size:12.5px !important}'),
    '.c{font-size:calc(12.5px * var(--vellum-text-scale, 1)) !important}',
  );
});

test('relative sizes, keywords and other properties are left alone', async () => {
  const untouched = [
    '.a{font-size:inherit}',
    '.b{font-size:1.2em}',
    '.c{font-size:80%}',
    '.d{font-size:var(--x)}',
    '.e{font-size:calc(10px + 1vw)}',
    '.f{line-height:14px}',
    '.g{width:10px}',
  ];
  for (const css of untouched) assert.equal(await run(css), css);
});

test('a size marked text-scale: fixed keeps its value', async () => {
  const css = 'body{font-size:14px; /* text-scale: fixed */ color:red}';
  assert.equal(await run(css), css);
});

test('saved values snap to the nearest offered step', () => {
  assert.equal(sanitizeTextScale(1), 1);
  assert.equal(sanitizeTextScale(1.3), 1.3);
  assert.equal(sanitizeTextScale(1.27), 1.3);
  assert.equal(sanitizeTextScale(9), TEXT_SCALE_OPTIONS.at(-1)!.value);
  for (const bad of [undefined, null, 'large', NaN, Infinity, 0, -1]) {
    assert.equal(sanitizeTextScale(bad), DEFAULT_TEXT_SCALE);
  }
});

test('the store restores a saved text size, snapped to a step', async () => {
  await useEditor.persist.rehydrate();
  assert.equal(useEditor.getState().uiTextScale, 1.3);
});

test('setting the text size persists it, and junk is refused', () => {
  const { setUiTextScale } = useEditor.getState();
  setUiTextScale(1.5);
  assert.equal(useEditor.getState().uiTextScale, 1.5);
  assert.equal(JSON.parse(mem.get('vellum.editor')!).state.uiTextScale, 1.5);

  setUiTextScale(Number.NaN);
  assert.equal(useEditor.getState().uiTextScale, DEFAULT_TEXT_SCALE);
});
