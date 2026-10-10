import { useEffect, useMemo } from 'react';
import { useEditor } from '@/store/editor';
import { arrangePreviewDestinations, arrangePreviewMatchesSelection, useArrangePreview } from '@/editor/arrange-preview';
import { shapeRotation } from './projection';

/** A paint-only layer inside the canvas's existing pan/zoom transform.
 * The real diagram stays in place until the user applies the arrangement. */
export function ArrangePreview() {
  const preview = useArrangePreview((state) => state.preview);
  const setPreview = useArrangePreview((state) => state.setPreview);
  const shapes = useEditor((state) => state.diagram.shapes);
  const connectors = useEditor((state) => state.diagram.connectors);
  const selectedIds = useEditor((state) => state.selectedIds);
  const layerMode = useEditor((state) => state.layerMode);
  const readOnly = useEditor((state) => state.readOnly);
  const zoom = useEditor((state) => state.zoom);
  const valid = !!preview && !readOnly && arrangePreviewMatchesSelection(preview, selectedIds);
  const destinations = useMemo(
    () => valid && preview ? arrangePreviewDestinations(preview, shapes, connectors, layerMode) : [],
    [valid, preview, shapes, connectors, layerMode],
  );

  useEffect(() => {
    if (preview && (!valid || destinations.length === 0)) setPreview(null);
  }, [preview, valid, destinations.length, setPreview]);

  useEffect(() => {
    if (!preview) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-arrange-controls]')) setPreview(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setPreview(null);
      // The gap field also needs this Escape to revert its uncommitted draft.
      if (event.target instanceof HTMLInputElement && event.target.closest('[data-arrange-controls]')) return;
      // Dismissing a preview should not also deselect the objects behind it.
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [preview, setPreview]);

  useEffect(() => () => setPreview(null), [setPreview]);
  if (!valid || destinations.length === 0) return null;

  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const screenPixel = 1 / safeZoom;
  const bounds = destinations.map(({ after }) => {
    const angle = shapeRotation(after) * Math.PI / 180;
    const width = Math.abs(Math.cos(angle)) * after.w + Math.abs(Math.sin(angle)) * after.h;
    const height = Math.abs(Math.sin(angle)) * after.w + Math.abs(Math.cos(angle)) * after.h;
    return { x: after.x + (after.w - width) / 2, y: after.y + (after.h - height) / 2 };
  });
  const left = Math.min(...bounds.map((box) => box.x));
  const top = Math.min(...bounds.map((box) => box.y));

  return <g data-testid="arrange-preview" data-export-exclude="" pointerEvents="none" aria-hidden="true">
    {destinations.map(({ before, after }) => {
      const x1 = before.x + before.w / 2;
      const y1 = before.y + before.h / 2;
      const x2 = after.x + after.w / 2;
      const y2 = after.y + after.h / 2;
      if (Math.hypot(x2 - x1, y2 - y1) * safeZoom < 12) return null;
      return <line key={`travel-${before.id}`} data-arrange-preview-travel={before.id}
        x1={x1} y1={y1} x2={x2} y2={y2}
        stroke="var(--accent)" strokeWidth={screenPixel} strokeOpacity={0.38}
        strokeDasharray={`${2 * screenPixel} ${4 * screenPixel}`} />;
    })}
    {destinations.map(({ after }) => {
      const rotation = shapeRotation(after);
      return <g key={after.id} transform={rotation ? `rotate(${rotation} ${after.x + after.w / 2} ${after.y + after.h / 2})` : undefined}>
        <rect data-arrange-preview-shape={after.id}
          x={after.x} y={after.y} width={after.w} height={after.h}
          rx={Math.min(4 * screenPixel, after.w / 2, after.h / 2)}
          fill="var(--accent)" fillOpacity={0.055}
          stroke="var(--accent)" strokeOpacity={0.9} strokeWidth={1.5 * screenPixel}
          strokeDasharray={`${6 * screenPixel} ${4 * screenPixel}`} />
      </g>;
    })}
    <g transform={`translate(${left} ${top - 26 * screenPixel}) scale(${screenPixel})`}>
      <rect width={66} height={20} rx={5} fill="var(--paper)" fillOpacity={0.95} stroke="var(--accent)" strokeOpacity={0.5} />
      <text x={33} y={13.5} textAnchor="middle" fill="var(--accent)" fontFamily="var(--font-body)" fontSize={11}>Preview</text>
    </g>
  </g>;
}
