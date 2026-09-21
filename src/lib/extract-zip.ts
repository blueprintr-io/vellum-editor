/* ZIP extraction for imported SVG libraries and Visio packages.
 * Supports stored and raw-deflate entries. ZIP64, multi-disk archives and
 * encryption are rejected. Bounds apply to both metadata and bytes read. */

export type ZipEntry = {
  name: string;
  data: ArrayBuffer;
};

export type ZipExtractResult = {
  entries: ZipEntry[];
  skipped: { name: string; reason: string }[];
};

export const ZIP_LIMITS = {
  inputBytes: 100 * 1024 * 1024,
  entryBytes: 50 * 1024 * 1024,
  totalBytes: 200 * 1024 * 1024,
  entries: 5000,
} as const;
type ZipLimits = { -readonly [K in keyof typeof ZIP_LIMITS]: number };
const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL_DIR = 0x02014b50;
const SIG_LOCAL_FILE = 0x04034b50;

/** Check file size before allocating the archive buffer. */
export async function extractZipFile(file: Pick<Blob, 'size' | 'arrayBuffer'>): Promise<ZipExtractResult> {
  if (file.size > ZIP_LIMITS.inputBytes) throw new Error('ZIP archive exceeds input size limit.');
  const buffer = await file.arrayBuffer();
  if (!looksLikeZip(buffer)) throw new Error('That file is not a valid ZIP archive.');
  return extractZip(buffer);
}

/** Callers may lower the limits for their import context. */
export async function extractZip(
  buffer: ArrayBuffer,
  requestedLimits: Partial<ZipLimits> = {},
): Promise<ZipExtractResult> {
  const limits = { ...ZIP_LIMITS } as ZipLimits;
  for (const key of Object.keys(limits) as (keyof ZipLimits)[]) {
    const requested = requestedLimits[key];
    if (requested !== undefined && Number.isFinite(requested)) {
      limits[key] = Math.max(0, Math.min(limits[key], Math.floor(requested)));
    }
  }
  if (buffer.byteLength > limits.inputBytes) throw new Error('ZIP archive exceeds input size limit.');
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const malformed = () => new Error('Not a valid ZIP file (invalid header or data bounds).');
  const requireRange = (offset: number, length: number, end = buffer.byteLength) => {
    if (offset < 0 || length < 0 || offset > end || length > end - offset) throw malformed();
  };

  // A ZIP comment can follow the 22-byte end record, up to 65535 bytes.
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === SIG_EOCD && i + 22 + view.getUint16(i + 20, true) === buffer.byteLength) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP file (end-of-central-directory not found).');
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdStart = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdStart === 0xffffffff) throw new Error('ZIP64 archives are not supported.');
  if (view.getUint16(eocd + 4, true) || view.getUint16(eocd + 6, true) || view.getUint16(eocd + 8, true) !== count) {
    throw new Error('Multi-disk ZIP archives are not supported.');
  }
  if (count > limits.entries) throw new Error('ZIP archive exceeds entry count limit.');
  requireRange(cdStart, cdSize, eocd);
  const cdEnd = cdStart + cdSize;
  const entries: ZipEntry[] = [];
  const skipped: ZipExtractResult['skipped'] = [];
  const decoder = new TextDecoder();
  // Count bytes consumed from failed entries too, so repeated oversized
  // streams cannot each consume the full archive budget.
  let inflatedBytes = 0;
  let cursor = cdStart;
  for (let n = 0; n < count; n++) {
    requireRange(cursor, 46, cdEnd);
    if (view.getUint32(cursor, true) !== SIG_CENTRAL_DIR) throw malformed();
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const declaredSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const local = view.getUint32(cursor + 42, true);
    requireRange(cursor, 46 + nameLength + extraLength + commentLength, cdEnd);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (flags & 1) { skipped.push({ name, reason: 'encrypted entries are not supported' }); continue; }
    requireRange(local, 30, cdStart);
    if (view.getUint32(local, true) !== SIG_LOCAL_FILE || view.getUint16(local + 8, true) !== method || (view.getUint16(local + 6, true) & 1)) {
      throw malformed();
    }
    const localNameLength = view.getUint16(local + 26, true);
    const localExtraLength = view.getUint16(local + 28, true);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    requireRange(local, 30 + localNameLength + localExtraLength, cdStart);
    requireRange(dataStart, compressedSize, cdStart);
    if (declaredSize > limits.entryBytes) { skipped.push({ name, reason: 'entry exceeds size limit' }); continue; }
    if (declaredSize > limits.totalBytes - inflatedBytes) { skipped.push({ name, reason: 'archive exceeds total size limit' }); break; }
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      if (compressedSize > limits.entryBytes) { skipped.push({ name, reason: 'entry exceeds size limit' }); continue; }
      if (compressedSize > limits.totalBytes - inflatedBytes) { skipped.push({ name, reason: 'archive exceeds total size limit' }); break; }
      inflatedBytes += compressedSize;
      if (compressedSize !== declaredSize) { skipped.push({ name, reason: 'entry size does not match ZIP metadata' }); continue; }
      entries.push({ name, data: compressed.slice().buffer });
    } else if (method === 8) {
      // Read and cap each output chunk before storing it. arrayBuffer() on
      // the full stream would allocate unbounded output for false metadata.
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const chunks: Uint8Array[] = [];
      let size = 0;
      let totalLimit = false;
      try {
        reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          inflatedBytes += value.byteLength;
          totalLimit = inflatedBytes > limits.totalBytes;
          if (totalLimit || size > limits.entryBytes) throw new Error(totalLimit ? 'archive exceeds total size limit' : 'entry exceeds size limit');
          chunks.push(value);
        }
        if (size !== declaredSize) throw new Error('entry size does not match ZIP metadata');
        const data = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        entries.push({ name, data: data.buffer });
      } catch (err) {
        await reader?.cancel().catch(() => {});
        skipped.push({ name, reason: err instanceof Error ? err.message : String(err) });
      } finally {
        reader?.releaseLock();
      }
      if (totalLimit) break;
    } else {
      skipped.push({ name, reason: `unsupported compression method ${method}` });
    }
  }
  return { entries, skipped };
}

/** Filter zip entries down to SVG payloads. Strips the ".svg" suffix and
 *  surfaces the original folder path so the caller can use it as a label
 *  hint or category. */
export function svgEntriesFrom(result: ZipExtractResult): {
  /** Just the basename, no extension - what we use as the icon's display
   *  label and as the seed for the iconAttribution.iconId. */
  baseName: string;
  /** Slash-separated folder path inside the zip (empty string for root). */
  folder: string;
  svg: string;
}[] {
  const decoder = new TextDecoder();
  const out: { baseName: string; folder: string; svg: string }[] = [];
  for (const entry of result.entries) {
    if (!/\.svgz?$/i.test(entry.name)) continue;
    // Skip macOS resource forks - zips made on Mac sometimes include them.
    if (entry.name.startsWith('__MACOSX/') || /\/\._/.test(entry.name)) continue;
    const text = decoder.decode(new Uint8Array(entry.data));
    if (!/<svg[\s>]/i.test(text)) continue;
    const lastSlash = entry.name.lastIndexOf('/');
    const folder = lastSlash >= 0 ? entry.name.slice(0, lastSlash) : '';
    const file = lastSlash >= 0 ? entry.name.slice(lastSlash + 1) : entry.name;
    const baseName = file.replace(/\.svgz?$/i, '');
    out.push({ baseName, folder, svg: text });
  }
  // Stable order: folder-first alpha, then filename alpha. Keeps the
  // imported library predictable across re-imports of the same zip.
  out.sort((a, b) =>
    a.folder === b.folder
      ? a.baseName.localeCompare(b.baseName)
      : a.folder.localeCompare(b.folder),
  );
  return out;
}

/** Detect whether a buffer looks like a zip (EOCD signature scan). Used by
 *  the import dialog to route .vssx files through the same extractor as
 *  plain zips - Visio's modern format IS a zip with a different extension. */
export function looksLikeZip(buffer: ArrayBuffer): boolean {
  // PK header at byte 0 is the cheap check - every zip starts with one of
  // 'PK\x03\x04' (local file), 'PK\x05\x06' (empty zip), or 'PK\x07\x08'.
  if (buffer.byteLength < 4) return false;
  const view = new DataView(buffer);
  const sig = view.getUint32(0, true);
  return sig === 0x04034b50 || sig === 0x06054b50 || sig === 0x08074b50;
}
