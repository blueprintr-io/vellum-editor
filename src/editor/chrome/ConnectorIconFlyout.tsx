/* Target picker for the SelectionToolbar's "-->[]" button. Lets the user
 * pick either a basic shape (rect / ellipse / diamond / container / text)
 * or an icon from the library; we create that shape adjacent to the
 * source and a connector binding source.right → new.left as a single
 * history step.
 *
 * Portals to body and stops pointerdown so the canvas doesn't see the
 * picker interaction as a marquee start. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditor, newId } from '@/store/editor';
import { resolveIcon } from '@/icons/resolve';
import { useManifest } from '@/icons/manifest';
import type { IconDragPayload } from '@/icons/types';
import type { Connector, Shape, ShapeKind } from '@/store/types';
import { I } from './icons';
import { IconSearchResults } from './icons/IconSearchResults';
import { PackIconGrid } from './icons/PackIconGrid';

type BasicChoice = {
  kind: Extract<ShapeKind, 'rect' | 'ellipse' | 'diamond' | 'container' | 'text'>;
  label: string;
  w: number;
  h: number;
  Icon: () => React.ReactNode;
};

const BASIC_SHAPES: BasicChoice[] = [
  { kind: 'rect', label: 'Rectangle', w: 140, h: 80, Icon: I.rect },
  { kind: 'ellipse', label: 'Ellipse', w: 120, h: 100, Icon: I.ellipse },
  { kind: 'diamond', label: 'Diamond', w: 120, h: 100, Icon: I.diamond },
  { kind: 'container', label: 'Container', w: 200, h: 140, Icon: I.container },
  { kind: 'text', label: 'Text', w: 140, h: 32, Icon: I.text },
];

const FLYOUT_W = 300;
const FLYOUT_H = 360;
const VIEWPORT_PAD = 8;
/** Horizontal gap between the source shape's right edge and the new icon's
 *  left edge. */
const GAP = 80;

type Props = {
  sourceId: string;
  /** Anchor in screen coords - the toolbar button's position. */
  anchor: { x: number; y: number };
  onClose: () => void;
};

export function ConnectorIconFlyout({ sourceId, anchor, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const src = useEditor((s) =>
    s.diagram.shapes.find((sh) => sh.id === sourceId),
  );
  const manifest = useManifest();

  // The vendor pack the source icon came from. When set, the no-query view
  // opens straight into that pack ("give me another one of these") instead
  // of the generic basic-shapes + search prompt. Vendor icon ids are
  // `<vendorKey>/<slug>`; the key joins back to `manifest.vendors`.
  const sourcePack = useMemo(() => {
    const attr = src?.kind === 'icon' ? src.iconAttribution : undefined;
    if (!attr || attr.source !== 'vendor') return null;
    const slash = attr.iconId.indexOf('/');
    if (slash <= 0) return null;
    const key = attr.iconId.slice(0, slash);
    const vendor = manifest?.vendors[key];
    return vendor ? { key, vendor } : null;
  }, [src, manifest]);

  // Source is a bundled vendor icon but the manifest (so the pack's display
  // name) hasn't resolved yet - hold on a spinner rather than flashing the
  // basic-shapes grid for a frame before swapping to the pack.
  const packPending =
    !sourcePack &&
    src?.kind === 'icon' &&
    src.iconAttribution?.source === 'vendor' &&
    (src.iconAttribution?.iconId.indexOf('/') ?? -1) > 0 &&
    !manifest;

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const position = useMemo(() => {
    if (typeof window === 'undefined') return { left: anchor.x, top: anchor.y };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.x;
    let top = anchor.y + 12;
    if (left + FLYOUT_W + VIEWPORT_PAD > vw) {
      left = Math.max(VIEWPORT_PAD, vw - FLYOUT_W - VIEWPORT_PAD);
    }
    if (top + FLYOUT_H + VIEWPORT_PAD > vh) {
      top = Math.max(VIEWPORT_PAD, anchor.y - FLYOUT_H - 12);
    }
    return { left, top };
  }, [anchor]);

  /** Commit a new shape + its connector to the source as one history step.
   *  addShape snapshots on entry; the connector is appended inside the same
   *  setState so undo rolls back the pair. */
  const commitShapeAndConnector = (shape: Shape, connector: Connector) => {
    const state = useEditor.getState();
    state.addShape(shape);
    useEditor.setState((s) => ({
      diagram: {
        ...s.diagram,
        connectors: [...s.diagram.connectors, connector],
      },
      dirty: true,
    }));
    state.commitHistory();
  };

  const pickBasic = (choice: BasicChoice) => {
    const state = useEditor.getState();
    const src = state.diagram.shapes.find((s) => s.id === sourceId);
    if (!src) return;
    const shape: Shape = {
      id: newId(choice.kind),
      kind: choice.kind,
      x: src.x + src.w + GAP,
      y: src.y + src.h / 2 - choice.h / 2,
      w: choice.w,
      h: choice.h,
      layer: src.layer,
    };
    const connector: Connector = {
      id: newId('c'),
      from: { shape: sourceId, anchor: 'right' },
      to: { shape: shape.id, anchor: 'left' },
      layer: src.layer,
      routing: 'orthogonal',
      fromMarker: 'none',
      toMarker: 'arrow',
      ...state.lastConnectorStyle,
    };
    commitShapeAndConnector(shape, connector);
    onClose();
  };

  const pick = async (payload: IconDragPayload, label: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const resolved = await resolveIcon(payload);
      const { w, h } = resolved.defaultSize;
      const state = useEditor.getState();
      const src = state.diagram.shapes.find((s) => s.id === sourceId);
      if (!src) throw new Error('Source shape missing - was it deleted?');
      const shape: Shape = {
        id: newId('icon'),
        kind: 'icon',
        x: src.x + src.w + GAP,
        y: src.y + src.h / 2 - h / 2,
        w,
        h,
        layer: src.layer,
        iconSvg: resolved.svg,
        iconAttribution: resolved.attribution,
        iconConstraints: resolved.constraints,
      };
      const connector: Connector = {
        id: newId('c'),
        from: { shape: sourceId, anchor: 'right' },
        to: { shape: shape.id, anchor: 'left' },
        layer: src.layer,
        routing: 'orthogonal',
        fromMarker: 'none',
        toMarker: 'arrow',
        ...state.lastConnectorStyle,
      };
      commitShapeAndConnector(shape, connector);
      // Vendor-only payload in core; the manifest's iconify subsystem is
      // dormant (no write path produces `source: 'iconify'` today). When
      // an iconify build lands it can re-introduce the branch here.
      const tail = payload.iconId.split(/[:\/]/).pop() ?? payload.iconId;
      useEditor.getState().recordRecent({
        key: `${payload.source}:${payload.iconId}`,
        label: label || tail,
        glyph: tail.slice(0, 3).toUpperCase(),
        source: { kind: 'vendor', iconId: payload.iconId, vendor: payload.vendor },
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load icon.');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      ref={wrapRef}
      className="float fixed z-[60] flex flex-col overflow-hidden"
      style={{
        left: position.left,
        top: position.top,
        width: FLYOUT_W,
        maxHeight: FLYOUT_H,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="relative px-[10px] pt-[10px] pb-[8px] border-b border-border">
        <span className="absolute left-[20px] top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none mt-px">
          <I.search />
        </span>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="Search icons (aws, kubernetes…)"
          className="w-full pl-[30px] pr-[10px] py-[7px] bg-bg-subtle border border-border rounded-md text-fg text-[12px] font-body placeholder:text-fg-muted outline-none focus:border-accent/60"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-[10px]">
        {!query.trim() && sourcePack && (
          <>
            <div className="text-[10px] font-mono text-fg-muted tracking-[0.04em] uppercase mb-[6px]">
              {sourcePack.vendor.name}
            </div>
            <PackIconGrid
              vendorKey={sourcePack.key}
              vendor={sourcePack.vendor}
              cols={4}
              onPick={busy ? () => {} : pick}
            />
          </>
        )}
        {!query.trim() && !sourcePack && packPending && (
          <div className="px-2 py-6 text-center text-fg-muted text-[11px] font-mono">
            loading…
          </div>
        )}
        {!query.trim() && !sourcePack && !packPending && (
          <>
            <div className="text-[10px] font-mono text-fg-muted tracking-[0.04em] uppercase mb-[6px]">
              Basic shapes
            </div>
            <div className="grid grid-cols-5 gap-1">
              {BASIC_SHAPES.map((c) => (
                <button
                  key={c.kind}
                  type="button"
                  onClick={() => pickBasic(c)}
                  title={c.label}
                  className="flex flex-col items-center gap-[4px] py-[6px] px-1 bg-transparent border border-transparent rounded-md text-fg-muted hover:bg-bg-emphasis hover:border-border hover:text-fg transition-colors duration-100"
                >
                  <span className="w-8 h-8 rounded-md bg-bg-subtle border border-border flex items-center justify-center text-accent">
                    {c.Icon()}
                  </span>
                  <span className="text-[9px] leading-[1.1] text-center">
                    {c.label}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        {query.trim() && (
          <IconSearchResults
            query={query}
            cols={4}
            onPick={busy ? () => {} : pick}
          />
        )}
      </div>
      {error && (
        <div className="px-3 py-2 border-t border-border text-[11px] text-red-600">
          {error}
        </div>
      )}
    </div>,
    document.body,
  );
}
