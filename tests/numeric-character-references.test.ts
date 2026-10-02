import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';

import { extractSourceFromSvg } from '../src/editor/export/source';
import { drawioToDiagram } from '../src/lib/drawio';
import { htmlLabelToPlainText } from '../src/lib/importer-utils';
import { mermaidToDiagram } from '../src/lib/mermaid';
import { workspaceFromFile } from '../src/store/persist';

/** Numeric character references decode only to U+0001 through U+10FFFF,
 *  surrogate halves excluded. Any other reference stays as written.
 *
 *   - The editable-export source reader decodes hex and decimal references.
 *     String.fromCodePoint threw a RangeError past U+10FFFF, so an SVG whose
 *     source held `&#x110000;` failed to open ("Invalid code point 1114112")
 *     and dropped onto the canvas as a plain image; `&#xD842;` decoded to a
 *     lone surrogate and `&#0;` to NUL.
 *   - The draw.io and mermaid label decoder reads decimal references.
 *     String.fromCharCode wrapped past U+FFFF (`&#128512;` became U+F600,
 *     `&#65601;` became "A") and decoded 0 and surrogate halves.
 *   - A surrogate pair written as two references stays as written: each half
 *     is invalid on its own, so the pair is never joined.
 *   - The label decoder decodes each entity once, in one pass. It decoded
 *     `&amp;` before the rest, so `&amp;lt;b&amp;gt;` (the text "&lt;b&gt;")
 *     came out as "<b>" and `&amp;#65;` as "A"; decoding `&amp;` last
 *     instead would turn `&#38;amp;` (the text "&amp;") into "&". */

// drawioToDiagram parses with DOMParser, which Node lacks.
const dom = new JSDOM();
Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: dom.window.DOMParser });
after(() => dom.window.close());

const cp = (...points: number[]) => String.fromCodePoint(...points);

const INVALID_HEX = [
  '&#x0;',
  '&#xD800;',
  '&#xD842;',
  '&#xDFFF;',
  '&#x110000;',
  `&#x${'f'.repeat(40)};`,
  `&#x${'f'.repeat(300)};`,
];
const INVALID_DECIMAL = [
  '&#0;',
  '&#55296;',
  '&#55362;',
  '&#57343;',
  '&#1114112;',
  '&#99999999999;',
  `&#${'9'.repeat(400)};`,
];
/** U+1F600 as a surrogate pair, one reference per half. */
const SPLIT_PAIR_HEX = '&#xD83D;&#xDE00;';
const SPLIT_PAIR_DECIMAL = '&#55357;&#56832;';

const VALID_HEX: [string, string][] = [
  ['&#x1F600;', cp(0x1f600)],
  ['&#xE9;', cp(0xe9)],
  ['&#xD7FF;', cp(0xd7ff)],
  ['&#xE000;', cp(0xe000)],
  ['&#x10FFFF;', cp(0x10ffff)],
];
const VALID_DECIMAL: [string, string][] = [
  ['&#128512;', cp(0x1f600)],
  ['&#65601;', cp(0x10041)],
  ['&#233;', cp(0xe9)],
  ['&#55295;', cp(0xd7ff)],
  ['&#57344;', cp(0xe000)],
  ['&#1114111;', cp(0x10ffff)],
];

/** An SVG export whose `vellum-source` metadata holds `body` verbatim. */
const svgWithSource = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg"><metadata id="vellum-source">${body}</metadata></svg>`;

/* ── editable-export source (export/source.ts) ─────────────────────── */

test('SVG source: a reference that is not a scalar value stays as written', () => {
  for (const ref of [...INVALID_HEX, ...INVALID_DECIMAL, SPLIT_PAIR_HEX, SPLIT_PAIR_DECIMAL]) {
    assert.equal(extractSourceFromSvg(svgWithSource(`title: a ${ref} b`)), `title: a ${ref} b`);
  }
});

test('SVG source: a valid reference decodes, astral and BMP, hex and decimal', () => {
  for (const [ref, text] of [...VALID_HEX, ...VALID_DECIMAL]) {
    assert.equal(extractSourceFromSvg(svgWithSource(`title: a ${ref} b`)), `title: a ${text} b`);
  }
});

test('Open: an editable SVG holding an out-of-range reference opens with it as written', async () => {
  const yaml = [
    "version: '1.0'",
    'meta:',
    "  title: 'Plan &#x110000; &#0; &#xD842; &#x1F600;'",
    'shapes: []',
    'connectors: []',
    'annotations: []',
  ].join('\n');
  const file = new File([svgWithSource(yaml)], 'plan.svg', { type: 'image/svg+xml' });
  const ws = await workspaceFromFile(file);
  assert.equal(ws.tabs[0].diagram.meta.title, `Plan &#x110000; &#0; &#xD842; ${cp(0x1f600)}`);
});

/* ── draw.io and mermaid labels (importer-utils.ts) ────────────────── */

/** Label HTML in which a decoded `&` could start another entity, each with
 *  the text it stands for. */
const ESCAPED_AMPERSANDS: [string, string][] = [
  ['&amp;lt;b&amp;gt;', '&lt;b&gt;'],
  ['&amp;#65;', '&#65;'],
  ['&amp;quot;', '&quot;'],
  ['&amp;nbsp;', '&nbsp;'],
  ['&amp;amp;', '&amp;'],
  ['&#38;amp;', '&amp;'],
  ['&#38;lt;', '&lt;'],
];

/** A one-cell draw.io model whose html=1 label is `html`. The label is HTML
 *  inside an XML attribute, so `&amp;#0;` reaches the label decoder as
 *  `&#0;` and `&amp;amp;lt;` as `&amp;lt;`. */
const drawioCell = (html: string) => {
  const value = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return (
    '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    `<mxCell id="a" value="${value}" style="rounded=1;html=1;" vertex="1" parent="1">` +
    '<mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>' +
    '</root></mxGraphModel>'
  );
};

test('label text: each entity decodes once, so a decoded `&` starts no other', () => {
  for (const [html, text] of ESCAPED_AMPERSANDS) {
    assert.equal(htmlLabelToPlainText(`a ${html} b`), `a ${text} b`);
  }
});

test('label text: the named entities and `&#39;` decode', () => {
  assert.equal(htmlLabelToPlainText('a&nbsp;&amp;&lt;i&gt;&quot;&#39;z'), `a &<i>"'z`);
});

test('label text: a decimal reference that is not a scalar value stays as written', () => {
  for (const ref of [...INVALID_DECIMAL, SPLIT_PAIR_DECIMAL]) {
    assert.equal(htmlLabelToPlainText(`a ${ref} b`), `a ${ref} b`);
  }
});

test('label text: a decimal reference decodes by code point, past U+FFFF too', () => {
  for (const [ref, text] of VALID_DECIMAL) {
    assert.equal(htmlLabelToPlainText(`a ${ref} b`), `a ${text} b`);
  }
});

test('draw.io import: label references decode by code point and invalid ones stay', async () => {
  const refs = ['&#128512;', '&#65601;', '&#0;', '&#1114112;', SPLIT_PAIR_DECIMAL];
  const diagram = await drawioToDiagram(drawioCell(`x ${refs.join(' ')} y`));
  assert.equal(diagram.shapes.length, 1);
  assert.equal(
    diagram.shapes[0].label,
    `x ${cp(0x1f600)} ${cp(0x10041)} &#0; &#1114112; ${SPLIT_PAIR_DECIMAL} y`,
  );
});

test('draw.io import: an escaped ampersand in a label decodes once', async () => {
  const html = ESCAPED_AMPERSANDS.map(([h]) => h).join(' ');
  const diagram = await drawioToDiagram(drawioCell(`x ${html} y`));
  assert.equal(diagram.shapes.length, 1);
  assert.equal(diagram.shapes[0].label, `x ${ESCAPED_AMPERSANDS.map(([, t]) => t).join(' ')} y`);
});

test('mermaid import: an escaped ampersand in a node or edge label decodes once', () => {
  const diagram = mermaidToDiagram(
    'flowchart LR\n  A["&amp;lt;b&amp;gt; &#38;amp;"] -->|"&amp;#65;"| B["&lt;i&gt; &amp;"]',
  );
  assert.deepEqual(
    diagram.shapes.map((s) => s.label),
    ['&lt;b&gt; &amp;', '<i> &'],
  );
  assert.equal(diagram.connectors[0].label, '&#65;');
});
