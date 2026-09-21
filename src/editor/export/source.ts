/* Editable PNG exports store Vellum YAML in an iTXt chunk; SVG exports use
 * a metadata element. Open, drop and paste read these existing formats.
 * New exports include source only when explicitly requested. */

import { isPng, readPngText } from './binary';

/** PNG `iTXt` keyword. ≤ 79 Latin-1 chars per the spec. */
export const PNG_SOURCE_KEYWORD = 'vellum-source';
/** `id` of the `<metadata>` element in SVG exports. */
export const SVG_SOURCE_ID = 'vellum-source';
/** MIME-ish tag written next to the payload so a reader can sanity-check
 *  it came from us. */
export const SOURCE_TYPE = 'application/x-vellum+yaml';

export function extractSourceFromPng(bytes: Uint8Array): string | null {
  if (!isPng(bytes)) return null;
  const text = readPngText(bytes, PNG_SOURCE_KEYWORD);
  return text && text.trim() ? text : null;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Cheap sniff: does this text look like an SVG document? */
export function looksLikeSvg(text: string): boolean {
  return /<svg[\s>]/i.test(text.slice(0, 4096));
}

export function extractSourceFromSvg(text: string): string | null {
  const re = new RegExp(
    `<metadata[^>]*\\bid=["']${SVG_SOURCE_ID}["'][^>]*>([\\s\\S]*?)</metadata>`,
    'i',
  );
  const m = re.exec(text);
  if (!m) return null;
  let body = m[1];
  // Our serializer writes plain escaped text, but accept a CDATA wrapper
  // from hand-edited files too.
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(body);
  body = cdata ? cdata[1] : unescapeXml(body);
  return body.trim() ? body : null;
}

/** Dispatch on the file bytes: PNG → chunk, anything that parses as SVG →
 *  metadata, else null. */
export function extractEmbeddedSource(bytes: Uint8Array): string | null {
  if (isPng(bytes)) return extractSourceFromPng(bytes);
  // Only decode as text when it plausibly is text (SVG/XML starts with
  // `<` or a BOM / whitespace).
  const head = bytes.subarray(0, 64);
  let i = 0;
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x0a || head[i] === 0x0d || head[i] === 0x09)) i++;
  if (head[i] !== 0x3c /* < */) return null;
  const text = new TextDecoder().decode(bytes);
  return looksLikeSvg(text) ? extractSourceFromSvg(text) : null;
}
