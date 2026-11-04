// TRADEMARK-COMPLIANCE: stamps each manifest entry with branded-icon verdict
// (b / bh) and drops denied bundled brand wordmarks. See
// src/lib/branded-icon-namespaces.ts.

import { useEffect, useState } from 'react';
import type { Manifest, ManifestEntry, ManifestVendor, VendorPack } from './types';
import {
  detectBranded,
  isDeniedBundledBrand,
} from '@/lib/branded-icon-namespaces';
import { FuzzyIndex } from '@/lib/fuzzy-search';
import { sanitizeSvg } from '@/lib/sanitize-svg';
import {
  ADDED_PACK_PREFIX,
  addedVendorPack,
  getAddedPack,
  getAddedPacks,
  loadAddedPacks,
  onAddedPacksChange,
  type AddedIcon,
  type AddedIconPack,
} from './added-packs';

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

/* `_manifest` is the bundled catalogue exactly as fetched. Readers get
 * `_catalog`: the bundled packs plus the packs the user added. */
let _catalog: Manifest | null = null;
let _catalogPromise: Promise<Manifest> | null = null;
const _catalogListeners = new Set<(m: Manifest) => void>();

/** `missing`: the host bundles no packs and answered with a 404 (the
 *  Obsidian plugin, a build without vellum-iconpacks). `failed`: anything
 *  else went wrong, so a later load tries again. */
export type BundledPacksStatus = 'loading' | 'loaded' | 'missing' | 'failed';
let _bundledStatus: BundledPacksStatus = 'loading';
let _bundledFailedAt = 0;
/** After a failed load, readers wait this long before fetching again. */
const BUNDLED_RETRY_MS = 30_000;

/** Rebuild the catalogue and tell subscribers. Added packs come first, so a
 *  pack the user just added heads the Icons tab. */
function publishCatalog(): Manifest {
  const vendors: Record<string, ManifestVendor> = {};
  const icons: ManifestEntry[] = [];
  for (const pack of getAddedPacks()) {
    vendors[pack.key] = addedVendor(pack);
    for (const icon of pack.icons) icons.push(addedEntry(pack, icon));
  }
  for (const [key, vendor] of Object.entries(_manifest?.vendors ?? {})) {
    if (!(key in vendors)) vendors[key] = vendor;
  }
  for (const key of _packCache.keys()) {
    if (key.startsWith(ADDED_PACK_PREFIX)) _packCache.delete(key);
  }
  const catalog: Manifest = {
    ...(_manifest ?? { version: '' }),
    vendors,
    icons: _manifest ? icons.concat(_manifest.icons) : icons,
  };
  _catalog = catalog;
  for (const listener of _catalogListeners) listener(catalog);
  return catalog;
}

onAddedPacksChange(() => {
  publishCatalog();
});

function addedVendor(pack: AddedIconPack): ManifestVendor {
  return {
    name: pack.name,
    version: pack.version,
    packUrl: '',
    trademark: {
      holder: pack.holder || 'User-supplied',
      notice: `Added by you from ${pack.source}. You are responsible for having the rights to use these icons.`,
      guidelinesUrl: pack.guidelinesUrl ?? '',
    },
    added: { source: pack.source, count: pack.icons.length },
  };
}

function addedEntry(pack: AddedIconPack, icon: AddedIcon): ManifestEntry {
  return {
    id: `${pack.key}/${icon.id}`,
    v: pack.key,
    n: icon.name,
    c: icon.category,
    k: icon.keywords,
    b: false,
  };
}

/** The catalogue: bundled packs plus the user's added packs. Never rejects,
 *  so a host that bundles no packs still shows the added ones. */
export async function loadManifest(): Promise<Manifest> {
  const retry = _bundledStatus === 'failed' && Date.now() - _bundledFailedAt > BUNDLED_RETRY_MS;
  if (_catalog && _bundledStatus !== 'loading' && !retry) return _catalog;
  _catalogPromise ??= Promise.all([
    loadBundledManifest().then(
      () => {
        _bundledStatus = 'loaded';
      },
      (err: unknown) => {
        _bundledStatus = /\b404\b/.test(String(err instanceof Error ? err.message : err))
          ? 'missing'
          : 'failed';
        _bundledFailedAt = Date.now();
        if (_bundledStatus === 'failed') console.warn('bundled icon packs failed to load', err);
      },
    ),
    loadAddedPacks(),
  ])
    .then(() => publishCatalog())
    .finally(() => {
      _catalogPromise = null;
    });
  return _catalogPromise;
}

export function getBundledPacksStatus(): BundledPacksStatus {
  return _bundledStatus;
}

/** Fetch the bundled packs again now, after a failed load. */
export function retryBundledPacks(): Promise<Manifest> {
  _bundledFailedAt = 0;
  return loadManifest();
}

async function loadBundledManifest(): Promise<Manifest> {
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
  return _catalog;
}

/** Hear every new catalogue (a pack added or removed). */
export function subscribeManifest(listener: (m: Manifest) => void): () => void {
  _catalogListeners.add(listener);
  return () => {
    _catalogListeners.delete(listener);
  };
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
  const [m, setM] = useState<Manifest | null>(_catalog);
  // Packs the user adds or removes later replace the catalogue.
  useEffect(() => subscribeManifest(setM), []);
  useEffect(() => {
    if (_catalog) {
      // Late mount after load: catch up the local state. Cheap.
      if (m !== _catalog) setM(_catalog);
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
  const added = vendor.added ? getAddedPack(vendorKey) : null;
  if (added) {
    const ready = Promise.resolve(addedVendorPack(added));
    _packCache.set(vendorKey, ready);
    return ready;
  }
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

/** Complete matches enough to fill a picker; below this, icons missing one
 *  of the query's words fill in after them. */
const ENOUGH_COMPLETE = 12;

/** The search index over the loaded icons, built by the first search. */
let _searchIndex: { icons: ManifestEntry[]; index: FuzzyIndex } | null = null;

function manifestSearchIndex(m: Manifest): FuzzyIndex {
  if (_searchIndex?.icons !== m.icons) {
    _searchIndex = {
      icons: m.icons,
      index: new FuzzyIndex(
        m.icons.map((e) => ({
          name: e.n,
          keywords: e.k,
          context: [e.v, m.vendors[e.v]?.name ?? '', e.c ?? ''],
        })),
      ),
    };
  }
  return _searchIndex.index;
}

/** Icons for a picker query, best first. Forgiving (see @/lib/fuzzy-search):
 *  "fw" finds firewalls, "swtich" switches, "aws firewall" AWS's firewalls
 *  and then everyone else's. A query that is an icon's whole id, name or
 *  keyword always puts that icon first. */
export function searchManifest(
  query: string,
  limit = 24,
): Array<{ entry: ManifestEntry; vendor: ManifestVendor }> {
  if (!_catalog || !query.trim()) return [];
  const manifest = _catalog;
  const q = query.trim().toLowerCase();
  let hits = manifestSearchIndex(manifest).search(q);
  const complete = hits.filter((h) => !h.missing);
  if (complete.length >= ENOUGH_COMPLETE) hits = complete;
  const scored: Array<{
    entry: ManifestEntry;
    vendor: ManifestVendor;
    score: number;
  }> = [];
  for (const hit of hits) {
    const entry = manifest.icons[hit.index];
    const vendor = manifest.vendors[entry.v];
    if (!vendor) continue;
    scored.push({ entry, vendor, score: Math.max(exactScore(entry, q), hit.score) });
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

/** A query that is an icon's whole id, name or one of its keywords. */
function exactScore(entry: ManifestEntry, q: string): number {
  if (entry.id.toLowerCase() === q) return 1000;
  if (entry.n.toLowerCase() === q) return 500;
  for (const k of entry.k) if (k.toLowerCase() === q) return 200;
  return 0;
}
