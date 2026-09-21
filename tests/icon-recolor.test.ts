import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultRecolorMode,
  parseColor,
  recolorIconSvg,
  relativeLuminance,
} from '../src/icons/recolor';

/** Effective paint for one property on one tag, resolving inline style over
 *  the presentation attribute the way the cascade would. Mirrors what the
 *  browser paints, so the assertions below test the rendered result rather
 *  than the markup's incidental shape. */
function effective(tag: string, prop: string): string | undefined {
  const style = tag.match(/\bstyle\s*=\s*"([^"]*)"/i)?.[1] ?? '';
  const fromStyle = [
    ...style.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]*)`, 'gi')),
  ].pop()?.[1];
  if (fromStyle !== undefined) return fromStyle.trim();
  return tag
    .match(new RegExp(`(?:^|\\s)${prop}\\s*=\\s*"([^"]*)"`, 'i'))?.[1]
    ?.trim();
}

function tags(svg: string): string[] {
  return svg.match(/<[a-zA-Z][^>]*>/g) ?? [];
}

/** Every paint that actually reaches the screen, in document order. */
function livePaints(svg: string, prop = 'fill'): string[] {
  return tags(svg)
    .map((t) => effective(t, prop))
    .filter((v): v is string => v !== undefined);
}

test('solid puts every hard-coded fill under the wrapper colour', () => {
  const svg =
    '<svg viewBox="0 0 24 24">' +
    '<rect fill="#8C4FFF" width="24" height="24"/>' +
    '<path fill="#FFFFFF" d="M2 2h4v4H2z"/>' +
    '<path fill="none" stroke="rgb(10, 20, 30)" d="M0 0"/>' +
    '</svg>';

  const out = recolorIconSvg(svg, 'solid');

  assert.deepEqual(livePaints(out), ['currentColor', 'currentColor', 'none']);
  assert.deepEqual(livePaints(out, 'stroke'), ['currentColor']);
  // `none` is a disabled channel, not a colour - it must survive untouched
  // or the icon grows fills it never had.
  assert.ok(out.includes('fill="none"'));
});

/** The tint percentage a shaded paint carries, or 100 for a plain
 *  `currentColor`. Reads the value the cascade would actually pick. */
function tintPct(tag: string, prop = 'fill'): number {
  const v = effective(tag, prop);
  assert.ok(v !== undefined, `no ${prop} on ${tag}`);
  if (v === 'currentColor') return 100;
  const m = v.match(/^color-mix\(in srgb, currentColor ([\d.]+)%, /);
  assert.ok(m, `not a shade mix: ${v}`);
  return Number(m[1]);
}

test('shade fades the light tone toward paper, not toward transparent', () => {
  // Icon artwork stacks: the glyph sits ON the tile, so fading it out would
  // just reveal the tile and flatten the icon into a square.
  const svg =
    '<svg viewBox="0 0 24 24">' +
    '<rect fill="#8C4FFF" width="24" height="24"/>' +
    '<path fill="#FFFFFF" d="M2 2h4v4H2z"/>' +
    '</svg>';

  const out = recolorIconSvg(svg, 'shade');
  const [tile, glyph] = tags(out).slice(1);

  assert.equal(tintPct(tile), 100, 'the tile carries the tint');
  assert.equal(tintPct(glyph), 0, 'the glyph goes all the way to paper');
  assert.match(effective(glyph, 'fill')!, /var\(--icon-recolor-base, var\(--paper\)\)/);
  assert.ok(!out.includes('fill-opacity'), 'the ramp is colour, never alpha');
});

test('a shade mix keeps a plain currentColor fallback under it', () => {
  const svg = '<svg viewBox="0 0 24 24"><rect fill="#000"/><path fill="#888"/></svg>';

  const glyph = tags(recolorIconSvg(svg, 'shade'))[2];

  // Presentation attribute first for engines without color-mix, the mix in
  // the inline style for those that have it.
  assert.match(glyph, /fill="currentColor"/);
  assert.match(glyph, /style="fill:color-mix\(/);
});

test('shade gains its ramp so the darkest tone always reaches full tint', () => {
  const svg =
    '<svg viewBox="0 0 24 24">' +
    '<path fill="#333333" d="M0 0"/>' +
    '<path fill="#777777" d="M0 0"/>' +
    '<path fill="#bbbbbb" d="M0 0"/>' +
    '</svg>';

  const pcts = tags(recolorIconSvg(svg, 'shade')).slice(1).map((t) => tintPct(t));

  assert.equal(pcts[0], 100, 'darkest anchors the ramp');
  assert.ok(pcts[1] > pcts[2], 'mid grey stays denser than light grey');
  assert.ok(pcts[2] > 20, 'the lightest tone is still visibly tinted');
});

test('shade keeps two close darks close together', () => {
  // A min→max normalisation would stretch these to 100% and 0% - a
  // near-black accent would render as paper. Gain-to-darkest keeps both
  // essentially at full tint, which is what the artwork looks like.
  const svg =
    '<svg viewBox="0 0 24 24"><path fill="#111111"/><path fill="#333333"/></svg>';

  const pcts = tags(recolorIconSvg(svg, 'shade')).slice(1).map((t) => tintPct(t));

  assert.equal(pcts[0], 100);
  assert.ok(pcts[1] > 90, `near-black accent stayed dark (got ${pcts[1]}%)`);
});

test('shade leaves a single-tone icon at full strength', () => {
  const svg =
    '<svg viewBox="0 0 24 24">' +
    '<path fill="#4A5568" d="M0 0"/>' +
    '<path fill="#4A5568" d="M1 1"/>' +
    '</svg>';

  const out = recolorIconSvg(svg, 'shade');

  assert.deepEqual(livePaints(out), ['currentColor', 'currentColor']);
  assert.ok(!out.includes('color-mix'), 'no ramp on flat artwork');
});

test('recolours <style> rule bodies, where Illustrator exports keep their paint', () => {
  const svg =
    '<svg viewBox="0 0 18 18"><defs><style>.cls-1{fill:#0078d4;}' +
    '.cls-2{fill:url(#g);}</style></defs>' +
    '<rect class="cls-1" width="18" height="18"/>' +
    '<path class="cls-2" d="M0 0"/></svg>';

  const out = recolorIconSvg(svg, 'solid');

  assert.match(out, /\.cls-1\{fill:currentColor\}/);
  // A paint-server reference is recoloured through its stops, never by
  // replacing the reference itself.
  assert.match(out, /\.cls-2\{fill:url\(#g\);\}/);
});

test('recolours gradient stops so url() fills follow the tint', () => {
  const svg =
    '<svg viewBox="0 0 18 18"><defs><linearGradient id="g">' +
    '<stop offset="0" stop-color="#5e9624"/>' +
    '<stop offset="1" stop-color="#b4ec36"/>' +
    '</linearGradient></defs>' +
    '<path fill="url(#g)" d="M0 0"/></svg>';

  const out = recolorIconSvg(svg, 'shade');

  assert.equal(livePaints(out, 'stop-color').length, 2);
  const stops = tags(out).filter((t) => t.startsWith('<stop'));
  assert.equal(tintPct(stops[0], 'stop-color'), 100);
  assert.ok(
    tintPct(stops[0], 'stop-color') > tintPct(stops[1], 'stop-color'),
    'the darker stop stays the denser one',
  );
  assert.equal(effective(tags(out).at(-1)!, 'fill'), 'url(#g)');
});

test('CSS last-declaration-wins is respected inside inline styles', () => {
  // Progressive-enhancement pattern: an sRGB fallback followed by the
  // wide-gamut value that actually paints. Rewriting the first would leave
  // the icon exactly as it was.
  const svg =
    '<svg viewBox="0 0 24 24"><path fill="#101010" ' +
    'style="fill:#101010;fill:color(display-p3 0.06 0.06 0.06);fill-opacity:1" ' +
    'd="M0 0"/></svg>';

  const out = recolorIconSvg(svg, 'solid');

  assert.equal(effective(tags(out)[1], 'fill'), 'currentColor');
});

test('folds a colour alpha and an existing opacity into one value', () => {
  const svg =
    '<svg viewBox="0 0 24 24">' +
    '<path fill="#33445580" fill-opacity="0.5" d="M0 0"/></svg>';

  const out = recolorIconSvg(svg, 'solid');
  const tag = tags(out)[1];

  assert.equal(effective(tag, 'fill'), 'currentColor');
  // 0.5 (element) x 0.502 (colour alpha) - one multiplied value, never two
  // competing declarations.
  assert.ok(Math.abs(Number(effective(tag, 'fill-opacity')) - 0.251) < 0.002);
  assert.equal((out.match(/fill-opacity/g) ?? []).length, 1);
});

test('leaves currentColor artwork exactly as it was', () => {
  const svg =
    '<svg fill="currentColor" viewBox="0 0 24 24">' +
    '<g fill="none" stroke="currentColor"><rect width="18" height="18"/></g></svg>';

  assert.equal(recolorIconSvg(svg, 'solid'), svg);
  assert.equal(recolorIconSvg(svg, 'shade'), svg);
});

test('preserves self-closing tags when appending an attribute', () => {
  const svg =
    '<svg viewBox="0 0 24 24"><rect fill="#123456" width="24" height="24"/>' +
    '<path fill="#ffffff" d="M0 0"/></svg>';

  const out = recolorIconSvg(svg, 'shade');

  assert.ok(!/\/\s+[a-z-]+=/.test(out), 'no attribute written after the slash');
  assert.match(out, /<path fill="currentColor" d="M0 0" style="fill:color-mix\([^"]*"\/>/);
});

test('an all-white icon renders as solid rather than dissolving into the paper', () => {
  // There is no darker tone to anchor the ramp against, and mixing white
  // all the way to paper would erase the icon.
  const svg =
    '<svg viewBox="0 0 24 24"><path fill="#ffffff" d="M0 0"/>' +
    '<path fill="#fefefe" d="M1 1"/></svg>';

  const out = recolorIconSvg(svg, 'shade');

  assert.deepEqual(livePaints(out), ['currentColor', 'currentColor']);
  assert.ok(!out.includes('color-mix'));
});

test('parses the colour syntaxes icon sets ship', () => {
  assert.deepEqual(parseColor('#abc'), { r: 170, g: 187, b: 204, a: 1 });
  assert.deepEqual(parseColor('#00ff00'), { r: 0, g: 255, b: 0, a: 1 });
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parseColor('rgba(1 2 3 / 0.5)'), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.deepEqual(parseColor('hsl(0, 100%, 50%)'), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor('white'), { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(parseColor('nonsense-colour'), null);
});

test('relative luminance brackets black and white', () => {
  assert.equal(relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
  assert.equal(relativeLuminance({ r: 255, g: 255, b: 255 }), 1);
  // Perceptual, not an average: green reads far lighter than blue.
  assert.ok(
    relativeLuminance({ r: 0, g: 255, b: 0 }) >
      relativeLuminance({ r: 0, g: 0, b: 255 }),
  );
});

test('the implicit mode suits the artwork', () => {
  assert.equal(defaultRecolorMode(true), 'solid');
  assert.equal(defaultRecolorMode(false), 'shade');
});
