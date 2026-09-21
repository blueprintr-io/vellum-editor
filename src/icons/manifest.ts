// TRADEMARK-COMPLIANCE: stamps each manifest entry with branded-icon verdict
// (b / bh) and drops denied bundled brand wordmarks. See
// src/lib/branded-icon-namespaces.ts.

import { useEffect, useState } from 'react';
import type { Manifest, ManifestEntry, ManifestVendor, VendorPack } from './types';
import {
  detectBranded,
  isDeniedBundledBrand,
} from '@/lib/branded-icon-namespaces';
import { sanitizeSvg } from '@/lib/sanitize-svg';

const MANIFEST_URL = '/icons/manifest.json';

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
// Per-vendor pack JSON cap. Higher than MAX_MANIFEST_BYTES because some packs
// (CNCF Landscape, ~2.4k logos) legitimately exceed the index size budget.
// Build-time pruning of embedded-raster / oversized SVGs keeps the worst
// offenders out of the pack, so 48 MB is comfortable headroom for the rest.
const MAX_PACK_BYTES = 48 * 1024 * 1024;

async function readJsonCapped<T>(res: Response, maxBytes: number): Promise<T> {
  const cl = Number(res.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > maxBytes) {
    throw new Error(`manifest response too large: ${cl} > ${maxBytes}`);
  }
  const text = await res.text();
  if (text.length > maxBytes) {
    throw new Error(`manifest response too large: ${text.length} > ${maxBytes}`);
  }
  return JSON.parse(text) as T;
}

let _manifest: Manifest | null = null;
let _manifestPromise: Promise<Manifest> | null = null;
const _packCache = new Map<string, Promise<VendorPack>>();

export async function loadManifest(): Promise<Manifest> {
  if (_manifest) return _manifest;
  if (_manifestPromise) return _manifestPromise;
  _manifestPromise = fetch(MANIFEST_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`manifest fetch failed: ${r.status}`);
      return readJsonCapped<Manifest>(r, MAX_MANIFEST_BYTES);
    })
    .then((m) => {
      const filtered: ManifestEntry[] = [];
      for (const entry of m.icons) {
        if (entry.v === 'flowchart' || isDeniedBundledBrand(entry.id)) continue;
        if (entry.b === undefined) {
          const verdict = detectBranded({
            id: entry.id,
            name: entry.n,
            tags: entry.k,
          });
          entry.b = verdict.branded;
          if (verdict.branded && verdict.holder && !entry.bh) {
            const v = m.vendors[entry.v];
            entry.bh = v?.trademark.holder
              ? shortHolder(v.trademark.holder)
              : verdict.holder;
          }
        }
        filtered.push(entry);
      }
      m.icons = filtered;
      _manifest = m;
      return m;
    })
    .catch((err) => {
      _manifestPromise = null;
      throw err;
    });
  return _manifestPromise;
}

export function getManifest(): Manifest | null {
  return _manifest;
}

/** React hook for components that want to read the manifest reactively -
 * i.e. need to re-render once the async fetch resolves. Existing call
 *  sites that only consult the manifest at user-driven interaction time
 *  (drag/drop, picker open) can keep using `getManifest()` directly; this
 *  hook exists for the always-mounted readers (canvas Shape.tsx, the
 *  inspector's IconBranch) where a stale `null` would block a feature
 *  forever until the user happens to re-trigger a render.
 *
 *  Returns the manifest if loaded, else null. Initial call kicks off
 *  loadManifest() if it hasn't already started - same idempotency as the
 *  module-level cache. */
export function useManifest(): Manifest | null {
  const [m, setM] = useState<Manifest | null>(_manifest);
  useEffect(() => {
    if (_manifest) {
      // Late mount after load: catch up the local state. Cheap.
      if (m !== _manifest) setM(_manifest);
      return;
    }
    let cancelled = false;
    loadManifest()
      .then((loaded) => {
        if (!cancelled) setM(loaded);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Intentionally exhaustive-deps disabled: the effect's job is to
    // bridge from "manifest is null" to "manifest is loaded" exactly
    // once per mount. Re-running on every state change would be
    // pointless work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return m;
}

export async function loadVendorPack(vendorKey: string): Promise<VendorPack> {
  const cached = _packCache.get(vendorKey);
  if (cached) return cached;
  const manifest = await loadManifest();
  const vendor = manifest.vendors[vendorKey];
  if (!vendor) throw new Error(`unknown vendor: ${vendorKey}`);
  const promise = fetch(vendor.packUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`pack fetch failed: ${r.status}`);
      return readJsonCapped<VendorPack>(r, MAX_PACK_BYTES);
    })
    .then((pack) => {
      // Defense-in-depth: re-sanitize SVGs at the runtime boundary in case the
      // pack JSON wasn't produced by our build script.
      if (Array.isArray(pack?.icons)) {
        for (const icon of pack.icons) {
          if (typeof icon?.svg === 'string' && icon.svg.length > 0) {
            icon.svg = sanitizeSvg(icon.svg);
          }
        }
      }
      return pack;
    })
    .catch((err) => {
      _packCache.delete(vendorKey);
      throw err;
    });
  _packCache.set(vendorKey, promise);
  return promise;
}

export function searchManifest(
  query: string,
  limit = 24,
): Array<{ entry: ManifestEntry; vendor: ManifestVendor }> {
  if (!_manifest || !query.trim()) return [];
  const q = query.trim().toLowerCase();
  const scored: Array<{
    entry: ManifestEntry;
    vendor: ManifestVendor;
    score: number;
  }> = [];

  for (const entry of _manifest.icons) {
    const score = scoreEntry(entry, q);
    if (score === 0) continue;
    const vendor = _manifest.vendors[entry.v];
    if (!vendor) continue;
    scored.push({ entry, vendor, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.entry.n.length - b.entry.n.length;
  });

  return scored.slice(0, limit).map(({ entry, vendor }) => ({ entry, vendor }));
}

function shortHolder(full: string): string {
  if (/amazon|aws/i.test(full)) return 'AWS';
  if (/google\s*cloud|gcp/i.test(full)) return 'Google Cloud';
  if (/microsoft\s*azure|azure/i.test(full)) return 'Microsoft Azure';
  if (/microsoft/i.test(full)) return 'Microsoft';
  if (/oracle/i.test(full)) return 'Oracle';
  if (/cisco/i.test(full)) return 'Cisco';
  if (/fortinet/i.test(full)) return 'Fortinet';
  if (/red\s*hat/i.test(full)) return 'Red Hat';
  return full
    .replace(/,?\s+(Inc\.?|LLC|Ltd\.?|Corp\.?|Corporation|or its affiliates).*$/i, '')
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
}

function scoreEntry(entry: ManifestEntry, q: string): number {
  const id = entry.id.toLowerCase();
  const name = entry.n.toLowerCase();

  if (id === q) return 1000;
  if (name === q) return 500;
  for (const k of entry.k) {
    if (k.toLowerCase() === q) return 200;
  }
  if (name.startsWith(q)) return 100;
  for (const k of entry.k) {
    if (k.toLowerCase().startsWith(q)) return 50;
  }
  if (name.includes(q)) return 25;
  for (const k of entry.k) {
    if (k.toLowerCase().includes(q)) return 10;
  }
  return 0;
}
