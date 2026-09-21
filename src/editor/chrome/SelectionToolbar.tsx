/* Floating HTML toolbar that hovers above a single-shape selection. Two
 * buttons, no intermediate "Connect" step:
 *   - "-->"   start a click-to-commit connector from the selected shape
 *   - "-->[]" open an icon picker; choosing an icon creates it adjacent to
 *             the source with a connector binding the two
 *
 * Positioned in screen coords relative to the same `absolute inset-0`
 * wrapper the canvas mounts into (see Editor.tsx). World→screen is
 * `wx*zoom + pan.x` since `pan` is already in screen pixels. */

import { useEffect, useState } from 'react';
import { useEditor } from '@/store/editor';
import { ConnectorIconFlyout } from './ConnectorIconFlyout';

/** Distance in screen pixels from the shape's (un-rotated) top edge to the
 *  toolbar's CENTER. The toolbar is anchored using `translate(-50%, -50%)`,
 *  so this is half-toolbar-height + ~8px breathing room. */
const TOP_EDGE_GAP = 24;

type Props = {
  /** Kicks the canvas into click-to-commit connector mode from the given
   *  source shape. Defined in Canvas because it touches local interaction +
   *  preview state that isn't in the store. */
  onStartClickConnector: (sourceId: string) => void;
};

export function SelectionToolbar({ onStartClickConnector }: Props) {
  const readOnly = useEditor((s) => s.readOnly);
  const selectedIds = useEditor((s) => s.selectedIds);
  const shapes = useEditor((s) => s.diagram.shapes);
  const pan = useEditor((s) => s.pan);
  const zoom = useEditor((s) => s.zoom);

  const [flyoutAnchor, setFlyoutAnchor] = useState<
    { x: number; y: number } | null
  >(null);
  // Dismissal scoped to the current selection lifetime - clearing the
  // selection (or selecting a different shape) resets it so the toolbar
  // reappears on the next selection.
  const [dismissedForId, setDismissedForId] = useState<string | null>(null);
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  useEffect(() => {
    setDismissedForId(null);
  }, [selectedId]);

  if (readOnly || selectedIds.length !== 1) return null;
  const shape = shapes.find((s) => s.id === selectedIds[0]);
  if (!shape) return null;
  // Freehand strokes are a stroke envelope, not a body - connecting to one
  // would anchor on an arbitrary bbox edge that the user didn't draw. Groups
  // DO get the toolbar: connecting to a group attaches to its union bbox,
  // which is the natural target when you want a line to a cluster.
  if (shape.kind === 'freehand') return null;
  if (dismissedForId === shape.id) return null;

  // Position the toolbar relative to the shape's UN-ROTATED top edge, then
  // apply the shape's rotation around its center. That way the toolbar
  // always sits over the visually-top edge of the rotated shape, AND stays
  // 90° apart from the rotate handle (which is anchored to the un-rotated
  // left edge), so the two never collide regardless of rotation angle.
  const rotation = shape.rotation ?? 0;
  const rad = (rotation * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const cx = shape.x + shape.w / 2;
  const cy = shape.y + shape.h / 2;
  // Top-center offset (0, -h/2) in world, rotated around the shape center.
  const anchorWX = shape.rackUnit ? cx + (shape.w / 2) * cos : cx + (shape.h / 2) * sin;
  const anchorWY = shape.rackUnit ? cy + (shape.w / 2) * sin : cy - (shape.h / 2) * cos;
  const anchorSX = anchorWX * zoom + pan.x;
  const anchorSY = anchorWY * zoom + pan.y;
  // Outward normal of the rotated top edge in SCREEN coords. Scaled to
  // TOP_EDGE_GAP so the offset stays constant across zoom levels.
  const screenX = anchorSX + (shape.rackUnit ? cos * (TOP_EDGE_GAP + 24) : sin * TOP_EDGE_GAP);
  const screenY = anchorSY + (shape.rackUnit ? sin * (TOP_EDGE_GAP + 24) : -cos * TOP_EDGE_GAP);

  return (
    <>
      <div
        className="float absolute z-[18] flex items-center gap-[2px] p-[3px] pointer-events-auto"
        style={{
          left: screenX,
          top: screenY,
          transform: 'translate(-50%, -50%)',
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          title="Hide until next selection"
          onClick={() => setDismissedForId(shape.id)}
          className="absolute -top-[5px] -right-[5px] w-3 h-3 flex items-center justify-center rounded-full border border-border bg-bg text-fg-muted hover:text-fg hover:bg-bg-emphasis"
        >
          <svg width="6" height="6" viewBox="0 0 6 6" fill="none">
            <path
              d="M1 1l4 4M5 1l-4 4"
              stroke="currentColor"
              strokeWidth="1"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button
          type="button"
          title="Draw a connector - click a shape to bind"
          onClick={() => onStartClickConnector(shape.id)}
          className="w-8 h-8 flex items-center justify-center rounded-md border border-transparent bg-transparent text-fg hover:bg-bg-emphasis"
        >
          <ArrowGlyph />
        </button>
        <button
          type="button"
          title="Draw a connector to a new icon"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setFlyoutAnchor({ x: rect.left, y: rect.bottom });
          }}
          className="w-8 h-8 flex items-center justify-center rounded-md border border-transparent bg-transparent text-fg hover:bg-bg-emphasis"
        >
          <ArrowToBoxGlyph />
        </button>
      </div>
      {flyoutAnchor && (
        <ConnectorIconFlyout
          sourceId={shape.id}
          anchor={flyoutAnchor}
          onClose={() => setFlyoutAnchor(null)}
        />
      )}
    </>
  );
}

/** "-->" - plain rightward arrow, used for the bare-connector button. */
function ArrowGlyph() {
  return (
    <svg width="18" height="14" viewBox="0 0 18 14" fill="none">
      <path
        d="M2 7h12m0 0l-3-3m3 3l-3 3"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "-->[]" - arrow pointing into a small box, used for the connector-to-
 *  new-icon button. The box reads as the target node the connector will
 *  bind to. */
function ArrowToBoxGlyph() {
  return (
    <svg width="22" height="14" viewBox="0 0 22 14" fill="none">
      <path
        d="M2 7h9m0 0l-2-2m2 2l-2 2"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="13"
        y="3"
        width="7"
        height="8"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.25"
        fill="none"
      />
    </svg>
  );
}
