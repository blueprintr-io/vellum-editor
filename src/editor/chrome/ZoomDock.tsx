import { useEditor } from '@/store/editor';
import { I } from './icons';

/** Bottom-right zoom dock. Compact horizontal cluster: out / readout / in. */
export function ZoomDock() {
  const zoom = useEditor((s) => s.zoom);
  const setZoom = useEditor((s) => s.setZoom);

  return (
    <div
      data-chrome="zoom-dock"
      className="float absolute right-[14px] z-[15] flex items-stretch h-9 overflow-hidden"
      style={{ bottom: 'var(--vellum-dock-bottom-tight, 14px)' }}
    >
      <button
        onClick={() => setZoom(zoom * 0.9)}
        title="Zoom out"
        className="w-8 flex items-center justify-center bg-transparent border-none text-fg-muted hover:bg-bg-emphasis hover:text-fg"
      >
        <I.zoomOut />
      </button>
      <div className="flex items-center justify-center px-[10px] font-mono text-[11px] text-fg border-l border-r border-border">
        {Math.round(zoom * 100)}%
      </div>
      <button
        onClick={() => setZoom(zoom * 1.1)}
        title="Zoom in"
        className="w-8 flex items-center justify-center bg-transparent border-none text-fg-muted hover:bg-bg-emphasis hover:text-fg"
      >
        <I.zoomIn />
      </button>
    </div>
  );
}
