/* Lazy-loaded full-icon grid for a single vendor pack.
 *
 * Shared by IconPacksBrowser's drill-in detail view (drag-to-canvas) and
 * ConnectorIconFlyout's "open the source shape's own pack" default view
 * (click-to-pick via `onPick`). The pack JSON is fetched on mount and cached
 * at the manifest module, so a second visit to the same pack is instant. */

import { useEffect, useState } from 'react';
import { loadVendorPack } from '@/icons/manifest';
import type {
  IconDragPayload,
  ManifestVendor,
  VendorPack,
} from '@/icons/types';
import { IconResultCard } from './IconResultCard';

type Props = {
  vendorKey: string;
  vendor: ManifestVendor;
  /** Match the parent grid density (3 in LibraryPanel, 4 elsewhere). */
  cols: 3 | 4;
  /** When provided, tiles become click-to-pick buttons instead of drag
   *  sources - used by ConnectorIconFlyout, where the destination shape is
   *  already known. Omit for the free-placement drag flow. */
  onPick?: (payload: IconDragPayload, label: string) => void;
  /** Fires once the pack JSON resolves. Lets the parent show a header count
   *  without owning the fetch. */
  onPackLoaded?: (pack: VendorPack) => void;
};

export function PackIconGrid({
  vendorKey,
  vendor,
  cols,
  onPick,
  onPackLoaded,
}: Props) {
  const [pack, setPack] = useState<VendorPack | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPack(null);
    setError(null);
    loadVendorPack(vendorKey)
      .then((p) => {
        if (cancelled) return;
        setPack(p);
        onPackLoaded?.(p);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err?.message || err));
      });
    return () => {
      cancelled = true;
    };
    // onPackLoaded is intentionally excluded - parents pass an inline
    // callback, so including it would re-fetch the pack every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorKey]);

  const gridCls =
    cols === 4 ? 'grid grid-cols-4 gap-1' : 'grid grid-cols-3 gap-1';

  if (error) {
    return (
      <div className="px-2 py-6 text-center text-fg-muted text-[11px] font-mono">
        failed to load pack
      </div>
    );
  }
  if (!pack) {
    return (
      <div className="px-2 py-6 text-center text-fg-muted text-[11px] font-mono">
        loading…
      </div>
    );
  }
  return (
    <div className={gridCls}>
      {pack.icons.map((icon) => (
        // Synthetic ManifestEntry - IconResultCard only reads id / v / n / k,
        // none of which need a fresh manifest lookup. Branded badge state is
        // left undefined; the card's vendor branch always shows the trademark
        // chip, which is correct for bundled packs.
        <IconResultCard
          key={icon.id}
          source="vendor"
          entry={{
            id: icon.id,
            v: vendorKey,
            n: icon.name,
            c: icon.category,
            k: icon.keywords,
          }}
          vendor={vendor}
          previewSvg={icon.svg}
          onPick={onPick}
        />
      ))}
    </div>
  );
}
