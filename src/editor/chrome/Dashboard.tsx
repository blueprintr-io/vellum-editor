// Home contains recent shapes and pinned icon packs. Both feeds persist across reloads.

import { useEffect, useState } from 'react';
import { useEditor } from '@/store/editor';
import { getManifest, loadManifest } from '@/icons/manifest';
import type { Manifest } from '@/icons/types';
import { RecentTile } from './RecentTile';

type Props = {
  /** Match the parent grid density (3 in LibraryPanel, 4 in MoreShapesPopover)
   *  so the recents grid lines up with the search-result grids in the same
   *  panel. */
  cols: 3 | 4;
  /** Fired when the user clicks a pinned-pack tile. Parent flips to the
   *  Icons tab and threads the vendor key through to
   *  IconPacksBrowser's `openVendorRequest`. */
  onOpenPack: (vendorKey: string) => void;
};

const RECENT_DISPLAY_LIMIT = 9;

export function Dashboard({ cols, onOpenPack }: Props) {
  const recentShapes = useEditor((s) => s.recentShapes);
  const pinnedIconPacks = useEditor((s) => s.pinnedIconPacks);
  const clearRecent = useEditor((s) => s.clearRecent);
  const togglePin = useEditor((s) => s.togglePinnedIconPack);

  // Manifest powers the pinned-pack tile labels. Reuses the same lazy load
  // path IconPacksBrowser uses - idempotent and cached.
  const [manifest, setManifest] = useState<Manifest | null>(getManifest());
  useEffect(() => {
    if (manifest) return;
    let cancelled = false;
    loadManifest()
      .then((m) => {
        if (!cancelled) setManifest(m);
      })
      .catch(() => {
        /* Pinned column degrades to "loading…" / hidden - non-fatal. */
      });
    return () => {
      cancelled = true;
    };
  }, [manifest]);

  // Filter stale pins (vendor was removed from the bundle since the pin
  // was stored) so the user doesn't see a tile that errors when clicked.
  const visiblePins = manifest
    ? pinnedIconPacks.filter((k) => k !== 'flowchart' && k in manifest.vendors)
    : [];

  const recents = recentShapes.slice(0, RECENT_DISPLAY_LIMIT);
  const recentsGridCls =
    cols === 4 ? 'grid grid-cols-4 gap-1' : 'grid grid-cols-3 gap-1';

  return (
    <div className="flex flex-col gap-[10px]">
      {/* Top row - recent shapes/icons */}
      <section>
        <div className="flex items-center justify-between mb-[6px] px-1">
          <span className="font-mono text-[9px] text-fg-muted tracking-[0.04em]">
            recent
          </span>
          {recents.length > 0 && (
            <button
              onClick={clearRecent}
              className="bg-transparent border-none text-fg-muted hover:text-fg text-[10px] font-mono cursor-pointer"
              title="Clear recent activity"
            >
              clear
            </button>
          )}
        </div>
        {recents.length > 0 ? (
          <div className={recentsGridCls}>
            {recents.map((entry) => (
              <RecentTile key={entry.key} entry={entry} />
            ))}
          </div>
        ) : (
          <div className="px-2 py-4 text-center text-fg-muted text-[10px] font-mono leading-tight">
            recent shapes appear here
          </div>
        )}
      </section>

      {/* Bottom row - pinned packs quick-launch */}
      <section>
        <span className="font-mono text-[9px] text-fg-muted tracking-[0.04em] mb-[6px] px-1 block">
          pinned
        </span>
        {visiblePins.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {visiblePins.map((key) => {
              const v = manifest?.vendors[key];
              if (!v) return null;
              return (
                <PinnedPackTile
                  key={key}
                  vendorKey={key}
                  label={v.name}
                  onOpen={() => onOpenPack(key)}
                  onUnpin={() => togglePin(key)}
                />
              );
            })}
          </div>
        ) : (
          <div className="px-2 py-2 text-fg-muted text-[10px] font-mono leading-tight">
            right-click a pack in Icons to pin it here
          </div>
        )}
      </section>
    </div>
  );
}

function PinnedPackTile({
  vendorKey,
  label,
  onOpen,
  onUnpin,
}: {
  vendorKey: string;
  label: string;
  onOpen: () => void;
  onUnpin: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onUnpin();
      }}
      title={`${label} - click to browse, right-click to unpin`}
      data-vendor={vendorKey}
      className="inline-flex items-center px-[8px] py-[4px] bg-bg-subtle border border-border rounded-[4px] text-[10px] text-fg hover:bg-bg-emphasis hover:border-accent/60 transition-colors cursor-pointer max-w-[140px]"
    >
      <span className="truncate">{label}</span>
    </button>
  );
}
