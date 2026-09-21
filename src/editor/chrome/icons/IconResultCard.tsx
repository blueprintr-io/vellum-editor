// TRADEMARK-COMPLIANCE: vendor cards render the two-line "SVG: <license>
// · Brand: <holder>®" badge through IconLicenseBadge.

/* Single result card - drag source for vendor icon rows.
 *
 * The drag payload is a tiny IconDragPayload (id + source); the canvas drop
 * handler resolves the actual SVG bytes via `resolveIcon`. This keeps the
 * dataTransfer payload small.
 *
 * For the preview we render the SVG via dangerouslySetInnerHTML inside a
 * fixed-size frame. Vendor SVGs are sanitized at build time. */

import type {
  IconDragPayload,
  ManifestEntry,
  ManifestVendor,
} from '@/icons/types';
import { useEditor } from '@/store/editor';
import { isMonochromeSvg, recolorBlackToCurrent } from '@/icons/recolorable';
import { IconLicenseBadge } from './IconLicenseBadge';
import { insertIconShape } from '@/editor/insert';

type Props = {
  source: 'vendor';
  entry: ManifestEntry;
  vendor: ManifestVendor;
  /** Resolved SVG markup for the preview. Optional - until the pack is
   *  loaded we render a glyph placeholder (vendor short + name initial). */
  previewSvg?: string;
  /** Optional callback for hover - used by the parent to show a tooltip /
   *  enable a 1–9 binding hotkey, mirroring LibraryPanel's pattern. */
  onHover?: (hovered: boolean) => void;
  /** When provided, the tile becomes a click-to-pick button instead of a
   *  drag source. Used by the container "+ icon" flyout, where the
   *  destination is already known and dragging would be unnecessary
   *  ceremony. Drag mode (no onPick) stays the default - there a click
   *  inserts the icon at the viewport centre and a drag places it under
   *  the cursor. */
  onPick?: (payload: IconDragPayload, label: string) => void;
};

export function IconResultCard(props: Props) {
  const { entry, vendor, previewSvg, onPick } = props;
  // Theme drives the in-tile recolour for monochrome icons. The picker tile
  // is on a dark `bg-bg-subtle` (≈#161b22) in dark mode - black-on-black
  // monochrome icons render essentially invisible. We push currentColor /
  // tile-fg into the SVG so the user can actually see what they're picking.
  // (This is purely a *picker* visibility tweak - once the icon is dropped on
  // the canvas the normal colour rules in Shape.tsx still apply.)
  const theme = useEditor((s) => s.theme);
  const dark = theme === 'dark';

  const onDragStart = (e: React.DragEvent) => {
    const payload = {
      source: 'vendor' as const,
      iconId: entry.id,
      vendor: entry.v,
    };
    e.dataTransfer.setData(
      'application/x-vellum-icon',
      JSON.stringify(payload),
    );
    e.dataTransfer.setData('text/plain', entry.n);
    e.dataTransfer.effectAllowed = 'copy';
  };

  // Monochrome vendor SVGs (e.g. plain logo glyphs) are usually painted with
  // hard-coded black - invisible in dark mode. Repaint them with the tile's
  // foreground colour for the *picker only* by swapping black fills/strokes
  // to currentColor before injection. Multi-colour vendor icons are left
  // alone so brand colours stay intact. The drag payload + on-canvas SVG
  // resolution path is unchanged - this is purely cosmetic for the tile.
  const renderedSvg =
    previewSvg && dark && isMonochromeSvg(previewSvg)
      ? recolorBlackToCurrent(previewSvg)
      : previewSvg;
  // Click-to-pick mode short-circuits the drag wiring; both modes share the
  // same visual chrome and license badge so the picker is byte-identical
  // between the free-placement library flow and the container "+ icon"
  // flow. Mode is decided per-tile rather than globally so a future
  // container-pick UI could co-render alongside drag-source tiles without
  // a separate component.
  const pickMode = !!onPick;
  // Free-placement mode: a plain click drops the icon at the viewport
  // centre (the drag stays for cursor-precise placement). The two can't
  // collide - once dragstart fires the browser withholds the click for
  // that gesture, so a tile that was dragged never also inserts. Async
  // resolve failures log like the canvas drop branch does.
  const onInsertClick = () => {
    void insertIconShape({
      source: 'vendor',
      iconId: entry.id,
      vendor: entry.v,
    }).catch((err) => console.error('icon insert: resolve failed', err));
  };
  return (
    <button
      type="button"
      draggable={!pickMode}
      onDragStart={pickMode ? undefined : onDragStart}
      onClick={
        pickMode
          ? () =>
              onPick?.(
                { source: 'vendor', iconId: entry.id, vendor: entry.v },
                entry.n,
              )
          : onInsertClick
      }
      onMouseEnter={() => props.onHover?.(true)}
      onMouseLeave={() => props.onHover?.(false)}
      title={
        pickMode
          ? `${entry.n} - click to attach`
          : `${entry.n} - click to insert · drag to place`
      }
      className={
        pickMode
          ? 'flex flex-col items-center justify-center gap-[4px] py-[8px] px-1 bg-transparent border border-transparent rounded-md text-fg-muted hover:bg-bg-emphasis hover:border-border hover:text-fg transition-colors duration-100 cursor-pointer'
          : 'flex flex-col items-center justify-center gap-[4px] py-[8px] px-1 bg-transparent border border-transparent rounded-md text-fg-muted hover:bg-bg-emphasis hover:border-border hover:text-fg transition-colors duration-100 cursor-pointer active:cursor-grabbing'
      }
    >
      <div className="w-9 h-9 rounded-md bg-bg-subtle border border-border flex items-center justify-center overflow-hidden">
        {renderedSvg ? (
          <span
            className="block w-7 h-7 [&>svg]:w-full [&>svg]:h-full"
            style={{ color: 'var(--fg)' }}
            // Pack SVGs are sanitized at build time before reaching here.
            dangerouslySetInnerHTML={{ __html: renderedSvg }}
          />
        ) : (
          <span className="font-mono text-[10px] font-bold text-accent">
            {vendor.name.slice(0, 1)}
          </span>
        )}
      </div>
      <span className="text-[10px] leading-[1.1] text-center max-w-full truncate w-full px-1">
        {entry.n}
      </span>
      <IconLicenseBadge
        tone="vendor"
        short={shortVendorName(vendor.name)}
        guidelinesUrl={vendor.trademark.guidelinesUrl}
        size="xs"
      />
    </button>
  );
}

/** Crude vendor-name short form. Beats threading another field through the
 *  manifest just for chip text. */
function shortVendorName(full: string): string {
  if (full.startsWith('Amazon Web Services')) return 'AWS';
  if (full.startsWith('Google Cloud')) return 'GCP';
  if (full.startsWith('Microsoft Azure')) return 'Azure';
  // Fallback: first letter of each word, max 4 chars.
  return full
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 4)
    .toUpperCase();
}
