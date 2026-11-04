/* Reads an icon pack from the files a user picks: a draw.io library (.xml),
 * a zip of SVGs (a Vellum pack zip included), a built Vellum pack (.json),
 * a Visio stencil (.vssx) or loose SVG files.
 *
 * Everything here is untrusted. Each SVG is sanitised, capped, and has its
 * ids and CSS classes scoped to itself, because icons are inlined into one
 * document and an exported `.cls-1` or `#gradient-1` would otherwise restyle
 * every other icon that uses the same name. One unreadable icon is skipped
 * and counted rather than failing the whole pack. */

import { sanitizeSvg } from '@/lib/sanitize-svg';
import { extractZipFile, svgEntriesFrom, type ZipExtractResult } from '@/lib/extract-zip';
import { decodeCompressedDiagram } from '@/lib/drawio';
import { htmlLabelToPlainText } from '@/lib/importer-utils';
import { addedPackKey, type AddedIcon, type AddedIconPack } from './added-packs';

export const PACK_IMPORT_LIMITS = {
  /** A .xml or .json pack file. Zips have their own limits. */
  fileBytes: 100 * 1024 * 1024,
  icons: 5000,
  svgBytes: 512 * 1024,
  packBytes: 64 * 1024 * 1024,
} as const;

/** A failure worth showing the user as it is. */
export class PackImportError extends Error {
  override name = 'PackImportError';
}

export type ImportedPack = {
  /** Suggested name; the user can change it before adding. */
  name: string;
  version: string;
  holder?: string;
  guidelinesUrl?: string;
  source: string;
  icons: AddedIcon[];
  /** Entries that had no usable SVG artwork. */
  skipped: number;
};

type RawIcon = {
  name: string;
  /** Seed for the icon id; the name is used when absent. */
  slug?: string;
  category?: string;
  keywords?: string[];
  svg: string;
};

type PackMeta = {
  name?: string;
  version?: string;
  holder?: string;
  guidelinesUrl?: string;
};

const LIBRARY_FILE =
  "That's a Vellum library file. Add it from the Gallery tab instead.";

/** Read whatever the user picked into one pack. */
export async function readIconPack(files: readonly File[]): Promise<ImportedPack> {
  if (files.length === 0) throw new PackImportError('Choose a file.');
  const legacyVisio = files.find((f) => /\.vss$/i.test(f.name));
  if (legacyVisio) {
    throw new PackImportError(
      `${legacyVisio.name} is the older Visio binary format (.vss). Open it in Visio and use File → Save As → "Visio Stencil (*.vssx)".`,
    );
  }
  const isSvg = (f: File) => /\.svg$/i.test(f.name) || f.type === 'image/svg+xml';
  if (files.every(isSvg)) return fromSvgFiles(files);
  if (files.length > 1) {
    throw new PackImportError('Choose one pack file at a time. Several SVG files can be picked together.');
  }
  const file = files[0];
  if (/\.(zip|vssx)$/i.test(file.name)) return fromZip(file);
  if (/\.(xml|drawio)$/i.test(file.name)) return fromDrawioLibrary(await readText(file), file.name);
  if (/\.(json|vellumlib)$/i.test(file.name)) return fromJson(await readText(file), file.name);
  throw new PackImportError(
    'Choose a draw.io library (.xml), a .zip of SVGs, a Vellum pack (.json), a Visio stencil (.vssx) or SVG files.',
  );
}

/** The pack as it will be saved, under the name the user settled on. */
export function toAddedPack(imported: ImportedPack, name: string): AddedIconPack {
  const finalName = name.trim() || imported.name;
  return {
    key: addedPackKey(finalName),
    name: finalName,
    version: imported.version,
    source: imported.source,
    addedAt: new Date().toISOString(),
    ...(imported.holder ? { holder: imported.holder } : {}),
    ...(imported.guidelinesUrl ? { guidelinesUrl: imported.guidelinesUrl } : {}),
    icons: imported.icons,
  };
}

async function readText(file: File): Promise<string> {
  if (file.size > PACK_IMPORT_LIMITS.fileBytes) {
    throw new PackImportError(`${file.name} is larger than 100 MB.`);
  }
  return file.text();
}

async function fromSvgFiles(files: readonly File[]): Promise<ImportedPack> {
  const raw: RawIcon[] = [];
  for (const file of files) {
    if (file.size > PACK_IMPORT_LIMITS.svgBytes) continue;
    raw.push({ name: prettyName(stem(file.name)), slug: stem(file.name), svg: await file.text() });
  }
  const single = files.length === 1;
  return buildPack(raw, files.length - raw.length, {
    name: single ? prettyName(stem(files[0].name)) : 'My icons',
    source: single ? files[0].name : `${files.length} SVG files`,
  });
}

/* ---------------------------------------------------------------- draw.io */

async function fromDrawioLibrary(text: string, fileName: string): Promise<ImportedPack> {
  const items = drawioLibraryItems(text);
  const raw: RawIcon[] = [];
  let skipped = 0;
  for (const item of items) {
    const svg = await drawioItemSvg(item);
    if (!svg) {
      skipped += 1;
      continue;
    }
    const title = (item as { title?: unknown }).title;
    const name = typeof title === 'string' ? htmlLabelToPlainText(title).replace(/\s+/g, ' ').trim() : '';
    raw.push({ name: name || `Icon ${raw.length + 1}`, svg });
  }
  return buildPack(raw, skipped, { name: prettyName(stem(fileName)), source: fileName });
}

/** The entries of an `<mxlibrary>` file: a JSON array inside one element. */
function drawioLibraryItems(text: string): unknown[] {
  const trimmed = text.trim();
  let json = trimmed;
  if (!trimmed.startsWith('[')) {
    const doc = new DOMParser().parseFromString(trimmed, 'text/xml');
    const root = doc.documentElement;
    if (doc.getElementsByTagName('parsererror').length || root?.localName !== 'mxlibrary') {
      if (/<(mxfile|mxGraphModel)[\s>]/.test(trimmed.slice(0, 4000))) {
        throw new PackImportError("That's a draw.io diagram, not a library. Open it with Import draw.io… instead.");
      }
      throw new PackImportError("That XML file isn't a draw.io library.");
    }
    json = root.textContent ?? '';
  }
  try {
    const items: unknown = JSON.parse(json);
    if (Array.isArray(items)) return items;
  } catch {
    // Reported below.
  }
  throw new PackImportError("That draw.io library couldn't be read.");
}

/** A library entry is either an image (`data`) or a small diagram (`xml`,
 *  sometimes compressed) holding one image cell. Only SVG artwork counts:
 *  stencil shapes and raster images have nothing Vellum can show as an icon. */
async function drawioItemSvg(item: unknown): Promise<string | null> {
  const entry = item as { xml?: unknown; data?: unknown };
  if (typeof entry.data === 'string') return svgFromDataUri(entry.data);
  if (typeof entry.xml !== 'string') return null;
  let xml = entry.xml.trim();
  if (!xml.startsWith('<')) {
    try {
      xml = await decodeCompressedDiagram(xml);
    } catch {
      return null;
    }
  }
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  const images: string[] = [];
  for (const cell of Array.from(doc.getElementsByTagName('mxCell'))) {
    const image = /(?:^|;)image=(data:image\/svg\+xml(?:;base64)?,[^;]*)/.exec(cell.getAttribute('style') ?? '');
    if (image) images.push(image[1]);
  }
  // Several images make a composite drawing, not one icon.
  return images.length === 1 ? svgFromDataUri(images[0]) : null;
}

/** draw.io writes SVG data URIs URL-encoded, or base64 without the
 *  `;base64` marker because `;` separates its style keys. */
function svgFromDataUri(uri: string): string | null {
  const match = /^data:image\/svg\+xml(;base64)?,([\s\S]*)$/.exec(uri.trim());
  if (!match) return null;
  const [, base64, payload] = match;
  let text: string | null = null;
  if (!base64 && /^\s*(<|%3c)/i.test(payload)) {
    try {
      text = decodeURIComponent(payload);
    } catch {
      text = payload;
    }
  } else {
    try {
      const binary = atob(payload.replace(/\s+/g, ''));
      text = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    } catch {
      return null;
    }
  }
  return /<svg[\s>]/i.test(text) ? text : null;
}

/* -------------------------------------------------------------------- zip */

async function fromZip(file: File): Promise<ImportedPack> {
  let result: ZipExtractResult;
  try {
    result = await extractZipFile(file);
  } catch (err) {
    throw new PackImportError(err instanceof Error ? err.message : `${file.name} couldn't be opened.`);
  }
  const meta = vellumPackMeta(result);
  // A Vellum pack zip carries the built pack, with names and keywords.
  const built = result.entries.find((e) => /(^|\/)dist\/icons\/packs\/[^/]+\.json$/i.test(e.name));
  if (built) {
    return fromVendorPack(parseJson(decode(built.data), built.name), file.name, meta, result.skipped.length);
  }
  const svgs = svgEntriesFrom(result);
  if (svgs.length === 0) {
    if (/\.vssx$/i.test(file.name)) {
      const masters = result.entries.filter((e) => /^visio\/masters\/.+\.xml$/i.test(e.name)).length;
      throw new PackImportError(
        masters > 0
          ? `That Visio stencil has ${masters} shape master(s) but no SVG artwork. Look for an SVG version of the stencil on the vendor's site.`
          : 'No SVGs found inside that .vssx file.',
      );
    }
    throw new PackImportError('No SVGs found inside that zip.');
  }
  // Folders every SVG shares (a zip's own top folder, raw-icons/<pack>/)
  // say nothing; the first folder below them is the category.
  const shared = sharedFolder(svgs.map((s) => s.folder));
  const raw = svgs.map((s): RawIcon => {
    const below = s.folder.slice(shared.length).replace(/^\//, '');
    return {
      name: prettyName(s.baseName),
      slug: s.baseName,
      category: below.split('/')[0] ?? '',
      svg: s.svg,
    };
  });
  return buildPack(raw, result.skipped.length, {
    name: meta.name ?? prettyName(stem(file.name)),
    version: meta.version,
    holder: meta.holder,
    guidelinesUrl: meta.guidelinesUrl,
    source: file.name,
  });
}

/** Name, version and rights holder from a Vellum pack zip: the source
 *  `meta.json`, or the vendor record in the built manifest. */
function vellumPackMeta(result: ZipExtractResult): PackMeta {
  const metaFile = result.entries.find((e) => /(^|\/)raw-icons\/[^/]+\/meta\.json$/i.test(e.name));
  const manifestFile = result.entries.find((e) => /(^|\/)dist\/icons\/manifest[^/]*\.json$/i.test(e.name));
  let record: unknown;
  try {
    if (metaFile) record = JSON.parse(decode(metaFile.data));
    else if (manifestFile) {
      const vendors = (JSON.parse(decode(manifestFile.data)) as { vendors?: Record<string, unknown> }).vendors;
      record = vendors ? Object.values(vendors)[0] : undefined;
    }
  } catch {
    return {};
  }
  const r = record as { name?: unknown; version?: unknown; trademark?: { holder?: unknown; guidelinesUrl?: unknown } };
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const url = text(r?.trademark?.guidelinesUrl, 500);
  return {
    name: text(r?.name, 60),
    version: text(r?.version, 40),
    holder: text(r?.trademark?.holder, 120),
    guidelinesUrl: url && /^https:\/\//i.test(url) ? url : undefined,
  };
}

function sharedFolder(folders: string[]): string {
  if (folders.length === 0) return '';
  let parts = folders[0] ? folders[0].split('/') : [];
  for (const folder of folders.slice(1)) {
    const other = folder ? folder.split('/') : [];
    let n = 0;
    while (n < parts.length && n < other.length && parts[n] === other[n]) n += 1;
    parts = parts.slice(0, n);
  }
  // Keep one folder level when every icon sits in the same folder, so a
  // single-category zip still names its category.
  if (parts.length > 0 && folders.every((f) => f === parts.join('/'))) parts = parts.slice(0, -1);
  return parts.join('/');
}

/* ------------------------------------------------------------------- json */

function fromJson(text: string, fileName: string): Promise<ImportedPack> {
  const value = parseJson(text, fileName) as { format?: unknown; icons?: unknown; vendors?: unknown };
  if (value?.format === 'vellum-library') throw new PackImportError(LIBRARY_FILE);
  const icons = Array.isArray(value?.icons) ? value.icons : null;
  if (icons && icons.some((i) => typeof (i as { svg?: unknown })?.svg === 'string')) {
    return Promise.resolve(fromVendorPack(value, fileName, {}, 0));
  }
  if (icons && value?.vendors) {
    throw new PackImportError(
      "That's an icon index without artwork. Choose the pack file from the packs folder, or the whole zip.",
    );
  }
  throw new PackImportError("That JSON file isn't an icon pack.");
}

/** A built Vellum pack: `{ vendor, version, icons: [{ id, name, svg, ... }] }`. */
function fromVendorPack(value: unknown, source: string, meta: PackMeta, skipped: number): ImportedPack {
  const pack = value as { vendor?: unknown; version?: unknown; icons?: unknown };
  const icons = Array.isArray(pack?.icons) ? pack.icons : [];
  const raw: RawIcon[] = [];
  let bad = skipped;
  for (const candidate of icons) {
    const icon = candidate as { id?: unknown; name?: unknown; category?: unknown; keywords?: unknown; svg?: unknown };
    if (typeof icon?.svg !== 'string') {
      bad += 1;
      continue;
    }
    const id = typeof icon.id === 'string' ? icon.id.split('/').pop() : undefined;
    raw.push({
      name: typeof icon.name === 'string' && icon.name.trim() ? icon.name : prettyName(id ?? ''),
      slug: id,
      category: typeof icon.category === 'string' ? icon.category : '',
      // Built packs list "<vendor>/<slug>" ids among their keywords.
      keywords: Array.isArray(icon.keywords)
        ? icon.keywords.filter((k): k is string => typeof k === 'string' && !k.includes('/'))
        : [],
      svg: icon.svg,
    });
  }
  const vendor = typeof pack?.vendor === 'string' ? pack.vendor : stem(source);
  return buildPack(raw, bad, {
    name: meta.name ?? prettyName(vendor),
    version: meta.version ?? (typeof pack?.version === 'string' ? pack.version : undefined),
    holder: meta.holder,
    guidelinesUrl: meta.guidelinesUrl,
    source,
  });
}

function parseJson(text: string, fileName: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PackImportError(`${fileName} isn't valid JSON.`);
  }
}

/* ------------------------------------------------------------------ build */

function buildPack(
  raw: RawIcon[],
  skippedBefore: number,
  meta: PackMeta & { name: string; source: string },
): ImportedPack {
  const icons: AddedIcon[] = [];
  const ids = new Set<string>();
  let skipped = skippedBefore;
  let bytes = 0;
  for (const r of raw) {
    const svg = icons.length < PACK_IMPORT_LIMITS.icons ? cleanImportedSvg(r.svg) : null;
    if (!svg || bytes + svg.length > PACK_IMPORT_LIMITS.packBytes) {
      skipped += 1;
      continue;
    }
    bytes += svg.length;
    const name = r.name.trim().slice(0, 80) || 'Icon';
    const base = slugify(r.slug ?? name) || 'icon';
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    icons.push({ id, name, category: r.category ?? '', keywords: keywordsFor(name, r.keywords), svg });
  }
  if (icons.length === 0) {
    throw new PackImportError(
      skipped > 0
        ? `None of the ${skipped} icons could be read. Vellum needs SVG artwork; raster images and stencil shapes can't be added.`
        : 'That file has no icons.',
    );
  }
  return {
    name: meta.name.slice(0, 60) || 'My icons',
    version: meta.version ?? '',
    ...(meta.holder ? { holder: meta.holder } : {}),
    ...(meta.guidelinesUrl ? { guidelinesUrl: meta.guidelinesUrl } : {}),
    source: meta.source,
    icons,
    skipped,
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Root attributes that paint the drawing. The canvas keeps only the root's
 *  children and viewBox, so these move onto a group around the children;
 *  otherwise `fill="none"` outline icons would render as solid shapes. */
const ROOT_PAINT = [
  'class',
  'style',
  'color',
  'opacity',
  'fill',
  'fill-opacity',
  'fill-rule',
  'clip-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
];

/** Sanitise one SVG and make it safe to inline beside other icons. Returns
 *  null for anything that isn't usable vector artwork. */
export function cleanImportedSvg(raw: string): string | null {
  // Embedded bitmaps are photos in an SVG wrapper; they don't scale.
  if (/\bdata:image\//i.test(raw)) return null;
  const safe = sanitizeSvg(raw);
  if (!safe) return null;
  const doc = new DOMParser().parseFromString(safe, 'text/html');
  const svg = doc.body.firstElementChild;
  if (svg?.localName !== 'svg' || svg.namespaceURI !== SVG_NS || !svg.firstElementChild) return null;
  if (!svg.getAttribute('viewBox')) {
    const w = parseFloat(svg.getAttribute('width') ?? '');
    const h = parseFloat(svg.getAttribute('height') ?? '');
    if (w > 0 && h > 0) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }
  const paint = ROOT_PAINT.filter((name) => svg.hasAttribute(name));
  if (paint.length > 0) {
    const group = doc.createElementNS(SVG_NS, 'g');
    for (const name of paint) {
      group.setAttribute(name, svg.getAttribute(name)!);
      svg.removeAttribute(name);
    }
    while (svg.firstChild) group.appendChild(svg.firstChild);
    svg.appendChild(group);
  }
  const scope = `vp${hash(safe)}`;
  const scoped = scopeClasses(scopeIds(svg.outerHTML, scope), scope);
  return scoped.length > PACK_IMPORT_LIMITS.svgBytes ? null : scoped;
}

/** Prefix every id this SVG defines, and every reference to one. */
function scopeIds(svg: string, scope: string): string {
  const ids = new Set(Array.from(svg.matchAll(/\bid\s*=\s*"([^"]+)"/g), (m) => m[1]));
  if (ids.size === 0) return svg;
  const prefix = `${scope}__`;
  return svg
    .replace(/(\bid\s*=\s*)"([^"]+)"/g, (m, lead: string, v: string) => (ids.has(v) ? `${lead}"${prefix}${v}"` : m))
    .replace(/\b(xlink:href|href)\s*=\s*"#([^"]+)"/g, (m, attr: string, v: string) =>
      ids.has(v) ? `${attr}="#${prefix}${v}"` : m,
    )
    .replace(/url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g, (m, _q: string, v: string) => (ids.has(v) ? `url(#${prefix}${v})` : m));
}

/** Prefix the CSS classes this SVG's <style> declares, on both sides. */
function scopeClasses(svg: string, scope: string): string {
  const styleBlock = /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi;
  const declared = new Set<string>();
  for (const block of svg.matchAll(styleBlock)) {
    for (const m of block[2].matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) declared.add(m[1]);
  }
  if (declared.size === 0) return svg;
  const prefix = `${scope}__`;
  return svg
    .replace(styleBlock, (_m, open: string, css: string, close: string) =>
      open + css.replace(/\.(-?[_a-zA-Z][\w-]*)/g, (m, name: string) => (declared.has(name) ? `.${prefix}${name}` : m)) + close,
    )
    .replace(/\bclass\s*=\s*"([^"]*)"/g, (_m, value: string) =>
      `class="${value
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => (declared.has(t) ? prefix + t : t))
        .join(' ')}"`,
    );
}

/** FNV-1a, enough to keep two icons' scopes apart. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function stem(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
}

/** "forti-gate" → "Forti Gate"; names already written by hand pass through. */
function prettyName(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function keywordsFor(name: string, extra: string[] = []): string[] {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
  const more = extra.map((k) => k.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...words, ...more])].slice(0, 24);
}

function decode(data: ArrayBuffer): string {
  return new TextDecoder().decode(new Uint8Array(data));
}
