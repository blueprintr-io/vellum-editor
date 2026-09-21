/* Mini icon-search flyout for the container "+" affordance.
 *
 * Click the "+" on an empty selected container → this flyout opens anchored
 * to the click point, the user types/picks an icon, and we attach the icon
 * as the container's anchored child in one history step.
 *
 * Also drives the inspector's "Change icon" button for standalone icon
 * shapes (target.kind === 'icon') - there the picked glyph replaces the
 * selected icon in place rather than attaching to a container.
 *
 * Two design notes:
 *
 * 1. Click-to-pick semantics. The general icon library (LibraryPanel,
 *    MoreShapesPopover, IconSearchResults / IconResultCard) is drag-and-drop
 *    only - that's the right default for free placement on the canvas. But
 *    inside a container, the destination is unambiguous: the icon goes in
 *    THIS container. Drag would be busywork; click is the natural verb.
 *
 * 2. Portal + fixed positioning. Shape is inside the canvas SVG, where
 *    we can't render HTML chrome. The flyout portals to document.body and
 *    positions itself in screen-space at the click coords (clamped to the
 *    viewport so it never spills off-screen). */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditor, newId } from '@/store/editor';
import { resolveIcon } from '@/icons/resolve';
import type { IconDragPayload } from '@/icons/types';
import type { Shape } from '@/store/types';
import { I } from '../icons';
import { IconSearchResults } from './IconSearchResults';

const FLYOUT_W = 300;
const FLYOUT_H = 360;
const VIEWPORT_PAD = 8;

/** What the picked icon attaches to:
 *   - `container` → add a new anchor icon, or swap the existing one
 *   - `icon`      → replace a standalone icon shape's glyph in place */
export type IconFlyoutTarget =
  | { kind: 'container'; containerId: string }
  | { kind: 'icon'; iconShapeId: string }
  | { kind: 'rack-unit'; unitId: string };

type Props = {
  target: IconFlyoutTarget;
  /** Anchor point in screen coords (clientX/clientY of the "+" click). */
  anchor: { x: number; y: number };
  onClose: () => void;
};

export function ContainerIconFlyout({ target, anchor, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Outside-click + Escape to close. Defer attaching by a tick so the click
  // that opened us doesn't immediately close us via outside-click on its own
  // bubble path.
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

  // Clamp the flyout into the viewport. We anchor below+right of the click
  // point by default; if that runs off-screen, flip to the opposite side.
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
      // Not enough room below - flip above the anchor.
      top = Math.max(VIEWPORT_PAD, anchor.y - FLYOUT_H - 12);
    }
    return { left, top };
  }, [anchor]);

  const pick = async (payload: IconDragPayload, label: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const resolved = await resolveIcon(payload);
      const state = useEditor.getState();

      // Standalone icon shape (selected in the inspector → "Change icon").
      // Same replace-in-place contract as the container anchor swap below:
      // the shape id, geometry, and connector bindings stay put - only the
      // SVG + attribution + constraints change. No recordRecent here: the
      // user is iterating on one glyph, not adopting a new icon onto the
      // canvas, so the Recent feed shouldn't fill with every swap.
      if (target.kind === 'icon' || target.kind === 'rack-unit') {
        const existing = state.diagram.shapes.find(
          (s) => s.id === (target.kind === 'icon' ? target.iconShapeId : target.unitId),
        );
        if (!existing || (target.kind === 'icon' ? existing.kind !== 'icon' : !existing.rackUnit)) {
          throw new Error('Icon missing - was it deleted?');
        }
        // The tint (and any `iconRecolor` mode) rides through the swap
        // untouched. It used to be wiped when the incoming icon was
        // vendor-locked; every icon is recolourable now, so dropping the
        // user's colour on an AWS→AWS swap would just be losing their work.
        state.updateShape(existing.id, {
          ...(target.kind === 'rack-unit' && existing.label === `U${existing.rackUnit?.u}` ? {label} : {}),
          iconSvg: resolved.svg,
          iconAttribution: resolved.attribution,
          iconConstraints: resolved.constraints,
        });
        onClose();
        setBusy(false);
        return;
      }

      const container = state.diagram.shapes.find(
        (s) => s.id === target.containerId,
      );
      if (!container) {
        throw new Error('Container missing - was it deleted?');
      }

      // Two paths: REPLACE if the container already has an anchor icon
      // (this is the double-click-the-icon flow), ADD otherwise (the +
      // affordance on an empty container). Replace-in-place preserves
      // the existing icon's id, position, size, and any per-shape
      // overrides the user has set - only the iconSvg + attribution +
      // constraints change. That keeps connectors bound to the icon
      // intact and avoids re-laying-out the container's interior just
      // because the user wanted to swap the glyph.
      if (container.anchorId) {
        const existing = state.diagram.shapes.find(
          (s) => s.id === container.anchorId,
        );
        if (existing && existing.kind === 'icon') {
          // Tint and recolour mode survive the swap - see the icon-target
          // path above for why the old vendor-lock wipe is gone.
          state.updateShape(existing.id, {
            iconSvg: resolved.svg,
            iconAttribution: resolved.attribution,
            iconConstraints: resolved.constraints,
          });
          // Skip the recordRecent at the bottom of `pick` for replace -
          // the user is iterating on a single container, not adopting
          // a new icon onto the canvas, so polluting the Recent feed
          // with every iteration would be noise.
          onClose();
          setBusy(false);
          return;
        }
        // Anchor pointed at something we can't repaint (deleted, or a
        // non-icon shape). Fall through to ADD so the user gets a
        // working result instead of a silent no-op.
      }

      // Match `makeContainer` (in store/editor.ts) so the visual result of
      // "+ icon → flyout" is identical to "icon already on canvas →
      // wrapped in a container":
      //   - 40×40 anchor size for icons (ANCHOR_ICON_SIZE)
      //   - 12px padding from the container's top-left corner (PAD)
      const ANCHOR_ICON_SIZE = 40;
      const PAD = 12;
      const iconShape: Shape = {
        id: newId('icon'),
        kind: 'icon',
        x: container.x + PAD,
        y: container.y + PAD,
        w: ANCHOR_ICON_SIZE,
        h: ANCHOR_ICON_SIZE,
        layer: container.layer,
        parent: target.containerId,
        iconSvg: resolved.svg,
        iconAttribution: resolved.attribution,
        iconConstraints: resolved.constraints,
      };
      // Two store writes, one user action - bracket them so Cmd+Z removes
      // the icon AND its anchor pin together instead of in two presses.
      state.beginHistoryBatch();
      state.addShape(iconShape);
      // Pin the new icon as the container's anchor - this is what controls
      // label positioning and tells `containerAddIcon` to disappear, so the
      // user sees the "+" replaced with their chosen icon immediately.
      state.updateShape(target.containerId, { anchorId: iconShape.id });
      state.endHistoryBatch();
      // Stamp the Recent feed so the icon shows up in the user's recent tab.
      const tail = payload.iconId.split('/').pop() ?? payload.iconId;
      state.recordRecent({
        key: `vendor:${payload.iconId}`,
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
      onPointerDown={(e) => {
        // Don't let pointer events bubble up to the canvas - without this
        // the canvas treats the flyout interaction as a marquee start and
        // clears the container's selection out from under us.
        e.stopPropagation();
      }}
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
      <div className="flex-1 overflow-y-auto">
        {query.trim() ? (
          // Unified picker - same component the LibraryPanel /
          // MoreShapesPopover search bar drives. Click-pick mode is engaged
          // via `onPick`, so tiles attach to the container instead of
          // becoming drag sources.
          <IconSearchResults query={query} cols={4} onPick={busy ? noopPick : pick} />
        ) : (
          <div className="px-2 py-6 text-center text-fg-muted text-[11px] leading-relaxed">
            Type to search icons.
            <br />
            <span className="text-[10px]">
              {target.kind === 'icon'
                ? 'Picked icon replaces the selected one in place.'
                : target.kind === 'rack-unit' ? 'Picked icon belongs to this rack unit.' : 'Picked icon attaches to this container.'}
            </span>
          </div>
        )}
      </div>
      {error && (
        <div className="px-[10px] py-[6px] border-t border-sketch/40 bg-bg-subtle text-[11px] text-fg leading-snug">
          {error}
        </div>
      )}
    </div>,
    document.body,
  );
}

/** Click-pick callback shape that ignores the click while `busy` is true.
 *  Stable identity per render keeps IconResultCard's click handlers from
 *  re-binding unnecessarily. */
const noopPick = () => {};
