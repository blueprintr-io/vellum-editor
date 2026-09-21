import { useEditor } from '@/store/editor';
import { STROKE_SWATCHES } from '@/editor/swatches';

// Pen colours mirror the inspector's STROKE_SWATCHES so pen strokes pick
// up the same auto-switching dark/light palette as every other stroke (see
// editor/swatches.ts). `var(--ink)` stays at the head as the theme-aware
// "use the canvas's ink" choice.
const COLOURS = [
  { label: 'ink', value: 'var(--ink)' },
  ...STROKE_SWATCHES.map((s) => ({ label: s.label, value: s.cssVar })),
];

/** Floating pen settings - colour + thickness. Visible only when the pen tool
 *  is active. The choices live on the editor store so they persist across
 *  strokes during the session and apply to every new freehand path. */
export function PenPanel() {
  const activeTool = useEditor((s) => s.activeTool);
  const bindings = useEditor((s) => s.hotkeyBindings);
  const tool = bindings[activeTool]?.tool;
  const penColor = useEditor((s) => s.penColor);
  const penWidth = useEditor((s) => s.penWidth);
  const setPenColor = useEditor((s) => s.setPenColor);
  const setPenWidth = useEditor((s) => s.setPenWidth);

  if (tool !== 'pen') return null;

  return (
    <div className="float absolute top-1/2 -translate-y-1/2 right-[14px] z-[15] py-3 px-2 flex flex-col items-center gap-3">
      <div className="flex flex-col gap-1">
        {COLOURS.map((c) => {
          const active = penColor === c.value;
          return (
            <button
              key={c.value}
              title={c.label}
              onClick={() => setPenColor(c.value)}
              className="w-6 h-6 rounded-full border"
              style={{
                background: c.value,
                borderColor: active ? 'var(--accent)' : 'var(--border)',
                boxShadow: active ? '0 0 0 2px var(--accent)' : undefined,
              }}
            />
          );
        })}
      </div>
      <div className="border-t border-border w-6" />
      <div className="flex flex-col items-center gap-1 py-1">
        {[1.5, 3, 5, 8].map((w) => {
          const active = penWidth === w;
          return (
            <button
              key={w}
              title={`width ${w}`}
              onClick={() => setPenWidth(w)}
              className="w-7 h-7 rounded-md flex items-center justify-center"
              style={{
                background: active ? 'var(--bg-emphasis)' : 'transparent',
                border: active ? '1px solid var(--accent)' : '1px solid transparent',
              }}
            >
              <span
                className="block rounded-full"
                style={{
                  width: w * 1.5,
                  height: w * 1.5,
                  background: 'var(--fg)',
                }}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
