/**
 * Content-addressed document assets.
 *
 * Binary payloads (pasted screenshots, imported images) used to live as
 * base64 data URLs inside each shape's `src`. That kept documents
 * self-contained but meant: (a) duplicating a shape duplicated the
 * bytes, (b) every serialization (file save, localStorage backup,
 * cloud autosave) re-shipped every image, and (c) hosts that transport
 * the doc through a size-capped channel had to squeeze image quality
 * to fit the doc under the cap.
 *
 * The `assets` registry moves the bytes to one document-level table:
 *
 *   assets:
 *     <sha256-hex>: { mime: image/png, data: <base64, no data: prefix> }
 *
 * and shapes reference entries as `src: asset:<sha256-hex>`. The
 * document stays exactly as self-contained as before - the bytes are
 * still IN the file - but they're stored once regardless of how many
 * shapes use them, and an embedding host can strip the table out for
 * transport and re-inline it on export without touching any shape.
 *
 * Compatibility is deliberately soft, in both directions:
 *   - No version bump. `DiagramSchema` is a looseObject, so editors
 *     older than this module keep the `assets` key intact through a
 *     load/save round-trip; they render placeholder boxes for
 *     `asset:` srcs but never lose the data.
 *   - Inline `data:` srcs remain first-class forever. Nothing migrates
 *     on load - a doc only gains an assets table when new bytes are
 *     ingested (paste/drop/import) or a host explicitly interns.
 *
 * Small images (< INLINE_KEEP_BYTES) intentionally stay inline in
 * `src`: registry indirection buys nothing for a 10 KB icon and would
 * churn thousands of existing docs' worth of tiny images.
 */

import type {
  DiagramAssetEntry,
  DiagramState,
  Shape,
} from '../store/types';

export const ASSET_SRC_PREFIX = 'asset:';

/** Encoded (base64/data-URL) size below which an image simply stays
 *  inline in `src`. */
export const INLINE_KEEP_BYTES = 32_000;

/** Local alias - the registry entry is in store/types.ts (the file
 *  format is defined there); this module is the behavior around it. */
export type DiagramAsset = DiagramAssetEntry;

export const isAssetSrc = (src: string | undefined): src is string =>
  typeof src === 'string' && src.startsWith(ASSET_SRC_PREFIX);

export const assetHashFromSrc = (src: string): string =>
  src.slice(ASSET_SRC_PREFIX.length);

export const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

/** data URL for rendering / export. The registry stores bare base64 so
 *  the YAML stays clean; the prefix is reattached at use sites. */
export const assetToDataUrl = (a: DiagramAsset): string =>
  `data:${a.mime};base64,${a.data}`;

/** SHA-256 of raw bytes as lowercase hex. WebCrypto is available in every
 *  supported host (secure browser contexts, Tauri, jsdom w/ polyfill). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh Uint8Array so TS sees a plain ArrayBuffer-backed
  // view (a SharedArrayBuffer-backed view isn't a valid BufferSource).
  const plain = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', plain);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Split a data: URL into a registry payload, normalising non-base64
 *  bodies (percent-encoded SVG) to base64. Returns null when the input
 *  isn't a data URL at all. */
export function dataUrlToAssetPayload(
  dataUrl: string,
): { mime: string; data: string; bytes: Uint8Array } | null {
  if (!dataUrl.startsWith('data:')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const header = dataUrl.slice('data:'.length, comma);
  const mime = header.split(';')[0] || 'image/png';
  const body = dataUrl.slice(comma + 1);
  try {
    if (/;base64$/i.test(header)) {
      const bin = atob(body);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      // Re-encode instead of trusting `body`: strips whitespace/URL-safe
      // variants so equal bytes always produce equal base64 (and hashes).
      return { mime, data: bytesToBase64(bytes), bytes };
    }
    const text = decodeURIComponent(body);
    const bytes = new TextEncoder().encode(text);
    return { mime, data: bytesToBase64(bytes), bytes };
  } catch {
    return null;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked fromCharCode: .apply on multi-MB arrays overflows the arg
  // stack; 8 KB chunks keep it linear without a per-byte string concat.
  let bin = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Intern one data URL: hash the DECODED bytes (so base64 formatting
 *  differences can't split identical images across entries) and return
 *  the registry entry + `asset:` src to store on the shape. */
export async function internDataUrl(
  dataUrl: string,
): Promise<{ hash: string; asset: DiagramAsset; src: string } | null> {
  const payload = dataUrlToAssetPayload(dataUrl);
  if (!payload) return null;
  const hash = await sha256Hex(payload.bytes);
  return {
    hash,
    asset: { mime: payload.mime, data: payload.data },
    src: ASSET_SRC_PREFIX + hash,
  };
}

/** Decide whether an encoded data URL is worth interning at all. */
export const shouldIntern = (dataUrl: string): boolean =>
  dataUrl.startsWith('data:') && dataUrl.length >= INLINE_KEEP_BYTES;

/** Ingestion-site convenience: small images pass through inline (empty
 *  entries), large ones come back as an `asset:` src plus the registry
 *  entries to merge (via the store's registerAssets) BEFORE the shape
 *  is added, so a ref is never observably dangling. */
export async function internImportedDataUrl(
  dataUrl: string,
): Promise<{ src: string; entries: Record<string, DiagramAsset> }> {
  if (!shouldIntern(dataUrl)) return { src: dataUrl, entries: {} };
  const interned = await internDataUrl(dataUrl);
  if (!interned) return { src: dataUrl, entries: {} };
  return { src: interned.src, entries: { [interned.hash]: interned.asset } };
}

/** Hashes referenced by at least one shape. Connectors/annotations
 *  never carry binary srcs today; extend here if that changes. */
export function collectReferencedAssetHashes(d: DiagramState): Set<string> {
  const out = new Set<string>();
  for (const s of d.shapes) {
    const src = (s as Shape).src;
    if (isAssetSrc(src)) out.add(assetHashFromSrc(src));
  }
  return out;
}

/** Serialize-time GC: emit only assets some shape still references.
 *  Orphans appear when an image shape is deleted or an undo removes the
 *  shape but not the registry entry - pruning here means files never
 *  accumulate dead bytes. Returns the SAME object when nothing changes
 *  so hot save paths don't allocate. */
export function pruneAssets(d: DiagramState): DiagramState {
  const assets = d.assets;
  if (!assets) return d;
  const keys = Object.keys(assets);
  if (keys.length === 0) {
    // Empty table - drop the key entirely so asset-free docs serialize
    // byte-identically to the pre-assets format.
    const { assets: _drop, ...rest } = d;
    return rest as DiagramState;
  }
  const referenced = collectReferencedAssetHashes(d);
  if (keys.length === referenced.size && keys.every((k) => referenced.has(k))) {
    return d;
  }
  const kept: Record<string, DiagramAsset> = {};
  for (const k of keys) {
    if (referenced.has(k)) kept[k] = assets[k];
  }
  if (Object.keys(kept).length === 0) {
    const { assets: _drop, ...rest } = d;
    return rest as DiagramState;
  }
  return { ...d, assets: kept };
}

/** Walk a diagram and intern every large inline data: src into the
 *  registry. Used after importers (draw.io / Excalidraw produce inline
 *  data URLs) and by hosts that externalize assets for transport.
 *  Small images stay inline (see INLINE_KEEP_BYTES). Returns the same
 *  object when nothing qualified. */
export async function internDiagramAssets(
  d: DiagramState,
): Promise<DiagramState> {
  const candidates = d.shapes.filter(
    (s) => typeof s.src === 'string' && shouldIntern(s.src),
  );
  if (candidates.length === 0) return d;
  const assets: Record<string, DiagramAsset> = { ...(d.assets ?? {}) };
  const srcByShapeId = new Map<string, string>();
  for (const s of candidates) {
    const interned = await internDataUrl(s.src as string);
    if (!interned) continue; // malformed data URL - leave the shape alone
    assets[interned.hash] = interned.asset;
    srcByShapeId.set(s.id, interned.src);
  }
  if (srcByShapeId.size === 0) return d;
  return {
    ...d,
    assets,
    shapes: d.shapes.map((s) =>
      srcByShapeId.has(s.id) ? { ...s, src: srcByShapeId.get(s.id) } : s,
    ),
  };
}

/** Render-side resolution: `asset:` srcs become data URLs, everything
 *  else passes through untouched. A ref whose entry is missing (doc
 *  produced by a newer host and stripped in transit, or hand-edited)
 *  returns undefined - the image shape renders its placeholder state
 *  rather than a broken external fetch. */
export function resolveShapeSrc(
  src: string | undefined,
  assets: Record<string, DiagramAsset> | undefined,
): string | undefined {
  if (!isAssetSrc(src)) return src;
  const entry = assets?.[assetHashFromSrc(src)];
  return entry ? assetToDataUrl(entry) : undefined;
}
