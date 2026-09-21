import { useRef } from 'react';
import type { Shape } from '@/store/types';
import { useEditor } from '@/store/editor';
import { calloutGeometry, dragCallout } from './geometry';
import { mirrorTransform } from '@/editor/canvas/projection';
export function CalloutHandles({ shape }: { shape: Shape }) {
  const selected = useEditor(
    (s) =>
      s.selectedIds.length === 1 &&
      s.selectedIds[0] === shape.id &&
      !s.readOnly,
  );
  const zoom = useEditor((s) => s.zoom);
  const dragging = useRef<{
    handle: 'tip' | 'base';
    shape: Shape;
    inverse: DOMMatrix;
  } | null>(null);
  if (!selected || shape.polygonPreset !== 'callout') return null;
  const g = calloutGeometry(shape, shape.callout);
  return (
    <g
      data-callout-handles="true"
      data-export-exclude="true"
      transform={mirrorTransform(shape)}
    >
      {(['tip', 'base'] as const).map((handle) => (
        <circle
          key={handle}
          data-callout-handle={handle}
          cx={g[handle][0]}
          cy={g[handle][1]}
          r={5 / zoom}
          fill="var(--paper)"
          stroke="#b7791f"
          strokeWidth={2 / zoom}
          style={{ cursor: 'crosshair', touchAction: 'none' }}
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const matrix = e.currentTarget.getScreenCTM();
            if (!matrix) return;
            dragging.current = {
              handle,
              shape: structuredClone(shape),
              inverse: matrix.inverse(),
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const drag = dragging.current;
            if (!drag) return;
            e.stopPropagation();
            const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(
              drag.inverse,
            );
            useEditor
              .getState()
              .updateShapeLive(
                shape.id,
                dragCallout(drag.shape, drag.handle, [p.x, p.y]),
              );
          }}
          onPointerUp={(e) => {
            if (!dragging.current) return;
            e.stopPropagation();
            dragging.current = null;
            e.currentTarget.releasePointerCapture(e.pointerId);
            useEditor.getState().commitHistory();
          }}
          onPointerCancel={(e) => {
            e.stopPropagation();
            dragging.current = null;
            useEditor.getState().cancelHistory();
          }}
        >
          <title>
            {handle === 'tip' ? 'Aim callout tail' : 'Move callout tail base'}
          </title>
        </circle>
      ))}
    </g>
  );
}
