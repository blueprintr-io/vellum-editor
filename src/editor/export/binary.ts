/* Byte-level helpers for the export formats - DOM-free so `node --test`
 * covers them (tests/export-binary.test.ts).
 *
 *  - PNG: chunk reader/writer, `pHYs` (DPI) and `iTXt` (embedded diagram
 *    source) chunks, with the CRC32 every chunk needs.
 *  - JPEG: patch the JFIF APP0 density so the file carries its DPI too.
 *  - ZIP: a minimal "stored" (uncompressed) archive for multi-tab exports.
 *    PNG/WebP/SVG payloads are already compressed; deflating them again
 *    buys nothing and would need a zip-compatible deflate implementation.
 *  - PDF: a minimal single-/multi-page writer that places one raster image
 *    per page. Vector PDF from SVG needs a full font + path converter; a
 *    2–4× bitmap page prints well at the sizes people use. */

// ── CRC32 (PNG / ZIP) ──────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Standard CRC-32 (IEEE 802.3, reflected, init/xorout 0xFFFFFFFF). */
export function crc32(bytes: Uint8Array, seed = 0xffffffff): number {
  let c = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const ascii = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Latin-1 bytes → string without spreading a large array into a call. */
function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function u16le(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
}
function u32le(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}
function readU32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

// ── PNG ────────────────────────────────────────────────────────────────

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

export interface PngChunk {
  type: string;
  data: Uint8Array;
}

/** Every chunk in a PNG, in order, up to and including IEND. Throws on a
 *  missing signature or a truncated chunk. CRCs are not verified - the
 *  decoder that consumes the file will. */
export function readPngChunks(bytes: Uint8Array): PngChunk[] {
  if (!isPng(bytes)) throw new Error('Not a PNG file');
  const out: PngChunk[] = [];
  let o = PNG_SIGNATURE.length;
  while (o + 8 <= bytes.length) {
    const len = readU32be(bytes, o);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    const start = o + 8;
    const end = start + len;
    if (end + 4 > bytes.length) throw new Error(`Truncated PNG chunk ${type}`);
    out.push({ type, data: bytes.subarray(start, end) });
    o = end + 4; // skip CRC
    if (type === 'IEND') break;
  }
  return out;
}

/** Serialize one chunk: length, type, data, CRC(type + data). */
export function writePngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const typeBytes = ascii(type);
  const crcInput = concatBytes([typeBytes, data]);
  return concatBytes([u32be(data.length), typeBytes, data, u32be(crc32(crcInput))]);
}

/** Insert `chunks` right after IHDR (ancillary chunks like pHYs and iTXt
 *  must precede IDAT; immediately after the header is always legal).
 *  Existing chunks of the same type are left in place for simplicity -
 * decoders take the first pHYs and browsers never emit one. */
export function insertPngChunks(bytes: Uint8Array, chunks: readonly PngChunk[]): Uint8Array<ArrayBuffer> {
  if (!isPng(bytes)) throw new Error('Not a PNG file');
  const ihdrLen = readU32be(bytes, 8);
  const ihdrEnd = 8 + 8 + ihdrLen + 4;
  const head = bytes.subarray(0, ihdrEnd);
  const tail = bytes.subarray(ihdrEnd);
  return concatBytes([head, ...chunks.map((c) => writePngChunk(c.type, c.data)), tail]);
}

/** `pHYs`: pixels per metre, both axes, unit specifier 1 (metre). */
export function pngPhysChunk(dpi: number): PngChunk {
  const ppm = Math.round(dpi / 0.0254);
  return { type: 'pHYs', data: concatBytes([u32be(ppm), u32be(ppm), new Uint8Array([1])]) };
}

/** `iTXt` (UTF-8, uncompressed): keyword NUL 0 0 NUL NUL text. Keywords
 *  are 1–79 Latin-1 characters; ours are ASCII. */
export function pngTextChunk(keyword: string, text: string): PngChunk {
  const kw = ascii(keyword.slice(0, 79));
  return {
    type: 'iTXt',
    data: concatBytes([kw, new Uint8Array([0, 0, 0, 0, 0]), utf8(text)]),
  };
}

/** First `iTXt` (or `tEXt`) chunk with `keyword`, decoded. Compressed
 *  iTXt payloads (flag 1) are skipped - we never write them. */
export function readPngText(bytes: Uint8Array, keyword: string): string | null {
  let chunks: PngChunk[];
  try {
    chunks = readPngChunks(bytes);
  } catch {
    return null;
  }
  for (const c of chunks) {
    if (c.type !== 'iTXt' && c.type !== 'tEXt') continue;
    const nul = c.data.indexOf(0);
    if (nul < 0) continue;
    const kw = latin1(c.data.subarray(0, nul));
    if (kw !== keyword) continue;
    if (c.type === 'tEXt') {
      return latin1(c.data.subarray(nul + 1));
    }
    // iTXt: keyword NUL compFlag compMethod lang NUL translated NUL text
    const compFlag = c.data[nul + 1];
    if (compFlag !== 0) continue;
    let o = nul + 3;
    const langEnd = c.data.indexOf(0, o);
    if (langEnd < 0) continue;
    o = langEnd + 1;
    const trEnd = c.data.indexOf(0, o);
    if (trEnd < 0) continue;
    return new TextDecoder().decode(c.data.subarray(trEnd + 1));
  }
  return null;
}

// ── JPEG ───────────────────────────────────────────────────────────────

/** Stamp a JFIF density (dots per inch) on a JPEG. Browsers emit a JFIF
 *  APP0 with density 1×1 "no units"; we rewrite it in place. A JPEG
 *  without APP0 gets one inserted right after SOI. Non-JPEG input is
 *  returned untouched. */
export function jpegWithDensity(bytes: Uint8Array, dpi: number): Uint8Array<ArrayBuffer> {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes.slice();
  const d = Math.max(1, Math.min(65535, Math.round(dpi)));
  const hasApp0 =
    bytes[2] === 0xff &&
    bytes[3] === 0xe0 &&
    bytes[6] === 0x4a && // J
    bytes[7] === 0x46 && // F
    bytes[8] === 0x49 && // I
    bytes[9] === 0x46; // F
  if (hasApp0) {
    const out = bytes.slice();
    // APP0 layout: FF E0, len(2), "JFIF\0", ver(2), units(1), xdens(2), ydens(2), ...
    out[13] = 1; // units: dots per inch
    out[14] = (d >>> 8) & 0xff;
    out[15] = d & 0xff;
    out[16] = (d >>> 8) & 0xff;
    out[17] = d & 0xff;
    return out;
  }
  const app0 = new Uint8Array([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01,
    (d >>> 8) & 0xff, d & 0xff, (d >>> 8) & 0xff, d & 0xff, 0x00, 0x00,
  ]);
  return concatBytes([bytes.subarray(0, 2), app0, bytes.subarray(2)]);
}

// ── ZIP (stored) ───────────────────────────────────────────────────────

export interface ZipEntry {
  /** Path inside the archive; forward slashes. */
  name: string;
  data: Uint8Array;
  date?: Date;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/** Build a ZIP archive with every entry stored uncompressed. UTF-8 names
 *  (general-purpose flag bit 11). Fine for archives under 4 GB. */
export function zipStore(entries: readonly ZipEntry[], now: Date = new Date(2026, 0, 1)): Uint8Array<ArrayBuffer> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = utf8(e.name);
    const crc = crc32(e.data);
    const { time, date } = dosDateTime(e.date ?? now);
    const local = concatBytes([
      u32le(0x04034b50),
      u16le(20), // version needed
      u16le(0x0800), // flags: UTF-8 names
      u16le(0), // method: stored
      u16le(time),
      u16le(date),
      u32le(crc),
      u32le(e.data.length),
      u32le(e.data.length),
      u16le(name.length),
      u16le(0),
      name,
      e.data,
    ]);
    const central = concatBytes([
      u32le(0x02014b50),
      u16le(20), // version made by
      u16le(20), // version needed
      u16le(0x0800),
      u16le(0),
      u16le(time),
      u16le(date),
      u32le(crc),
      u32le(e.data.length),
      u32le(e.data.length),
      u16le(name.length),
      u16le(0), // extra
      u16le(0), // comment
      u16le(0), // disk
      u16le(0), // internal attrs
      u32le(0), // external attrs
      u32le(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = concatBytes([
    u32le(0x06054b50),
    u16le(0),
    u16le(0),
    u16le(entries.length),
    u16le(entries.length),
    u32le(centralSize),
    u32le(offset),
    u16le(0),
  ]);
  return concatBytes([...locals, ...centrals, end]);
}

// ── PDF ────────────────────────────────────────────────────────────────

export interface PdfImagePage {
  /** Bitmap size in pixels. */
  width: number;
  height: number;
  /** Pixels per inch → page size in points is `px * 72 / dpi`. */
  dpi: number;
  /** Packed 8-bit RGB samples (3 bytes per pixel), optionally deflated. */
  rgb: Uint8Array;
  /** `'FlateDecode'` when `rgb` is a zlib stream, `null` for raw samples. */
  filter: 'FlateDecode' | null;
  /** Optional 8-bit alpha plane (1 byte per pixel) for a soft mask. */
  alpha?: { data: Uint8Array; filter: 'FlateDecode' | null };
}

function pdfTextString(s: string): string {
  // UTF-16BE with BOM, hex-encoded - handles any title without worrying
  // about PDFDocEncoding.
  let hex = 'FEFF';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0x3f;
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0');
      hex += (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else {
      hex += cp.toString(16).padStart(4, '0');
    }
  }
  return `<${hex.toUpperCase()}>`;
}

/** One image per page, each page sized so the bitmap prints at `dpi`. */
export function buildPdf(
  pages: readonly PdfImagePage[],
  meta: { title?: string; creator?: string; date?: Date } = {},
): Uint8Array<ArrayBuffer> {
  if (pages.length === 0) throw new Error('PDF needs at least one page');
  const objects: Uint8Array[] = []; // index = object number - 1
  const add = (parts: Array<string | Uint8Array>): number => {
    objects.push(concatBytes(parts.map((p) => (typeof p === 'string' ? ascii(p) : p))));
    return objects.length;
  };
  const ref = (n: number) => `${n} 0 R`;

  // Reserve 1 = catalog, 2 = pages, 3 = info.
  objects.push(new Uint8Array(0), new Uint8Array(0), new Uint8Array(0));
  const pageRefs: number[] = [];

  pages.forEach((p, i) => {
    const wPt = (p.width * 72) / p.dpi;
    const hPt = (p.height * 72) / p.dpi;
    let smaskRef: number | null = null;
    if (p.alpha) {
      smaskRef = add([
        `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceGray /BitsPerComponent 8` +
          (p.alpha.filter ? ` /Filter /${p.alpha.filter}` : '') +
          ` /Length ${p.alpha.data.length} >>\nstream\n`,
        p.alpha.data,
        '\nendstream',
      ]);
    }
    const imageRef = add([
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8` +
        (p.filter ? ` /Filter /${p.filter}` : '') +
        (smaskRef ? ` /SMask ${ref(smaskRef)}` : '') +
        ` /Length ${p.rgb.length} >>\nstream\n`,
      p.rgb,
      '\nendstream',
    ]);
    const content = `q ${wPt.toFixed(4)} 0 0 ${hPt.toFixed(4)} 0 0 cm /Im${i} Do Q`;
    const contentRef = add([`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
    const pageRef = add([
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(4)} ${hPt.toFixed(4)}] /Resources << /XObject << /Im${i} ${ref(imageRef)} >> >> /Contents ${ref(contentRef)} >>`,
    ]);
    pageRefs.push(pageRef);
  });

  objects[0] = ascii(`<< /Type /Catalog /Pages 2 0 R >>`);
  objects[1] = ascii(
    `<< /Type /Pages /Kids [${pageRefs.map(ref).join(' ')}] /Count ${pageRefs.length} >>`,
  );
  const d = meta.date ?? new Date(2026, 0, 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `D:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  objects[2] = ascii(
    `<< /Producer (Vellum) /Creator ${pdfTextString(meta.creator ?? 'Vellum')}` +
      (meta.title ? ` /Title ${pdfTextString(meta.title)}` : '') +
      ` /CreationDate (${dateStr}) >>`,
  );

  const parts: Uint8Array[] = [ascii('%PDF-1.4\n%âãÏÓ\n')];
  const offsets: number[] = [];
  let pos = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(pos);
    const head = ascii(`${i + 1} 0 obj\n`);
    const tail = ascii('\nendobj\n');
    parts.push(head, body, tail);
    pos += head.length + body.length + tail.length;
  });
  const xrefPos = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  parts.push(ascii(xref));
  return concatBytes(parts);
}
