// TRADEMARK-COMPLIANCE: pack tiles surface the vendor display name straight
// from the manifest (Manifest.vendors[key].name) - that's the trademark
// holder's preferred mark form per build-time stamping. The drill-in view
// reuses IconResultCard, which already renders the two-line license badge.

/* Icon Packs browser - paired tab content for MoreShapesPopover and
 * LibraryPanel.
 *
 * Two-state view:
 *   - List mode: every bundled vendor pack as a row. Pinned packs first
 *     (right-click toggles), then the rest in manifest order. Click a pack
 *     to drill in.
 *   - Detail mode: the full icon grid for the chosen pack. Reuses
 *     IconResultCard (vendor source) so drag-to-canvas works without a
 *     custom drag handler. A back button in the header returns to the list.
 *
 * Why a dedicated browser (vs. relying on search): the icon-search results
 * panel only renders when the user has typed something - the new tab is the
 * "I know what library I want, just show me everything in it" surface. It
 * complements search rather than replacing it.
 *
 * Pin model: pinnedIconPacks is in the editor store (persisted). Right-
 * click on a pack tile toggles. We deliberately suppress the native context
 * menu so the right-click feels like a pin gesture, not a noisy menu - same
 * pattern the canvas uses for its own gestures. */

import { useEffect, useMemo, useState } from 'react';
import { useEditor } from '@/store/editor';
import { getManifest, loadManifest } from '@/icons/manifest';
import type { Manifest, ManifestVendor, VendorPack } from '@/icons/types';
import { PackIconGrid } from './icons/PackIconGrid';

type Props = {
  /** Match the parent grid density (3 in LibraryPanel, 4 in MoreShapesPopover). */
  cols: 3 | 4;
  /** Optional drill-in request from the parent (Dashboard pinned-pack tile).
   *  Wrapped in an object so consecutive clicks on the same pack still trigger
   *  a re-drill: each click produces a new reference, the effect's dep array
   *  notices, and the openVendor state flips even though the underlying
   *  vendor key is unchanged. */
  openVendorRequest?: { vendor: string } | null;
};

export function IconPacksBrowser({ cols, openVendorRequest }: Props) {
  const pinned = useEditor((s) => s.pinnedIconPacks);
  const togglePin = useEditor((s) => s.togglePinnedIconPack);

  // Manifest may still be loading on first open. Subscribe via local state
  // and re-render when it lands. Idempotent - the loader caches forever.
  const [manifest, setManifest] = useState<Manifest | null>(getManifest());
  useEffect(() => {
    if (manifest) return;
    let cancelled = false;
    loadManifest()
      .then((m) => {
        if (!cancelled) setManifest(m);
      })
      .catch(() => {
        /* surface the empty-state below */
      });
    return () => {
      cancelled = true;
    };
  }, [manifest]);

  // Currently-drilled-in vendor key. null = pack list view.
  const [openVendor, setOpenVendor] = useState<string | null>(
    openVendorRequest?.vendor ?? null,
  );
  // External "open this vendor" requests (Dashboard clicks). The effect runs
  // whenever the request object reference changes - fresh-object-per-click
  // means a second click on the same pinned tile after the user navigated
  // back still re-opens the pack.
  useEffect(() => {
    if (openVendorRequest) setOpenVendor(openVendorRequest.vendor);
  }, [openVendorRequest]);

  // Build the ordered vendor list - pinned first (in pinned order), then
  // everything else in manifest insertion order. We dedupe in case a stale
  // pin survives a manifest refresh that dropped the vendor.
  const orderedVendorKeys = useMemo(() => {
    if (!manifest) return [] as string[];
    const all = Object.keys(manifest.vendors).filter(k => k !== 'flowchart');
    const pinnedSet = new Set(pinned);
    const validPinned = pinned.filter((k) => k !== 'flowchart' && k in manifest.vendors);
    const rest = all.filter((k) => !pinnedSet.has(k));
    return [...validPinned, ...rest];
  }, [manifest, pinned]);

  if (!manifest) {
    return (
      <div className="px-2 py-6 text-center text-fg-muted text-[11px] font-mono">
        loading icon packs…
      </div>
    );
  }

  if (openVendor && manifest.vendors[openVendor]) {
    return (
      <PackDetail
        vendorKey={openVendor}
        vendor={manifest.vendors[openVendor]}
        cols={cols}
        onBack={() => setOpenVendor(null)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-[3px]">
      <div className="text-[9px] text-fg-muted px-[2px] pb-[6px] leading-tight">
        Right-click to pin a pack to the top. Click to browse it.
      </div>
      {orderedVendorKeys.map((key) => {
        const v = manifest.vendors[key];
        if (!v) return null;
        const isPinned = pinned.includes(key);
        return (
          <PackRow
            key={key}
            vendorKey={key}
            vendor={v}
            pinned={isPinned}
            onOpen={() => setOpenVendor(key)}
            onTogglePin={() => togglePin(key)}
          />
        );
      })}
    </div>
  );
}

/** A single pack tile in the list view. Click → drill in. Right-click →
 *  toggle pin (native menu suppressed). The pinned indicator is a tiny
 *  filled triangle on the left edge so the user can see at a glance which
 *  packs they've prioritised. */
function PackRow({
  vendorKey,
  vendor,
  pinned,
  onOpen,
  onTogglePin,
}: {
  vendorKey: string;
  vendor: ManifestVendor;
  pinned: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onTogglePin();
      }}
      title={
        pinned
          ? `${vendor.name} - right-click to unpin`
          : `${vendor.name} - right-click to pin`
      }
      data-vendor={vendorKey}
      className="flex items-center gap-[8px] w-full px-[8px] py-[6px] bg-transparent border border-border rounded-[5px] text-left hover:bg-bg-emphasis transition-colors cursor-pointer"
    >
      {/* Pin indicator - bookmark glyph when pinned, transparent placeholder
       *  otherwise so the row text doesn't shift between states. */}
      <span
        aria-hidden
        className="inline-flex items-center justify-center w-[10px] h-[10px] shrink-0"
        style={{
          color: pinned ? 'var(--accent)' : 'transparent',
          fontSize: 11,
          lineHeight: 1,
        }}
      >
        ▾
      </span>
      <span className="flex-1 min-w-0 flex flex-col">
        <span className="text-[12px] text-fg truncate font-medium">
          {vendor.name}
        </span>
        <span className="text-[9px] font-mono text-fg-muted truncate">
          {vendor.version}
        </span>
      </span>
      {/* Caret-right - drill affordance */}
      <span
        aria-hidden
        className="text-fg-muted shrink-0"
        style={{ fontSize: 11, lineHeight: 1 }}
      >
        ›
      </span>
    </button>
  );
}

/** Pack detail - header with back button + full icon grid. We lazy-load the
 *  pack JSON on mount; the loader caches at the manifest module so a second
 *  visit is instant. */
function PackDetail({
  vendorKey,
  vendor,
  cols,
  onBack,
}: {
  vendorKey: string;
  vendor: ManifestVendor;
  cols: 3 | 4;
  onBack: () => void;
}) {
  const [pack, setPack] = useState<VendorPack | null>(null);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-[6px] px-[2px] pb-[8px]">
        <button
          type="button"
          onClick={onBack}
          title="Back to icon packs"
          className="bg-transparent border-none text-fg-muted hover:text-fg cursor-pointer p-[2px] rounded"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M10 4l-4 4 4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span className="text-[11px] font-medium text-fg flex-1 truncate">
          {vendor.name}
        </span>
        <span className="text-[9px] font-mono text-fg-muted shrink-0">
          {pack ? `${pack.icons.length}` : ''}
        </span>
      </div>
      <PackIconGrid
        vendorKey={vendorKey}
        vendor={vendor}
        cols={cols}
        onPackLoaded={setPack}
      />
    </div>
  );
}

