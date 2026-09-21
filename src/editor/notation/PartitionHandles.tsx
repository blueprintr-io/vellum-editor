import { useRef } from 'react';
import type { Shape } from '@/store/types';
import { useEditor } from '@/store/editor';
import {
  partitionHandles,
  dragPartition,
  type PartitionKey,
} from './partitions';
import { mirrorTransform } from '@/editor/canvas/projection';
export function PartitionHandles({ shape }: { shape: Shape }) {
  const selected = useEditor(
    (s) =>
      s.selectedIds.length === 1 &&
      s.selectedIds[0] === shape.id &&
      !s.readOnly,
  );
  const zoom = useEditor((s) => s.zoom);
  const dragging = useRef<{
    handle: PartitionKey;
    shape: Shape;
    inverse: DOMMatrix;
  } | null>(null);
  const handles = partitionHandles(shape);
  if (!selected || !handles.length) return null;
  return (
    <g
      data-partition-handles="true"
      data-export-exclude="true"
      transform={mirrorTransform(shape)}
    >
      {handles.map(({ key: handle, x, y, label }) => (
        <circle
          key={handle}
          data-partition-handle={handle}
          cx={x}
          cy={y}
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
                dragPartition(drag.shape, drag.handle, p.x, p.y),
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
          <title>{label}</title>
        </circle>
      ))}
    </g>
  );
}
