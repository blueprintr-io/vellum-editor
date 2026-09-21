import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FONT_PRESETS } from '@/store/types';

/** Custom font dropdown - renders each option in its own font so the user can
 *  see the typeface before picking. Native <select> can't style options
 *  cross-browser; this gives consistent previews everywhere.
 *
 *  The menu is portaled to <body> with fixed-position coordinates derived from
 *  the trigger's bounding rect. Without the portal, the inspector card's
 *  `overflow-y-auto` (ShapeInspector) clips the menu.
 *
 *  `value` of `undefined` means "default" (the kind's natural font). */
export function FontPicker({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );

  // Recompute menu position from the trigger's viewport rect. Re-runs on
  // scroll/resize so the menu stays anchored if the inspector scrolls.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      setPos({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  // Close on outside click or Escape. Outside = neither trigger nor menu.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
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

  const selected =
    FONT_PRESETS.find(
      (p) => (p.label === 'Default' ? undefined : p.value) === value,
    ) ?? FONT_PRESETS[0];

  return (
    <div className="relative w-full">
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        className="field-input w-full text-left flex items-center justify-between"
        style={{ fontFamily: selected.value }}
        type="button"
      >
        <span>{selected.label}</span>
        <span className="text-fg-muted text-[10px]">▾</span>
      </button>
      {open && pos &&
        createPortal(
          <div
            ref={menuRef}
            className="float fixed z-[1000] py-1"
            style={{ top: pos.top, left: pos.left, width: pos.width }}
          >
            {FONT_PRESETS.map((p) => {
              const isActive =
                (p.label === 'Default' ? undefined : p.value) === value;
              return (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => {
                    onChange(p.label === 'Default' ? undefined : p.value);
                    setOpen(false);
                  }}
                  style={{ fontFamily: p.value, fontSize: 13 }}
                  className={`flex items-center justify-between w-full px-3 py-[7px] text-left ${
                    isActive ? 'bg-bg-emphasis text-fg' : 'text-fg hover:bg-bg-emphasis'
                  }`}
                >
                  <span>{p.label}</span>
                  <span
                    className="text-fg-muted text-[10px]"
                    style={{ fontFamily: 'var(--font-mono)' }}
                  >
                    Aa
                  </span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
