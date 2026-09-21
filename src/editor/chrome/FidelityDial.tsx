import { useCallback, useRef } from 'react';

/** Reusable fidelity dial - the global bottom-left version is bound to
 *  `globalFidelity`; the per-shape inspector version is bound to a single shape.
 *
 *  Track is a left→right gradient from sketch (orange) → accent (cyan/blue)
 *  so the visual semantics match the data range [0, 1]. */
export function FidelityDial({
  value,
  onChange,
  width = 110,
  showLabel = true,
}: {
  value: number;
  onChange: (v: number) => void;
  width?: number;
  showLabel?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);

  const compute = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      onChange(Math.round(x * 100) / 100);
    },
    [onChange],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    compute(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    compute(e.clientX);
  };

  return (
    <div className="float flex items-center gap-[10px] px-3 py-2 h-9">
      {showLabel && (
        <span className="font-mono text-[9px] text-fg-muted tracking-[0.04em]">
          FIDELITY
        </span>
      )}
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        className="relative h-[5px] rounded-[3px] bg-bg-emphasis cursor-pointer touch-none"
        style={{ width }}
      >
        <div
          className="absolute top-0 left-0 h-full rounded-[3px]"
          style={{
            width: `${value * 100}%`,
            background:
              'linear-gradient(90deg, var(--sketch) 0%, var(--accent) 100%)',
          }}
        />
        <div
          className="absolute top-1/2 w-3 h-3 rounded-full bg-fg border-2 border-bg shadow-[0_0_0_1px_var(--border)]"
          style={{
            left: `${value * 100}%`,
            transform: 'translate(-50%, -50%)',
          }}
        />
      </div>
      <span className="font-mono text-[10px] text-fg w-7 text-right">
        {value.toFixed(2)}
      </span>
    </div>
  );
}
