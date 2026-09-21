import { CatalogPreview } from './CatalogPreview';
import { useEffect, useState } from 'react';
import type { RecentEntry } from '@/store/editor';
import { useEditor } from '@/store/editor';
import { isMonochromeSvg, recolorBlackToCurrent } from '@/icons/recolorable';
import { loadVendorPack } from '@/icons/manifest';
import { insertIconShape, insertLibraryShape } from '@/editor/insert';

/** A tile in the Recent tab - works in both MoreShapesPopover and LibraryPanel.
 *  Discriminated on `entry.source.kind` so the drag payload matches whatever
 *  picker originally produced the item:
 *    - 'library' → application/x-vellum-library
 *    - 'vendor' / 'iconify' → application/x-vellum-icon
 *
 *  React onDragStart is available as soon as the tile mounts. A native
 *  listener installed in useEffect would leave a gap after paint where a
 *  drag produces no payload. Inner SVG and image elements prevent their
 *  own drag events so the tile remains the drag source.
 *
 *  Click binding: a plain click inserts the same entry at the viewport
 *  centre through the insert helpers that mirror Canvas's drop branches.
 *  Drag stays for cursor-precise placement; a started drag withholds the
 *  click, so the two never collide. */
export function RecentTile({
  entry,
  onHover,
}: {
  entry: RecentEntry;
  onHover?: (hovered: boolean) => void;
}) {
  const onDragStart = (e: React.DragEvent<HTMLButtonElement>) => {
    if (entry.source.kind === 'library') {
      e.dataTransfer.setData(
        'application/x-vellum-library',
        JSON.stringify({
          id: entry.source.libShapeId,
          label: entry.label,
          glyph: entry.glyph,
          lib: entry.source.libName,
        }),
      );
    } else if (entry.source.kind === 'vendor') {
      e.dataTransfer.setData(
        'application/x-vellum-icon',
        JSON.stringify({
          source: 'vendor',
          iconId: entry.source.iconId,
          vendor: entry.source.vendor,
        }),
      );
    }
    // 'iconify' source kind is a legacy value - its drag is intentionally a
    // no-op in the offline core (would resolve via a network the desktop
    // build doesn't have). The tile renders as a glyph stub.
    e.dataTransfer.setData('text/plain', entry.label);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const onClick = () => {
    if (entry.source.kind === 'library') {
      insertLibraryShape({
        id: entry.source.libShapeId,
        label: entry.label,
        glyph: entry.glyph,
        libName: entry.source.libName,
      });
    } else if (entry.source.kind === 'vendor') {
      void insertIconShape({
        source: 'vendor',
        iconId: entry.source.iconId,
        vendor: entry.source.vendor,
      }).catch((err) => console.error('icon insert: resolve failed', err));
    }
    // 'iconify' - legacy source kind; same intentional no-op as the drag.
  };

  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      title={`${entry.label} - click to insert · drag to place`}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      className="flex flex-col items-center justify-center gap-[4px] py-[8px] px-1 bg-transparent border border-transparent rounded-md text-fg-muted hover:bg-bg-emphasis hover:border-border hover:text-fg transition-colors duration-100 cursor-pointer active:cursor-grabbing"
    >
      <div className="w-9 h-9 rounded-md bg-bg-subtle border border-border flex items-center justify-center font-mono text-[10px] font-bold text-accent overflow-hidden">
        <RecentPreview entry={entry} />
      </div>
      <span className="text-[10px] leading-[1.1] text-center max-w-full truncate w-full px-1">
        {entry.label}
      </span>
    </button>
  );
}

function RecentPreview({ entry }: { entry: RecentEntry }) {
  const theme = useEditor((s) => s.theme);
  const dark = theme === 'dark';
  if (entry.source.kind === 'vendor') {
    return <VendorPreview entry={entry} dark={dark} />;
  }
  if (entry.source.kind === 'library') return <CatalogPreview id={entry.source.libShapeId} glyph={entry.glyph} />;
  // Legacy Iconify entries retain their fallback.
  return <span>{entry.glyph}</span>;
}

function VendorPreview({ entry, dark }: { entry: RecentEntry; dark: boolean }) {
  const [svg, setSvg] = useState<string | null>(null);
  // Pull stable scalar fields out of the discriminated union BEFORE the
  // effect so the dep array can key on primitives. Using `entry` directly
  // re-fires the effect on every parent re-render whenever zustand hands
  // back a fresh array reference (the values are identical, but the
  // reference identity flips). The fresh-effect path runs the cleanup
  // first, which sets `cancelled = true` on the prior async load - so the
  // SVG never commits and the tile sticks on the glyph placeholder. Key
  // on the iconId+vendor pair instead; both are stable strings.
  const vendorKey =
    entry.source.kind === 'vendor' ? entry.source.vendor : null;
  const iconId =
    entry.source.kind === 'vendor' ? entry.source.iconId : null;
  useEffect(() => {
    if (!vendorKey || !iconId) return;
    let cancelled = false;
    loadVendorPack(vendorKey)
      .then((pack) => {
        if (cancelled) return;
        const icon = pack.icons.find((i) => i.id === iconId);
        if (icon) setSvg(icon.svg);
      })
      .catch(() => {
        // Pack missing (e.g. vendor was removed from the bundle since the
        // recent entry was stored) - stay on the glyph fallback.
      });
    return () => {
      cancelled = true;
    };
  }, [vendorKey, iconId]);
  if (svg) {
    // Picker-only recolour for monochrome vendor SVGs in dark mode - same
    // safety net as IconResultCard. The on-canvas vendor SVG is unchanged
    // (vendor icons are never recoloured outside the picker).
    const rendered =
      dark && isMonochromeSvg(svg) ? recolorBlackToCurrent(svg) : svg;
    return (
      <span
        className="block w-7 h-7 [&>svg]:w-full [&>svg]:h-full [&_svg]:pointer-events-none"
        style={{ color: 'var(--fg)' }}
        // Inner SVG nodes sit inside the button - pointer-events:none on the
        // svg itself keeps the button as the drag source. (We can't put
        // draggable=false on the dangerouslySetInnerHTML root from out here.)
        dangerouslySetInnerHTML={{ __html: rendered }}
      />
    );
  }
  return <span>{entry.glyph}</span>;
}

