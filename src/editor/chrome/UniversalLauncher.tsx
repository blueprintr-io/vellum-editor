/* Universal launcher (Cmd-K / Ctrl-K).
 *
 * Searches across:
 *   - Library shapes (built-in catalog + Personal)
 *   - Vendor icons (manifest)
 *   - Commands (editor actions: new diagram, save, toggle theme/layer/inspector,
 *     insert bare shapes, undo/redo, etc.)
 *
 * Picking a result:
 *   - Library shape → drop service tile at viewport centre
 *   - Vendor → resolve + drop icon at viewport centre
 *   - Bare shape ("insert rectangle") → drop at viewport centre
 *   - Command → run the action (no canvas insertion)
 *
 * Why drop at viewport centre rather than wire a "click-to-place insert
 * mode"? Insert-mode is a separate state machine that touches Canvas's
 * pointer pipeline, the cursor preview, and Esc cancellation. Drop-at-centre
 * gets 90% of the value with zero gesture-state surface. Users can still
 * drag the inserted shape immediately. Insert-mode can land later on top
 * of this scaffold without breaking it.
 *
 * Keyboard model:
 *   - Cmd/Ctrl-K toggles open. Wired in useKeybindings.
 *   - Esc closes.
 *   - ↑/↓ navigate, Enter picks. Mouse hover updates the active row.
 *   - Type to search. The search box is auto-focused on open.
 *
 * Layout: floats at the centre-top of the viewport, rounded-corner card
 * with a search input, then a scrollable list of grouped results. The
 * groups (Commands / Shapes / Vendor icons) are rendered in priority order
 * so the most direct action sits at the top of the visible results.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '@/store/editor';
import { handleNew } from '../files';
import { useIconSearch } from '@/icons/useIconSearch';
import { loadVendorPack } from '@/icons/manifest';
import type { VendorPack } from '@/icons/types';
import { isMonochromeSvg, recolorBlackToCurrent } from '@/icons/recolorable';
import { LIBRARIES } from './libraries';
import {
  insertBareShape,
  insertIconShape,
  insertLibraryShape,
} from '../insert';
import { I } from './icons';
import { handleCopyPng } from '../files';

/** A single picker row. The launcher renders the same component shape for
 *  every group; only the action + glyph differ. */
type Row =
  | {
      kind: 'command';
      id: string;
      label: string;
      hint?: string;
      run: () => void;
    }
  | {
      kind: 'library';
      id: string;
      label: string;
      glyph: string;
      libName: string;
      run: () => void;
    }
  | {
      kind: 'vendor';
      id: string;
      label: string;
      /** Manifest entry id ("vendorKey/slug") - joins to the resolved
       *  vendor-pack SVG map for the row preview. */
      iconId: string;
      /** Vendor-pack key - which pack JSON to lazy-load for the preview. */
      vendorKey: string;
      vendor: string;
      hint: string;
      run: () => Promise<void>;
    }
  | {
      kind: 'shape-kind';
      id: string;
      label: string;
      hint: string;
      run: () => void;
    };

/** Static command catalogue. Each entry's `run` reaches into the store via
 *  getState() so the closure doesn't capture stale state. The launcher's
 *  hook subscribes only to `cmdkOpen` so closing+reopening reflects whatever
 *  the diagram has become. */
function buildCommands(): Row[] {
  const e = useEditor.getState;
  return [
    {
      kind: 'command',
      id: 'cmd:new',
      label: 'New diagram',
      hint: 'clear canvas',
      run: () => handleNew(),
    },
    {
      kind: 'command',
      id: 'cmd:save',
      label: 'Save…',
      hint: 'save dialog',
      run: () => e().setSaveDialogOpen(true),
    },
    {
      kind: 'command',
      id: 'cmd:export-image',
      label: 'Export image…',
      hint: 'PNG · SVG · PDF…',
      run: () => e().setSaveDialogOpen(true, 'image'),
    },
    {
      kind: 'command',
      id: 'cmd:copy-png',
      label: 'Copy as PNG',
      hint: '⇧⌘C · to clipboard',
      run: () => void handleCopyPng({}),
    },
    {
      kind: 'command',
      id: 'cmd:undo',
      label: 'Undo',
      hint: '⌘Z',
      run: () => e().undo(),
    },
    {
      kind: 'command',
      id: 'cmd:redo',
      label: 'Redo',
      hint: '⌘⇧Z',
      run: () => e().redo(),
    },
    {
      kind: 'command',
      id: 'cmd:theme',
      label: 'Toggle theme (light / dark)',
      run: () => e().toggleTheme(),
    },
    {
      kind: 'command',
      id: 'cmd:layer-blueprint',
      label: 'Show Blueprint layer only',
      hint: 'layer mode',
      run: () => e().setLayerMode('blueprint'),
    },
    {
      kind: 'command',
      id: 'cmd:layer-notes',
      label: 'Show Notes layer only',
      hint: 'layer mode',
      run: () => e().setLayerMode('notes'),
    },
    {
      kind: 'command',
      id: 'cmd:layer-both',
      label: 'Show both layers',
      hint: 'layer mode',
      run: () => e().setLayerMode('both'),
    },
    // Draw target, not visibility - the toolbar toggle's twin. Kept as two
    // explicit entries rather than one "switch layer" so typing "notes" in
    // the launcher lands on the thing the user meant.
    {
      kind: 'command',
      id: 'cmd:draw-on-blueprint',
      label: 'Draw on Blueprint layer',
      hint: 'draw layer',
      run: () => e().setActiveLayer('blueprint'),
    },
    {
      kind: 'command',
      id: 'cmd:draw-on-notes',
      label: 'Draw on Notes layer',
      hint: 'draw layer',
      run: () => e().setActiveLayer('notes'),
    },
    {
      kind: 'command',
      id: 'cmd:inspector',
      label: 'Toggle inspector',
      run: () => e().toggleInspector(),
    },
    {
      kind: 'command',
      id: 'cmd:library',
      label: 'Toggle library panel',
      run: () => e().toggleLibraryPanel(),
    },
    {
      kind: 'command',
      id: 'cmd:tips',
      label: 'Toggle tips',
      run: () => {
        const cur = e().tipsEnabled;
        e().setTipsEnabled(!cur);
      },
    },
    {
      kind: 'command',
      id: 'cmd:tool-lock',
      label: 'Toggle tool-lock',
      hint: 'Q',
      run: () => e().toggleLock(),
    },
    {
      kind: 'command',
      id: 'cmd:fit',
      label: 'Fit to content',
      hint: 'F',
      run: () => {
        if (typeof window === 'undefined') return;
        e().fitToContent(window.innerWidth, window.innerHeight);
      },
    },
    {
      kind: 'command',
      id: 'cmd:reset-view',
      label: 'Reset view (1:1)',
      hint: '⌘0',
      run: () => e().resetView(),
    },
    {
      kind: 'command',
      id: 'cmd:group',
      label: 'Group selection',
      hint: '⌘G',
      run: () => e().groupSelection(),
    },
    {
      kind: 'command',
      id: 'cmd:ungroup',
      label: 'Ungroup',
      hint: '⌘⇧G',
      run: () => e().ungroupSelection(),
    },
    {
      kind: 'command',
      id: 'cmd:duplicate',
      label: 'Duplicate selection',
      hint: '⌘D',
      run: () => e().duplicateSelection(),
    },
    {
      kind: 'command',
      id: 'cmd:delete',
      label: 'Delete selection',
      hint: 'Del',
      run: () => e().deleteSelection(),
    },
    {
      kind: 'command',
      id: 'cmd:bring-front',
      label: 'Bring to front',
      run: () => e().bringToFront(),
    },
    {
      kind: 'command',
      id: 'cmd:send-back',
      label: 'Send to back',
      run: () => e().sendToBack(),
    },
  ];
}

/** "Insert <kind>" rows - drop a bare shape at viewport centre. Distinct
 *  from the toolbar tools (which are draw-on-canvas gestures); the launcher
 *  variant is a single-shot pick that doesn't shift the active tool. */
function buildShapeKinds(): Row[] {
  const kinds = [
    { id: 'rect', label: 'Insert rectangle' },
    { id: 'ellipse', label: 'Insert ellipse' },
    { id: 'diamond', label: 'Insert diamond' },
    { id: 'note', label: 'Insert sticky note' },
    { id: 'text', label: 'Insert text' },
    { id: 'table', label: 'Insert table' },
    { id: 'container', label: 'Insert container' },
  ] as const;
  return kinds.map((k) => ({
    kind: 'shape-kind',
    id: `shape:${k.id}`,
    label: k.label,
    hint: 'drops at view centre',
    run: () =>
      insertBareShape(
        k.id as Parameters<typeof insertBareShape>[0],
      ),
  }));
}

/** Naive substring match - same threshold the manifest scorer uses for
 *  contains-only hits, but applied here for commands + library shapes
 *  where a tiny exact-match table doesn't earn its keep. */
function matches(haystack: string, q: string): boolean {
  if (!q) return true;
  return haystack.toLowerCase().includes(q.toLowerCase());
}

export function UniversalLauncher() {
  const open = useEditor((s) => s.cmdkOpen);
  const setOpen = useEditor((s) => s.setCmdkOpen);
  const personal = useEditor((s) => s.personalLibrary);
  const theme = useEditor((s) => s.theme);
  const dark = theme === 'dark';

  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);

  // Reset active row + query whenever the launcher reopens - the user
  // starts fresh, not where they left off.
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      // Auto-focus needs a frame after mount so the contenteditable input
      // is in the DOM. requestAnimationFrame is sufficient; we don't need
      // the double-rAF dance the toast uses.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Manifest search runs unconditionally - the hook handles the empty-query
  // case and returns empty arrays.
  const iconSearch = useIconSearch(q);

  // Build the static rows once per render; cheap (sub-ms at our scale).
  const commands = useMemo(buildCommands, []);
  const shapeKinds = useMemo(buildShapeKinds, []);

  // Library shapes - built-in + Personal. Same source MoreShapesPopover uses.
  const libraryShapes = useMemo(() => {
    const all = [
      ...LIBRARIES.flatMap((l) => l.shapes.map((s) => ({ ...s, _libName: l.name }))),
      ...personal.map((p, i) => ({
        id: `personal-${i}`,
        label: p.label,
        glyph: p.glyph,
        _libName: 'Personal',
      })),
    ];
    return all;
  }, [personal]);

  // Filter every group against the query and merge into one ordered row list.
  // Order matters: commands sit on top so an "undo" / "save" query lands the
  // command above any shape that happens to share the substring. Within a
  // group order is whatever the source array emits.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const c of commands) {
      if (matches(c.label, q) || (c.kind === 'command' && matches(c.id, q))) {
        out.push(c);
      }
    }
    for (const k of shapeKinds) {
      if (matches(k.label, q)) out.push(k);
    }
    for (const s of libraryShapes) {
      if (matches(s.label, q)) {
        out.push({
          kind: 'library',
          id: `lib:${s._libName}:${s.id}`,
          label: s.label,
          glyph: s.glyph,
          libName: s._libName,
          run: () =>
            insertLibraryShape({
              id: s.id,
              label: s.label,
              glyph: s.glyph,
              libName: s._libName,
            }),
        });
      }
    }
    // Vendor results only when there's a query - empty-state would otherwise
    // dump the catalog into the list.
    if (q.trim()) {
      for (const v of iconSearch.vendor.slice(0, 16)) {
        out.push({
          kind: 'vendor',
          id: `vendor:${v.entry.id}`,
          label: v.entry.n,
          iconId: v.entry.id,
          vendorKey: v.entry.v,
          vendor: v.vendor.name,
          hint: v.vendor.name,
          run: () =>
            insertIconShape({
              source: 'vendor',
              iconId: v.entry.id,
              vendor: v.entry.v,
            }),
        });
      }
    }
    return out;
  }, [commands, shapeKinds, libraryShapes, iconSearch.vendor, q]);

  // Lazy-load the vendor packs that any current vendor row needs, so the
  // launcher row can render an actual SVG preview instead of just the "icon"
  // tag chip. Same shape as IconSearchResults' useVendorPreviews - kept
  // local so the launcher stays a single file (no cross-component coupling
  // for a 30-line hook).
  const previewSvgs = useVendorPreviews(rows);

  // Clamp the active index when rows change so we never point past the end.
  useEffect(() => {
    if (active >= rows.length) setActive(0);
  }, [rows.length, active]);

  // Keep the active row scrolled into view - without this, ↓ past the
  // visible window would silently leave the highlight off-screen.
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const pick = (row: Row | undefined) => {
    if (!row) return;
    // Close FIRST so the focus-restore handlers (if any) don't clobber the
    // shape selection that the inserter sets. Then run the row's action.
    // Async actions (icon resolve) are fire-and-forget - the launcher can't
    // surface a spinner without complicating the close model, and a failed
    // resolve already logs to console.error.
    setOpen(false);
    const result = row.run();
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch((err) =>
        console.warn('[launcher] action failed', err),
      );
    }
  };

  return (
    <div
      className="absolute inset-0 z-[60] flex items-start justify-center pt-[6vh] sm:pt-[14vh] px-3"
      onPointerDown={(e) => {
        // Click on the backdrop closes; clicks on the card stop propagation
        // below so they don't reach this handler.
        if (e.target === e.currentTarget) setOpen(false);
      }}
      style={{
        background: 'rgba(0, 0, 0, 0.18)',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        className="float w-[min(520px,100%)] max-h-[70vh] sm:max-h-[60vh] flex flex-col overflow-hidden"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="relative px-[10px] pt-[10px] pb-[8px] border-b border-border">
          <span className="absolute left-[20px] top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none mt-px">
            <I.search />
          </span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setOpen(false);
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(rows.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                pick(rows[active]);
              }
            }}
            placeholder="Search shapes, icons, commands…"
            className="w-full pl-[30px] pr-[10px] py-[8px] bg-bg-subtle border border-border rounded-md text-fg text-[13px] font-body placeholder:text-fg-muted outline-none focus:border-accent/60"
          />
        </div>
        <div ref={listRef} className="overflow-y-auto py-1">
          {rows.length === 0 ? (
            <div className="px-3 py-6 text-center text-fg-muted text-[11px] font-mono">
              {q.trim() ? 'no matches' : 'start typing…'}
            </div>
          ) : (
            rows.map((r, i) => (
              <LauncherRow
                key={r.id}
                row={r}
                active={i === active}
                onHover={() => setActive(i)}
                onPick={() => pick(r)}
                rowRef={i === active ? activeRowRef : undefined}
                previewSvg={
                  r.kind === 'vendor' ? previewSvgs.get(r.iconId) : undefined
                }
                dark={dark}
              />
            ))
          )}
        </div>
        <div className="border-t border-border px-3 py-[6px] flex items-center justify-between text-[9px] font-mono text-fg-muted tracking-[0.04em]">
          <span>
            <span className="kbd">↑↓</span>{' '}
            <span className="kbd">⏎</span> to pick
          </span>
          <span>
            <span className="kbd">Esc</span> to close
          </span>
        </div>
      </div>
    </div>
  );
}

function LauncherRow({
  row,
  active,
  onHover,
  onPick,
  rowRef,
  previewSvg,
  dark,
}: {
  row: Row;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
  // MutableRefObject (not RefObject) so React 18's invariant ref types
  // accept the parent's nullable activeRowRef.current.
  rowRef?: React.MutableRefObject<HTMLDivElement | null>;
  /** Resolved vendor SVG for this row's iconId - only populated for
   *  vendor rows whose pack has finished loading. */
  previewSvg?: string;
  /** Theme flag for icon-tile recolouring (matches IconResultCard). */
  dark: boolean;
}) {
  // Group label + a small glyph chip on the left so the user can tell at a
  // glance whether this row is a command, a shape, or an icon.
  const groupChip = (() => {
    switch (row.kind) {
      case 'command':
        return { tag: 'cmd', tone: 'var(--accent)' };
      case 'shape-kind':
        return { tag: 'shape', tone: 'var(--accent)' };
      case 'library':
        return { tag: 'lib', tone: 'var(--ink-muted)' };
      case 'vendor':
        return { tag: 'icon', tone: 'var(--accent)' };
    }
  })();
  const hint = (() => {
    if (row.kind === 'command') return row.hint;
    if (row.kind === 'shape-kind') return row.hint;
    if (row.kind === 'library') return row.libName;
    return row.hint;
  })();
  return (
    <div
      ref={rowRef}
      onPointerEnter={onHover}
      onPointerDown={onPick}
      className="flex items-center gap-2 px-3 py-[6px] cursor-pointer"
      style={{
        background: active ? 'var(--bg-emphasis)' : 'transparent',
      }}
    >
      <RowPreview row={row} previewSvg={previewSvg} dark={dark} />
      <span
        className="font-mono text-[8px] uppercase tracking-[0.06em] px-[5px] py-[1px] rounded-[3px]"
        style={{
          color: groupChip.tone,
          background: 'var(--bg-subtle)',
          border: '1px solid var(--border)',
          minWidth: 36,
          textAlign: 'center',
        }}
      >
        {groupChip.tag}
      </span>
      <span className="text-[12px] text-fg flex-1 truncate">{row.label}</span>
      {hint && (
        <span className="text-[10px] font-mono text-fg-muted truncate max-w-[120px]">
          {hint}
        </span>
      )}
    </div>
  );
}

/** Per-row 22×22 preview frame. We render:
 *
 *    - library  → the 3-letter glyph the LibraryShapeTile shows
 *    - vendor   → the resolved pack SVG (mono-recoloured in dark mode so
 *                  black-on-black logos don't disappear)
 *    - command / shape-kind → render nothing (they already have descriptive
 *                  labels; an empty frame would just be visual noise) */
function RowPreview({
  row,
  previewSvg,
  dark,
}: {
  row: Row;
  previewSvg?: string;
  dark: boolean;
}) {
  if (row.kind === 'command' || row.kind === 'shape-kind') return null;

  const frameStyle =
    'w-[22px] h-[22px] shrink-0 rounded-[3px] bg-bg-subtle border border-border flex items-center justify-center overflow-hidden';

  if (row.kind === 'library') {
    return (
      <div className={frameStyle}>
        <span className="font-mono text-[8px] font-bold text-accent">
          {row.glyph}
        </span>
      </div>
    );
  }

  // row.kind === 'vendor'
  const rendered =
    previewSvg && dark && isMonochromeSvg(previewSvg)
      ? recolorBlackToCurrent(previewSvg)
      : previewSvg;
  return (
    <div className={frameStyle}>
      {rendered ? (
        <span
          className="block w-[16px] h-[16px] [&>svg]:w-full [&>svg]:h-full"
          style={{ color: 'var(--fg)' }}
          // Pack SVGs are sanitized at build time before reaching here.
          dangerouslySetInnerHTML={{ __html: rendered }}
        />
      ) : (
        // Pack still loading - show first letter of vendor name as a
        // placeholder so the row isn't blank during the fetch.
        <span className="font-mono text-[8px] font-bold text-accent">
          {row.vendor.slice(0, 1)}
        </span>
      )}
    </div>
  );
}

/** Lazy-loads vendor packs as new vendor rows surface; returns iconId →
 *  resolved SVG. Mirrors IconSearchResults' hook of the same name - kept
 *  local because the launcher's row list mixes types, so the input shape
 *  differs (Row[] instead of vendor-only rows). */
function useVendorPreviews(rows: Row[]): Map<string, string> {
  const [packs, setPacks] = useState<Map<string, VendorPack>>(new Map());

  // Set of vendor-pack keys that any current row needs. Recomputed only
  // when the row list changes - `neededVendors.join('|')` below is the
  // effect dep so we don't refetch on every keystroke that doesn't change
  // the vendor set.
  const neededVendors = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.kind === 'vendor') s.add(r.vendorKey);
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
          // Pack-load failure is non-fatal - the row falls back to the
          // vendor-letter placeholder.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [neededVendors.join('|')]);

  return useMemo(() => {
    const out = new Map<string, string>();
    for (const pack of packs.values()) {
      for (const icon of pack.icons) out.set(icon.id, icon.svg);
    }
    return out;
  }, [packs]);
}
