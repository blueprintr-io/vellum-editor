/* Persistent doc-scoped attribution surface.
 *
 * Is next to LayerPills in the bottom-left dock. Renders nothing when the
 * diagram has no attributable icons - that way the chrome stays clean for
 * normal diagrams and only surfaces when there's actually compliance work to
 * see.
 *
 * The button shows a count ("© 3") of distinct vendor + collection
 * attributions; clicking pops the AttributionsPanel above it. The panel
 * itself is doc-scoped (walks the live diagram), so the count and panel
 * always reflect what's currently on canvas. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '@/store/editor';
import { collectAttributions, hasAttributableIcons } from '@/icons/attribution';
import { AttributionsPanel } from './AttributionsPanel';

export function AttributionsButton() {
  const diagram = useEditor((s) => s.diagram);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const count = useMemo(() => {
    if (!hasAttributableIcons(diagram)) return 0;
    const a = collectAttributions(diagram);
    return a.vendors.length + a.collections.length;
  }, [diagram]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (count === 0) return null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`${count} attribution${count === 1 ? '' : 's'} required - click to view`}
        aria-pressed={open}
        className={`inline-flex items-center gap-[4px] px-[8px] py-[4px] rounded-md border border-border text-[10px] font-mono text-fg-muted hover:text-fg hover:bg-bg-emphasis bg-bg-subtle ${
          open ? 'bg-bg-emphasis text-fg' : ''
        }`}
      >
        <span>©</span>
        <span>{count}</span>
      </button>
      {open && (
        <div
          className="float absolute left-0 bottom-full mb-2 w-[320px] max-h-[60vh] overflow-y-auto z-30 px-[14px] py-3"
        >
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-[11px] font-mono text-fg-muted tracking-[0.04em]">
              ATTRIBUTIONS
            </span>
            <span className="text-[9px] font-mono text-fg-muted">
              this document
            </span>
          </div>
          <AttributionsPanel />
        </div>
      )}
    </div>
  );
}
