import { useEffect, useState } from 'react';
import { useEditor } from '@/store/editor';

/** Floating "return to content" button - pops in when the user has panned or
 *  zoomed so far that no shapes intersect the viewport, but shapes still
 *  exist. One click runs `fitToContent`, recentering the diagram in view.
 *
 *  We watch viewport size with a ResizeObserver on `window` (resize event),
 *  but the calculation - checking shape AABBs against the projected
 *  viewport - runs on every relevant store change. Cheap because shapes are
 *  just numbers. */
export function ReturnToContent() {
  const shapes = useEditor((s) => s.diagram.shapes);
  const pan = useEditor((s) => s.pan);
  const zoom = useEditor((s) => s.zoom);
  const fitToContent = useEditor((s) => s.fitToContent);

  const [vw, setVw] = useState(typeof window !== 'undefined' ? window.innerWidth : 1200);
  const [vh, setVh] = useState(typeof window !== 'undefined' ? window.innerHeight : 800);
  useEffect(() => {
    const onResize = () => {
      setVw(window.innerWidth);
      setVh(window.innerHeight);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (shapes.length === 0) return null;

  // Project the screen viewport into world coords.
  const wx1 = (0 - pan.x) / zoom;
  const wy1 = (0 - pan.y) / zoom;
  const wx2 = (vw - pan.x) / zoom;
  const wy2 = (vh - pan.y) / zoom;

  const anyVisible = shapes.some((s) => {
    const sx2 = s.x + s.w;
    const sy2 = s.y + s.h;
    return !(sx2 < wx1 || s.x > wx2 || sy2 < wy1 || s.y > wy2);
  });

  if (anyVisible) return null;

  return (
    <button
      onClick={() => fitToContent(vw, vh)}
      // Bottom-centre of the canvas - visible without colliding with the dock
      // or zoom controls. Accent-coloured so it reads as an action.
      className="absolute left-1/2 -translate-x-1/2 z-[16] inline-flex items-center gap-[8px] px-3 py-[8px] rounded-lg bg-accent-deep text-white text-[12px] font-medium shadow-[0_4px_14px_rgb(0_0_0_/_0.25)] hover:bg-accent-emphasis transition-colors duration-100"
      // Rides the same lift as the bottom-left dock: when that dock has taken
      // its own row on a narrow pane, this CTA has to clear the taller stack
      // rather than land in it.
      style={{
        bottom:
          'calc(var(--vellum-dock-bottom-cta, 60px) + var(--vellum-dock-stack, 0px))',
      }}
      title="Fit diagram to view"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path
          d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>Return to content</span>
    </button>
  );
}
