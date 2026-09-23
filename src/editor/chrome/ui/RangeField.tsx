import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useEditor } from '@/store/editor';
import { scaledPx } from '@/editor/text-scale';

/** Shared range/slider control that backs the four inspector sliders
 *  (StrokeWidth, MarkerSize, Opacity, CornerRadius). Each of those
 *  originals was ~70 lines of essentially identical pointer-capture
 *  geometry, double-click-resets-to-undefined logic, and accent-fill
 *  rendering. RangeField captures the contract:
 *
 *  - `value === undefined` means "use the renderer's default" - the
 *    thumb sits at `defaultDisplay` with reduced opacity, the readout
 *    shows whatever `formatDefault` returns (muted), and double-click on
 *    the track resets the value back to undefined.
 *  - `value` is rounded by the caller-supplied `snap` function so the
 *    inspector controls each slider's own step (0.25 for stroke,
 *    1 for marker size, 0.05 for opacity, 1 for corner radius).
 *  - Geometry is screen-pixel based via `getBoundingClientRect`, same
 *    as the original sliders - no scaling concerns.
 *
 *  The readout on the right is an editable field, not a label: click,
 *  type a number, Enter / blur commits (clamped + snapped); ↑ / ↓ nudge by
 *  `step` (×10 with Shift) and commit live; Escape reverts; clearing the
 *  field - or typing `auto` - returns the property to undefined. That
 *  gives the "auto" state an actual exit and an actual way back, where before
 *  the only cue was a thumb parked near zero and the word auto.
 *
 *  Callers wrap this in a domain-named export (e.g. `StrokeWidthField`)
 *  so the inspector code stays readable. */
export interface RangeFieldProps {
  min: number;
  max: number;
  value: number | undefined;
  defaultDisplay: number;
  /** Round/snap raw track-space values to the slider's step. */
  snap: (raw: number) => number;
  /** Caller-side rounding/format for the readout when `value` is set. */
  format: (n: number) => string;
  /** Readout when `value === undefined`. Defaults to `'auto'`. */
  formatDefault?: (defaultDisplay: number) => string;
  onChange: (v: number | undefined) => void;
  /** Tooltip variants - `defaultTitle` is shown while value is undefined,
   *  `activeTitle` while it's set. Both default to the generic instructions
   *  the originals used. */
  defaultTitle?: string;
  activeTitle?: string;
  /** Tooltip text on the right-hand readout. */
  labelTitle?: (isDefault: boolean) => string;
  /** Width of the right-hand readout column. Defaults to 44px, grown with
   *  Settings ▸ Text size so the number still fits. */
  labelWidth?: string;
  /** Turn typed text back into a value in the slider's own domain. The
   *  default reads the leading number (`"12px"` → 12, `"1.5"` → 1.5);
   *  opacity overrides it so `"50"` / `"50%"` become 0.5. Return undefined
   *  for unparseable input - the field reverts. */
  parse?: (text: string) => number | undefined;
  /** ↑ / ↓ increment inside the readout. Defaults to 1/100 of the range,
   *  which every caller overrides with its actual step. */
  step?: number;
}

const defaultParse = (text: string): number | undefined => {
  const m = text.match(/-?\d*\.?\d+/);
  return m ? parseFloat(m[0]) : undefined;
};

export function RangeField({
  min,
  max,
  value,
  defaultDisplay,
  snap,
  format,
  formatDefault,
  onChange,
  defaultTitle = 'default - drag to override, double-click to reset',
  activeTitle = 'drag to change, double-click to reset to default',
  labelTitle,
  labelWidth = scaledPx(44),
  parse = defaultParse,
  step,
}: RangeFieldProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isDefault = value === undefined;
  // Clamp the auto-state thumb so an implicit value pushed out of range
  // (e.g. marker auto-size driven by stroke width) still parks visibly
  // inside the track instead of glued to either end.
  const display = isDefault ? Math.max(min, Math.min(max, defaultDisplay)) : value;

  const clampSnap = (n: number) => snap(Math.max(min, Math.min(max, n)));

  const compute = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return display;
    const rect = track.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return snap(min + t * (max - min));
  };

  // A track drag fires onChange on every pointer frame. Bracket the gesture
  // in a history batch so the scrub is ONE undo step - without it each
  // frame reached the store as its own atomic edit and Cmd+Z walked the
  // value back a pixel at a time. Sealed on pointerup / cancel / lost
  // capture, and on unmount in case the pointer never comes back (a popover
  // closing mid-drag). Harmless for callers whose onChange doesn't touch
  // the diagram (SaveDialog): an empty batch records nothing.
  const beginHistoryBatch = useEditor((s) => s.beginHistoryBatch);
  const endHistoryBatch = useEditor((s) => s.endHistoryBatch);
  const dragBatchOpen = useRef(false);
  const endDrag = () => {
    if (!dragBatchOpen.current) return;
    dragBatchOpen.current = false;
    endHistoryBatch();
  };
  useEffect(
    () => () => {
      if (dragBatchOpen.current) {
        dragBatchOpen.current = false;
        endHistoryBatch();
      }
    },
    [endHistoryBatch],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!dragBatchOpen.current) {
      dragBatchOpen.current = true;
      beginHistoryBatch();
    }
    onChange(compute(e.clientX));
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    onChange(compute(e.clientX));
  };

  const pct = ((display - min) / (max - min)) * 100;
  const labelText = isDefault
    ? formatDefault?.(defaultDisplay) ?? 'auto'
    : format(display);

  // Readout editing. `draft === null` = not editing, show the live readout.
  // While editing we hold the text locally so keystrokes don't write to
  // the store (one undo entry per committed edit, same as CommitInput).
  // `dirty` separates "focused then blurred" from "actually changed" so
  // tabbing through an auto field never converts it to an explicit value.
  const [draft, setDraft] = useState<string | null>(null);
  const dirty = useRef(false);
  // Select-all has to wait until React has written the seeded draft into
  // the DOM (writing a new value collapses the selection), so beginEdit
  // only flags it and the effect below performs it after commit.
  const selectNext = useRef(false);
  useEffect(() => {
    if (draft !== null && selectNext.current) {
      selectNext.current = false;
      inputRef.current?.select();
    }
  }, [draft]);
  // External writes (undo, a drag on the track, multi-select sync) while
  // the field is focused: leave the draft alone - same rule as the other
  // commit-on-blur inputs. Nothing to sync when not editing.
  useEffect(() => {
    if (draft !== null && document.activeElement !== inputRef.current) {
      setDraft(null);
    }
  }, [value, draft]);

  const beginEdit = () => {
    dirty.current = false;
    // Seed with the effective number (not the word "auto") so ↑ / ↓ nudge
    // from what the canvas is painting and select-all-then-type replaces it.
    selectNext.current = true;
    setDraft(format(display));
  };

  const commit = () => {
    if (draft === null) return;
    const text = draft.trim();
    setDraft(null);
    if (!dirty.current) return;
    if (text === '' || /^auto$/i.test(text) || /^default$/i.test(text)) {
      onChange(undefined);
      return;
    }
    const n = parse(text);
    if (n === undefined || !Number.isFinite(n)) return; // revert silently
    onChange(clampSnap(n));
  };

  const nudge = (dir: 1 | -1, big: boolean) => {
    const inc = (step ?? (max - min) / 100) * (big ? 10 : 1);
    const cur = draft !== null ? parse(draft) ?? display : display;
    const next = clampSnap(cur + dir * inc);
    dirty.current = true;
    onChange(next);
    setDraft(format(next));
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur(); // → commit via onBlur
    } else if (e.key === 'Escape') {
      dirty.current = false;
      setDraft(null);
      e.currentTarget.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      nudge(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
    }
  };

  return (
    <div className="flex items-center gap-2 w-full">
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={() => onChange(undefined)}
        title={isDefault ? defaultTitle : activeTitle}
        className="relative flex-1 h-[5px] rounded-[3px] bg-bg-emphasis cursor-pointer touch-none"
      >
        <div
          className={`absolute top-0 left-0 h-full rounded-[3px] ${
            isDefault ? 'bg-accent/25' : 'bg-accent/60'
          }`}
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute top-1/2 w-3 h-3 rounded-full bg-fg border-2 border-bg shadow-[0_0_0_1px_var(--border)]"
          style={{
            left: `${pct}%`,
            transform: 'translate(-50%, -50%)',
            opacity: isDefault ? 0.55 : 1,
          }}
        />
      </div>
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        className="range-value shrink-0"
        style={{ width: labelWidth }}
        data-auto={isDefault && draft === null ? 'true' : 'false'}
        value={draft ?? labelText}
        title={
          labelTitle?.(isDefault) ||
          (isDefault
            ? 'auto - click to type a value, ↑ / ↓ to nudge'
            : 'click to type a value, ↑ / ↓ to nudge, clear for auto')
        }
        onFocus={beginEdit}
        // A plain click on an unfocused field: the mousedown default would
        // place a caret / start a drag-selection that undoes the select-all
        // in beginEdit. Take over: suppress the default, focus by hand (which
        // still runs beginEdit) and let it select once the draft is in the
        // DOM. Clicks inside an already-focused field behave normally.
        onMouseDown={(e) => {
          if (document.activeElement === e.currentTarget) return;
          e.preventDefault();
          e.currentTarget.focus();
        }}
        onChange={(e) => {
          dirty.current = true;
          setDraft(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
