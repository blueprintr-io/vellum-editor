// TRADEMARK-COMPLIANCE: pack tiles surface the vendor display name straight
// from the manifest (Manifest.vendors[key].name) - that's the trademark
// holder's preferred mark form per build-time stamping. The drill-in view
// reuses IconResultCard, which already renders the two-line license badge.

/* Icon Packs browser - paired tab content for MoreShapesPopover and
 * LibraryPanel.
 *
 * Two-state view:
 *   - List mode: every vendor pack as a row, the user's added packs ahead
 *     of the bundled ones. Pinned packs first (right-click toggles), then
 *     the rest in manifest order. Click a pack to drill in. "Add icon pack"
 *     reads a draw.io library, a zip or SVG files into a new pack.
 *   - Detail mode: the full icon grid for the chosen pack. Reuses
 *     IconResultCard (vendor source) so drag-to-canvas works without a
 *     custom drag handler. A back button in the header returns to the list,
 *     and a pack the user added can be removed from here.
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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '@/store/editor';
import {
  getBundledPacksStatus,
  getManifest,
  loadManifest,
  retryBundledPacks,
  subscribeManifest,
} from '@/icons/manifest';
import { removeIconPack } from '@/icons/added-packs';
import type { Manifest, ManifestVendor, VendorPack } from '@/icons/types';
import { PackIconGrid } from './icons/PackIconGrid';
import { AddIconPackDialog, ICON_PACK_ACCEPT } from './icons/AddIconPackDialog';
import { Button } from './ui/Button';

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
  // Adding or removing a pack replaces the catalogue.
  useEffect(() => subscribeManifest(setManifest), []);

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

  // Files picked for "Add icon pack"; the dialog reads and confirms them.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pickedFiles, setPickedFiles] = useState<File[] | null>(null);
  const addPack = (
    <>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        title="Add a draw.io library, a .zip of SVGs or SVG files"
        className="w-full px-[8px] py-[7px] bg-transparent border border-dashed border-border rounded-[5px] text-[11px] text-fg-muted hover:text-fg hover:bg-bg-emphasis transition-colors cursor-pointer"
      >
        + Add icon pack…
      </button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ICON_PACK_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : [];
          // Clear it so picking the same file again still fires.
          e.target.value = '';
          if (files.length > 0) setPickedFiles(files);
        }}
      />
      {pickedFiles && (
        <AddIconPackDialog
          files={pickedFiles}
          onClose={() => setPickedFiles(null)}
          onAdded={(key) => {
            setPickedFiles(null);
            setOpenVendor(key);
          }}
        />
      )}
    </>
  );

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

  if (orderedVendorKeys.length === 0) {
    const failed = getBundledPacksStatus() === 'failed';
    return (
      <div className="flex flex-col gap-[8px]">
        <div className="px-2 pt-6 pb-1 flex flex-col items-center gap-[8px] text-center text-fg-muted text-[11px] font-mono">
          <span>{failed ? "couldn't load the built-in icon packs" : 'no icon packs yet'}</span>
          {failed && (
            <button
              type="button"
              onClick={() => void retryBundledPacks()}
              className="px-[10px] py-[4px] bg-transparent border border-border rounded-[5px] text-fg hover:bg-bg-emphasis transition-colors cursor-pointer"
            >
              try again
            </button>
          )}
        </div>
        {addPack}
        <p className="text-[10px] text-fg-muted px-[2px] leading-snug">
          Add a draw.io library, a .zip of SVGs or a few SVG files. The pack
          shows up here and in search.
        </p>
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
      <div className="pb-[3px]">{addPack}</div>
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
          {vendor.added
            ? `${vendor.added.count} icons · added by you`
            : vendor.version}
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
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeFailed, setRemoveFailed] = useState(false);
  const remove = () => {
    removeIconPack(vendorKey).then(onBack, (err: unknown) => {
      console.error('removing icon pack failed', err);
      setRemoveFailed(true);
    });
  };

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
        {vendor.added && !confirmRemove && (
          <button
            type="button"
            onClick={() => setConfirmRemove(true)}
            title="Remove this pack"
            aria-label="Remove this pack"
            className="bg-transparent border-none text-fg-muted hover:text-fg cursor-pointer p-[2px] rounded shrink-0"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 8.5h6.6l.7-8.5M6.75 7v4M9.25 7v4" />
            </svg>
          </button>
        )}
      </div>
      {confirmRemove && (
        <div className="flex flex-col gap-[6px] px-[2px] pb-[10px]">
          <span className="text-[11px] text-fg leading-snug">
            {removeFailed
              ? "The pack couldn't be removed. Try again."
              : 'Remove this pack? Icons already in your diagrams stay as they are.'}
          </span>
          <div className="flex gap-[6px] justify-end">
            <Button size="sm" variant="secondary" onClick={() => setConfirmRemove(false)}>
              Keep
            </Button>
            <Button size="sm" variant="primary" onClick={remove}>
              Remove pack
            </Button>
          </div>
        </div>
      )}
      <PackIconGrid
        vendorKey={vendorKey}
        vendor={vendor}
        cols={cols}
        onPackLoaded={setPack}
      />
    </div>
  );
}

