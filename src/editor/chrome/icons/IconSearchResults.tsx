/* Inline icon search results, embedded in LibraryPanel + MoreShapesPopover.
 *
 * Renders nothing until `query` has at least one non-whitespace character.
 * Then shows a single "Icon packs" section with vendor-pack matches.
 *
 * Sizing: parent passes `cols` so the result grid lines up with the parent's
 * existing library-shape grid (3 in LibraryPanel, 4 in MoreShapesPopover).
 *
 * Vendor previews come from the per-vendor pack JSON, lazy-loaded as new
 * vendors surface in results. Cached at the manifest module so flipping
 * between queries doesn't re-fetch. */

import { useEffect, useMemo, useState } from 'react';
import { loadVendorPack } from '@/icons/manifest';
import { useIconSearch } from '@/icons/useIconSearch';
import type {
  IconDragPayload,
  ManifestEntry,
  ManifestVendor,
  VendorPack,
} from '@/icons/types';
import { IconResultCard } from './IconResultCard';

type Props = {
  query: string;
  /** Grid column count - parent decides so it matches its own shape grid. */
  cols: 3 | 4;
  /** When provided, tiles switch to click-to-pick mode and fire this
   *  callback instead of starting a drag. Used by ContainerIconFlyout to
   *  attach the picked icon to a known destination container. */
  onPick?: (payload: IconDragPayload, label: string) => void;
};

/** Top-level + sub-section collapsed-state map. Keyed by a stable string
 *  ('packs', `pack:${vendorKey}`) so a user who collapses "AWS" within Icon
 *  packs keeps it collapsed across keystrokes that re-render the results.
 *  Is in component state - intentionally NOT persisted to disk;
 *  collapsed-state is throwaway UI affordance. */
type CollapseMap = Record<string, boolean>;

export function IconSearchResults({ query, cols, onPick }: Props) {
  const { vendor, manifestReady } = useIconSearch(query);
  const previewSvgs = useVendorPreviews(vendor);
  const [collapsed, setCollapsed] = useState<CollapseMap>({});
  const toggle = (key: string) =>
    setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  if (!query.trim()) return null;

  const gridCls = cols === 4 ? 'grid grid-cols-4 gap-1' : 'grid grid-cols-3 gap-1';

  // Sub-group vendor results by vendor key (`entry.v` - the manifest's
  // vendor namespace string, e.g. "aws" / "gcp") so the user can collapse
  // e.g. AWS separately from GCP. `groupBy` preserves insertion order.
  const vendorByPack = groupBy(
    vendor,
    (row) => row.entry.v,
    (row) => row.vendor,
  );

  return (
    <>
      <SectionDivider />
      <Section
        title="Icon packs"
        hint="Official, unmodifiable assets"
        count={vendor.length}
        empty={manifestReady ? 'no vendor matches' : 'loading…'}
        collapsed={!!collapsed.packs}
        onToggle={() => toggle('packs')}
      >
        {/* When a single pack matches, render flat - no point sub-grouping
         *  one bucket. When multiple packs match, render each pack as its
         *  own collapsible sub-section so the user can dismiss a noisy
         *  one (e.g. fold AWS away while scanning GCP). */}
        {vendorByPack.size <= 1 ? (
          <div className={gridCls}>
            {vendor.map(({ entry, vendor: v }) => (
              <IconResultCard
                key={entry.id}
                source="vendor"
                entry={entry}
                vendor={v}
                previewSvg={previewSvgs.get(entry.id)}
                onPick={onPick}
              />
            ))}
          </div>
        ) : (
          [...vendorByPack].map(([vendorKey, { meta: v, items }]) => {
            const subKey = `pack:${vendorKey}`;
            const isCollapsed = !!collapsed[subKey];
            return (
              <SubSection
                key={subKey}
                title={(v as ManifestVendor).name}
                count={items.length}
                collapsed={isCollapsed}
                onToggle={() => toggle(subKey)}
              >
                <div className={gridCls}>
                  {items.map(({ entry, vendor: vv }) => (
                    <IconResultCard
                      key={entry.id}
                      source="vendor"
                      entry={entry}
                      vendor={vv}
                      previewSvg={previewSvgs.get(entry.id)}
                      onPick={onPick}
                    />
                  ))}
                </div>
              </SubSection>
            );
          })
        )}
      </Section>
    </>
  );
}

/** Tiny ordered-map group-by. Returns Map<key, { meta, items[] }> keeping
 *  whichever `meta` was extracted from the first item with that key. */
function groupBy<T, M>(
  rows: T[],
  keyOf: (t: T) => string,
  metaOf: (t: T) => M,
): Map<string, { meta: M; items: T[] }> {
  const out = new Map<string, { meta: M; items: T[] }>();
  for (const r of rows) {
    const k = keyOf(r);
    let bucket = out.get(k);
    if (!bucket) {
      bucket = { meta: metaOf(r), items: [] };
      out.set(k, bucket);
    }
    bucket.items.push(r);
  }
  return out;
}


function Section({
  title,
  hint,
  count,
  children,
  empty,
  collapsed,
  onToggle,
}: {
  title: string;
  hint?: string;
  count: number;
  children: React.ReactNode;
  empty: string;
  /** When true the section header still renders but the body is hidden.
   *  Toggle is wired by the parent (which owns the per-section collapse
   *  map) - clicking the header flips it. */
  collapsed: boolean;
  onToggle: () => void;
}) {
  // Collapse only meaningful when there's content; an empty section with
  // its empty-state message stays expanded so the user can still see why
  // a search returned nothing.
  const collapsible = count > 0;
  return (
    <div className="px-[8px] pt-[6px] pb-[4px]">
      <button
        type="button"
        className="w-full flex items-baseline justify-between px-[2px] pb-[4px] text-left cursor-pointer hover:opacity-80 transition-opacity"
        onClick={() => collapsible && onToggle()}
        style={{ cursor: collapsible ? 'pointer' : 'default' }}
        title={
          collapsible
            ? collapsed
              ? `Expand ${title}`
              : `Collapse ${title}`
            : title
        }
      >
        <span className="text-[10px] font-mono text-fg-muted tracking-[0.04em] uppercase flex items-center gap-1">
          {collapsible && (
            <span
              aria-hidden
              className="inline-block transition-transform"
              style={{
                transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                fontSize: 9,
                lineHeight: 1,
              }}
            >
              ▾
            </span>
          )}
          {title}
        </span>
        <span className="text-[9px] font-mono text-fg-muted">
          {count > 0 ? count : ''}
        </span>
      </button>
      {hint && !collapsed && (
        <div className="text-[9px] text-fg-muted px-[2px] pb-[6px] leading-tight">
          {hint}
        </div>
      )}
      {!collapsed &&
        (count > 0 ? (
          <>{children}</>
        ) : (
          <div className="px-2 py-3 text-center text-fg-muted text-[10px] font-mono">
            {empty}
          </div>
        ))}
    </div>
  );
}

/** Per-source collapsible band inside a Section - used when one parent
 *  section's results span multiple vendors (e.g. "AWS" + "GCP" inside Icon
 *  packs). Visually quieter than Section: smaller caret, indented body. */
function SubSection({
  title,
  count,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="pt-[2px] pb-[2px]">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-baseline justify-between px-[6px] py-[3px] text-left rounded hover:bg-bg-emphasis transition-colors"
        title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
      >
        <span className="text-[10px] font-mono text-fg flex items-center gap-1">
          <span
            aria-hidden
            className="inline-block transition-transform"
            style={{
              transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
              fontSize: 9,
              lineHeight: 1,
            }}
          >
            ▾
          </span>
          {title}
        </span>
        <span className="text-[9px] font-mono text-fg-muted">{count}</span>
      </button>
      {!collapsed && <div className="px-[2px] pt-[3px]">{children}</div>}
    </div>
  );
}

function SectionDivider() {
  return <div className="border-t border-border my-[4px] mx-[10px]" />;
}

/** Lazy-loads vendor packs as new vendors surface, returns id → svg. */
function useVendorPreviews(
  rows: { entry: ManifestEntry; vendor: { name: string } }[],
): Map<string, string> {
  const [packs, setPacks] = useState<Map<string, VendorPack>>(new Map());
  const neededVendors = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) s.add(r.entry.v);
    return [...s];
  }, [rows]);

  useEffect(() => {
    let cancelled = false;
    for (const v of neededVendors) {
      if (packs.has(v)) continue;
      loadVendorPack(v)
        .then((pack) => {
          if (cancelled) return;
          setPacks((prev) => {
            const next = new Map(prev);
            next.set(v, pack);
            return next;
          });
        })
        .catch(() => {
          /* fall back to glyph preview */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [neededVendors.join('|')]);

  return useMemo(() => {
    const out = new Map<string, string>();
    for (const pack of packs.values()) {
      for (const icon of pack.icons) {
        out.set(icon.id, icon.svg);
      }
    }
    return out;
  }, [packs]);
}
