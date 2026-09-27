import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  hexToHsv,
  hexToRgb,
  hslToRgb,
  hsvToHex,
  parseColour,
  rgbToHex,
  rgbToHsl,
  type Hsv,
} from '@/editor/colour';
import {
  colourLibrary,
  libraryCount,
  searchLibrary,
  type LibraryColour,
} from '@/editor/colour-library';
import { CUSTOM_PALETTE_MAX, normaliseHex } from '@/editor/custom-palette';
import { Button } from '@/editor/chrome/ui/Button';

/** The editor's colour picker, opened from a swatch row's "more colours"
 *  cell (to colour the selection) or its custom palette's add cell (to
 *  save a new palette colour).
 *
 *  Two tabs share one footer. Picker: a saturation/brightness field and a
 *  hue slider. Library: 380-odd ready-made colours - the Spectrum ramps,
 *  the CSS named colours and colour-blind-safe sets - with search. The
 *  footer shows the colour as hex, RGB or HSL; any field, or the picker as
 *  a whole, takes a pasted colour in any of those forms or a CSS name. An
 *  eyedropper appears where the browser has one.
 *
 *  In `apply` mode every change reaches `onColour` as it happens, so the
 *  selection previews live; the swatch row brackets drags into one undo
 *  step (`live`) and makes discrete picks their own. In `add` mode nothing
 *  is applied: the colour stays in the picker until "Add to palette".
 *
 *  The flyout is portalled to <body> so an inspector's scroll box can't
 *  clip it, and stops pointer events at its root so the canvas and the
 *  swatch row's outside-click handlers never see a press inside it. It
 *  carries `data-colour-picker`, which the inline label editor treats as
 *  part of its toolbar, so typing a hex doesn't end a label edit. */

type Tab = 'picker' | 'library';
type Format = 'hex' | 'rgb' | 'hsl';

// Remembered for the page's lifetime: someone who prefers the library or
// types RGB gets it again next time.
let lastTab: Tab = 'picker';
let lastFormat: Format = 'hex';

const DEFAULT_COLOUR = '#3b82f6';
const VIEWPORT_PAD = 8;
const DOCK_GAP = 8;

export type ColourPickerProps = {
  /** The swatch grid the picker belongs to. Presses inside it don't close
   *  the picker; its cells decide. */
  anchorRef: RefObject<HTMLElement | null>;
  /** `panel`: sit beside the floating panel that holds the anchor (the
   *  inspector). `anchor`: sit under the anchor, flipping above it when
   *  there's no room. */
  dock: 'panel' | 'anchor';
  title: string;
  intent: 'apply' | 'add';
  /** The value being edited: a hex, a theme var, or undefined. Theme vars
   *  are resolved so the picker starts from the colour on screen. */
  value: string | undefined;
  palette: readonly string[];
  /** `live` while a drag or typing burst is in flight. */
  onColour: (hex: string, live: boolean) => void;
  /** A drag or burst ended. */
  onGestureEnd: () => void;
  /** Put the value back to what it was when the picker opened. */
  onRevert: () => void;
  onSave: (hex: string) => void;
  onClose: () => void;
};

export function ColourPicker({
  anchorRef,
  dock,
  title,
  intent,
  value,
  palette,
  onColour,
  onGestureEnd,
  onRevert,
  onSave,
  onClose,
}: ColourPickerProps) {
  const flyoutRef = useRef<HTMLDivElement>(null);
  const codesRef = useRef<HTMLDivElement>(null);
  const [original] = useState(() => ({
    css: value,
    hex: normaliseHex(value) ?? resolveCssColour(value),
  }));
  const [hsv, setHsv] = useState<Hsv>(() =>
    hexToHsv(original.hex ?? DEFAULT_COLOUR),
  );
  const hex = hsvToHex(hsv);
  const [tab, setTabState] = useState<Tab>(lastTab);
  const setTab = (t: Tab) => {
    lastTab = t;
    setTabState(t);
  };
  const [format, setFormatState] = useState<Format>(lastFormat);
  const setFormat = (f: Format) => {
    lastFormat = f;
    setFormatState(f);
  };

  // An outside change (undo, another control) moves the picker along. A
  // change the picker made itself arrives as the hex it already shows, so
  // dragging through greys keeps the hue the user is on.
  const valueHex = intent === 'apply' ? normaliseHex(value) : null;
  useEffect(() => {
    if (valueHex && valueHex !== hsvToHex(hsv)) setHsv(hexToHsv(valueHex));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueHex]);

  /** Set the picker's colour and, in apply mode, the selection's. */
  const set = (next: Hsv, live: boolean) => {
    setHsv(next);
    if (intent === 'apply') onColour(hsvToHex(next), live);
  };
  const setHex = (next: string, live = false) => {
    const h = hexToHsv(next);
    // Keep the hue when the new colour has none (a grey), so the hue
    // slider doesn't jump to red.
    set(h.s === 0 || h.v === 0 ? { ...h, h: hsv.h } : h, live);
  };

  // Closing by button or key hands focus back to wherever it was; closing
  // by clicking elsewhere leaves it with what was clicked.
  const [returnFocus] = useState(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );
  const close = (restoreFocus: boolean) => {
    onClose();
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // Add mode starts in the first code field, ready for a pasted code.
  useEffect(() => {
    const field =
      intent === 'add' ? codesRef.current?.querySelector('input') : null;
    (field ?? flyoutRef.current)?.focus();
  }, [intent]);

  // Escape closes the picker first, wherever focus is - even on <body>
  // after a focused control went away - instead of reaching the editor,
  // whose Escape clears the selection.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current(true);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  // Capture phase, so the picker closes before whatever was pressed acts:
  // a press on the canvas must not land inside the picker's history batch.
  useEffect(() => {
    const onDown = (e: globalThis.PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || flyoutRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      closeRef.current(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [anchorRef]);

  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const el = flyoutRef.current;
      const anchor = anchorRef.current;
      if (!el || !anchor) return;
      setPos(placeFlyout(el, anchor, dock));
    };
    place();
    const ro = new ResizeObserver(place);
    if (flyoutRef.current) ro.observe(flyoutRef.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchorRef, dock]);

  const saved = palette.includes(hex);
  const full = palette.length >= CUSTOM_PALETTE_MAX;

  // Adding finishes the picker; saving keeps it open, with focus on the
  // flyout because the save button goes disabled under the pointer.
  const add = (c: string) => {
    if (!palette.includes(c)) onSave(c);
    close(true);
  };
  const save = () => {
    onSave(hex);
    flyoutRef.current?.focus();
  };
  // A colour pasted anywhere but a field lands as the colour.
  const onPaste = (e: ClipboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    const parsed = parseColour(e.clipboardData.getData('text/plain'));
    if (!parsed) return;
    e.preventDefault();
    setHex(parsed);
  };
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return createPortal(
    <div
      ref={flyoutRef}
      role="dialog"
      aria-label={title}
      data-colour-picker=""
      data-keybinding-scope="dialog"
      tabIndex={-1}
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={stop}
      onContextMenu={stop}
      onPaste={onPaste}
      className="float fixed z-[1000] flex flex-col overflow-hidden outline-none"
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        // Transparent rather than hidden until placed, so it can take focus.
        opacity: pos ? 1 : 0,
        pointerEvents: pos ? undefined : 'none',
        width: 'calc(288px * var(--vellum-text-scale, 1))',
        maxWidth: `calc(100vw - ${VIEWPORT_PAD * 2}px)`,
        maxHeight: `calc(100vh - ${VIEWPORT_PAD * 2}px)`,
      }}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-2.5">
        <h2 className="min-w-0 flex-1 truncate text-[12px] font-semibold">{title}</h2>
        <div
          role="tablist"
          aria-label="Colour source"
          className="flex rounded-md border border-border bg-bg p-0.5"
        >
          {(['picker', 'library'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-[4px] px-2 py-0.5 text-[11px] ${
                tab === t
                  ? 'bg-bg-emphasis font-semibold text-fg'
                  : 'text-fg-muted hover:text-fg'
              }`}
            >
              {t === 'picker' ? 'Picker' : 'Library'}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => close(true)}
          title="Close (Esc)"
          aria-label="Close colour picker"
          className="-mr-1 flex h-6 w-6 items-center justify-center rounded-md text-fg-muted hover:bg-bg-emphasis hover:text-fg"
        >
          <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-3"
        // The library scrolls inside a fixed window, so switching tabs
        // grows the flyout downward instead of throwing it up the screen.
        style={tab === 'library' ? { maxHeight: 'min(380px, 55vh)' } : undefined}
      >
        {tab === 'picker' ? (
          <MixPanel hsv={hsv} onChange={set} onGestureEnd={onGestureEnd} />
        ) : (
          <LibraryPanel current={hex} onPick={(c) => setHex(c)} />
        )}
      </div>

      <div className="shrink-0 space-y-2.5 border-t border-border px-3 pb-3 pt-2.5">
        <CodeFields
          hex={hex}
          hsv={hsv}
          format={format}
          onFormat={setFormat}
          original={intent === 'apply' ? original : null}
          onRevert={() => {
            onRevert();
            if (original.hex) setHsv(hexToHsv(original.hex));
          }}
          onHex={setHex}
          onGestureEnd={onGestureEnd}
          onEnter={intent === 'add' && !full ? add : undefined}
          containerRef={codesRef}
        />
        {intent === 'add' ? (
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" onClick={() => close(true)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={full || saved}
              onClick={() => add(hex)}
            >
              {saved ? 'Already in palette' : full ? 'Palette full' : 'Add to palette'}
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            className="w-full"
            disabled={saved || full}
            onClick={save}
            title={
              saved
                ? `${hex} is in your custom palette`
                : full
                  ? 'Your custom palette is full'
                  : `Keep ${hex} in your custom palette`
            }
          >
            {saved ? (
              <>
                <CheckGlyph /> In your custom palette
              </>
            ) : full ? (
              'Custom palette full'
            ) : (
              <>
                <PlusGlyph /> Save to custom palette
              </>
            )}
          </Button>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Where the flyout goes, in viewport px. Docked to a panel: beside it
 *  (left, else right), or along the bottom edge on a screen too narrow for
 *  either. Docked to the anchor: under it, over it, or beside it. Always
 *  clamped inside the viewport. */
function placeFlyout(
  el: HTMLElement,
  anchor: HTMLElement,
  dock: 'panel' | 'anchor',
): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const a = anchor.getBoundingClientRect();
  let left: number;
  let top: number;
  const panel =
    dock === 'panel'
      ? (anchor.closest('.float') as HTMLElement | null)?.getBoundingClientRect()
      : undefined;
  if (panel && panel.left - DOCK_GAP - w >= VIEWPORT_PAD) {
    left = panel.left - DOCK_GAP - w;
    top = a.top - 44;
  } else if (panel && panel.right + DOCK_GAP + w <= vw - VIEWPORT_PAD) {
    left = panel.right + DOCK_GAP;
    top = a.top - 44;
  } else if (panel) {
    left = (vw - w) / 2;
    top = vh - VIEWPORT_PAD - h;
  } else {
    // Under the anchor, else over it, else beside it - never on top of
    // the swatches it belongs to.
    const below = a.bottom + DOCK_GAP;
    const above = a.top - DOCK_GAP - h;
    left = a.right - w;
    top = below;
    if (below + h > vh - VIEWPORT_PAD) {
      if (above >= VIEWPORT_PAD) top = above;
      else if (a.left - DOCK_GAP - w >= VIEWPORT_PAD) {
        left = a.left - DOCK_GAP - w;
        top = a.top - 44;
      } else if (a.right + DOCK_GAP + w <= vw - VIEWPORT_PAD) {
        left = a.right + DOCK_GAP;
        top = a.top - 44;
      }
    }
  }
  const clamp = (n: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, n));
  return {
    left: clamp(left, VIEWPORT_PAD, vw - VIEWPORT_PAD - w),
    top: clamp(top, VIEWPORT_PAD, vh - VIEWPORT_PAD - h),
  };
}

/** The colour a CSS value paints, as hex: resolves theme vars like
 *  `var(--fill-blue)` through a probe element. Null for anything
 *  transparent or unparseable. */
function resolveCssColour(value: string | undefined): string | null {
  if (!value || typeof document === 'undefined') return null;
  const probe = document.createElement('span');
  probe.style.color = value;
  if (!probe.style.color) return null;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const m = computed.match(/[\d.]+/g);
  if (!m || m.length < 3 || (m.length > 3 && Number(m[3]) === 0)) return null;
  return rgbToHex({ r: Number(m[0]), g: Number(m[1]), b: Number(m[2]) });
}

// ─── Picker tab ─────────────────────────────────────────────────────────

/** Saturation/brightness field plus hue slider. Drags report `live`; the
 *  pointer's release ends the gesture. The field's thumb is a keyboard
 *  slider: arrows move 1%, Shift moves 10%. */
function MixPanel({
  hsv,
  onChange,
  onGestureEnd,
}: {
  hsv: Hsv;
  onChange: (next: Hsv, live: boolean) => void;
  onGestureEnd: () => void;
}) {
  const fieldRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const fromPointer = (e: PointerEvent) => {
    const r = fieldRef.current!.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    onChange({ h: hsv.h, s, v }, true);
  };
  const end = (e: PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    fieldRef.current?.releasePointerCapture?.(e.pointerId);
    onGestureEnd();
  };
  const onThumbKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const d =
      e.key === 'ArrowLeft' ? [-step, 0]
      : e.key === 'ArrowRight' ? [step, 0]
      : e.key === 'ArrowDown' ? [0, -step]
      : e.key === 'ArrowUp' ? [0, step]
      : null;
    if (!d) return;
    e.preventDefault();
    const c = (n: number) => Math.min(1, Math.max(0, n));
    onChange({ h: hsv.h, s: c(hsv.s + d[0]), v: c(hsv.v + d[1]) }, true);
  };

  return (
    <div className="space-y-2.5 pb-2.5">
      <div
        ref={fieldRef}
        className="relative h-[150px] w-full cursor-crosshair touch-none rounded-md"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(${hsv.h} 100% 50%)`,
          boxShadow: 'inset 0 0 0 1px rgb(0 0 0 / 0.12)',
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          dragging.current = true;
          fieldRef.current?.setPointerCapture?.(e.pointerId);
          thumbRef.current?.focus();
          fromPointer(e);
        }}
        onPointerMove={(e) => dragging.current && fromPointer(e)}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <div
          ref={thumbRef}
          role="slider"
          tabIndex={0}
          aria-label="Saturation and brightness"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(hsv.s * 100)}
          aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
          onKeyDown={onThumbKey}
          onKeyUp={onGestureEnd}
          className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white outline-none focus-visible:ring-2 focus-visible:ring-accent"
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            background: hsvToHex(hsv),
            boxShadow: '0 0 0 1px rgb(0 0 0 / 0.35), 0 1px 4px rgb(0 0 0 / 0.4)',
          }}
        />
      </div>
      <input
        type="range"
        min={0}
        max={359}
        step={1}
        value={Math.round(hsv.h) % 360}
        aria-label="Hue"
        onChange={(e) => onChange({ ...hsv, h: Number(e.target.value) }, true)}
        onPointerUp={onGestureEnd}
        onKeyUp={onGestureEnd}
        onBlur={onGestureEnd}
        className="colour-hue"
        style={{ '--hue-thumb': `hsl(${hsv.h} 100% 50%)` } as React.CSSProperties}
      />
    </div>
  );
}

// ─── Library tab ────────────────────────────────────────────────────────

function LibraryPanel({
  current,
  onPick,
}: {
  current: string;
  onPick: (hex: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [hovered, setHovered] = useState<LibraryColour | null>(null);
  const groups = useMemo(() => colourLibrary(), []);
  const count = useMemo(() => libraryCount(), []);
  const results = useMemo(() => searchLibrary(query), [query]);
  // A code typed into search is offered as a colour of its own.
  const typed = useMemo(() => {
    const parsed = parseColour(query);
    return parsed && !results.some((r) => r.hex === parsed) ? parsed : null;
  }, [query, results]);

  const swatch = (c: LibraryColour) => (
    <button
      key={c.hex + c.name}
      type="button"
      title={`${c.name} ${c.hex}`}
      aria-label={`${c.name}, ${c.hex}`}
      aria-pressed={c.hex === current}
      onClick={() => onPick(c.hex)}
      onPointerEnter={() => setHovered(c)}
      onFocus={() => setHovered(c)}
      className="aspect-square w-full rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
      style={{
        background: c.hex,
        boxShadow:
          c.hex === current
            ? `0 0 0 2px var(--bg), 0 0 0 3.5px var(--accent)`
            : 'inset 0 0 0 1px rgb(0 0 0 / 0.1)',
      }}
    />
  );

  return (
    <div className="pb-2.5" onPointerLeave={() => setHovered(null)}>
      <label className="sticky top-0 z-[1] -mx-3 mb-2 flex items-center gap-1.5 bg-[rgb(var(--bg-rgb)/0.96)] px-3 pb-1.5">
        <span className="sr-only">Search colours</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${count} colours, or paste a code`}
          className="field-input py-1 text-[11px]"
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      {query.trim() ? (
        <div className="space-y-px">
          {typed && (
            <SearchRow
              colour={{ name: 'Use this colour', hex: typed }}
              group="typed"
              active={typed === current}
              onPick={onPick}
            />
          )}
          {results.map((c) => (
            <SearchRow
              key={`${c.group}-${c.name}-${c.hex}`}
              colour={c}
              group={c.group}
              active={c.hex === current}
              onPick={onPick}
            />
          ))}
          {!typed && !results.length && (
            <p className="px-1 py-3 text-center text-[11px] text-fg-muted">
              No colours match “{query.trim()}”.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <section key={g.id} aria-label={g.title}>
              <h3 className="mb-1.5 font-mono text-[10px] text-fg-muted">
                {g.title.toLowerCase()}
              </h3>
              {g.layout === 'grid' ? (
                <div
                  className="grid gap-[3px]"
                  style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(17px, 1fr))' }}
                >
                  {g.rows[0].colours.map(swatch)}
                </div>
              ) : (
                <div className="space-y-[3px]">
                  {g.rows.map((row) => (
                    <div
                      key={row.label}
                      className="grid items-center gap-[3px]"
                      style={{
                        gridTemplateColumns: `calc(56px * var(--vellum-text-scale, 1)) repeat(11, 1fr)`,
                      }}
                    >
                      <span className="truncate font-mono text-[9px] text-fg-muted">
                        {row.label.toLowerCase()}
                      </span>
                      {row.colours.map(swatch)}
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}

      {!query.trim() && (
        <p
          aria-live="polite"
          className="sticky bottom-0 -mx-3 mt-2 truncate bg-[rgb(var(--bg-rgb)/0.96)] px-3 pt-1.5 font-mono text-[10px] text-fg-muted"
        >
          {hovered ? `${hovered.name} · ${hovered.hex}` : 'Point at a colour to see its name.'}
        </p>
      )}
    </div>
  );
}

function SearchRow({
  colour,
  group,
  active,
  onPick,
}: {
  colour: LibraryColour;
  group: string;
  active: boolean;
  onPick: (hex: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(colour.hex)}
      aria-pressed={active}
      className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[11px] hover:bg-bg-emphasis ${
        active ? 'bg-bg-emphasis' : ''
      }`}
    >
      <span
        aria-hidden="true"
        className="h-4 w-4 shrink-0 rounded-[3px]"
        style={{ background: colour.hex, boxShadow: 'inset 0 0 0 1px rgb(0 0 0 / 0.12)' }}
      />
      <span className="min-w-0 flex-1 truncate">{colour.name}</span>
      {group !== 'typed' && (
        <span className="shrink-0 truncate text-[10px] text-fg-muted">{group}</span>
      )}
      <span className="shrink-0 font-mono text-[10px] text-fg-muted">{colour.hex}</span>
    </button>
  );
}

// ─── Footer: preview + codes ────────────────────────────────────────────

function CodeFields({
  hex,
  hsv,
  format,
  onFormat,
  original,
  onRevert,
  onHex,
  onGestureEnd,
  onEnter,
  containerRef,
}: {
  hex: string;
  hsv: Hsv;
  format: Format;
  onFormat: (f: Format) => void;
  /** The colour before the picker opened, in apply mode. */
  original: { css: string | undefined; hex: string | null } | null;
  onRevert: () => void;
  onHex: (hex: string, live?: boolean) => void;
  onGestureEnd: () => void;
  /** Enter in any field also runs this with the entered colour (add mode:
   *  add it to the palette). */
  onEnter?: (hex: string) => void;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const rgb = hexToRgb(hex);
  const hsl = rgbToHsl(rgb);
  const canEyedrop = typeof window !== 'undefined' && 'EyeDropper' in window;
  const eyedrop = async () => {
    try {
      const Dropper = (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
      const { sRGBHex } = await new Dropper().open();
      const picked = parseColour(sRGBHex);
      if (picked) onHex(picked);
    } catch {
      // Dismissed with Escape: nothing to do.
    }
  };
  // Paste a whole colour into any one field.
  const onFieldPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text/plain');
    if (/^\s*\d{1,3}\s*$/.test(text)) return;
    const parsed = parseColour(text);
    if (!parsed) return;
    e.preventDefault();
    e.stopPropagation();
    onHex(parsed);
  };
  const seal = () => onGestureEnd();
  const enter = onEnter ? () => onEnter(hex) : undefined;

  return (
    <div ref={containerRef} className="space-y-2">
      <div className="flex items-center gap-2">
        <div
          className="flex h-7 w-11 shrink-0 overflow-hidden rounded-md"
          style={{ boxShadow: 'inset 0 0 0 1px var(--border)' }}
        >
          {original && (
            <button
              type="button"
              onClick={onRevert}
              title={`Back to the colour you started with${original.hex ? ` (${original.hex})` : ''}`}
              aria-label="Revert to the original colour"
              className="h-full flex-1"
              style={{
                background: original.css === undefined ? 'var(--bg-subtle)' : original.css,
              }}
            />
          )}
          <span
            aria-hidden="true"
            className="h-full flex-1"
            style={{ background: hex }}
          />
        </div>
        <div
          role="radiogroup"
          aria-label="Colour format"
          className="flex rounded-md border border-border bg-bg p-0.5"
        >
          {(['hex', 'rgb', 'hsl'] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={format === f}
              onClick={() => onFormat(f)}
              className={`rounded-[4px] px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                format === f
                  ? 'bg-bg-emphasis font-semibold text-fg'
                  : 'text-fg-muted hover:text-fg'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {canEyedrop && (
          <button
            type="button"
            onClick={eyedrop}
            title="Pick a colour from the screen"
            aria-label="Pick a colour from the screen"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-bg-subtle text-fg-muted hover:bg-bg-emphasis hover:text-fg"
          >
            <PipetteGlyph />
          </button>
        )}
      </div>

      {format === 'hex' && (
        <HexField
          hex={hex}
          onHex={onHex}
          onBlurSeal={seal}
          onEnter={onEnter}
          onPaste={onFieldPaste}
        />
      )}
      {format === 'rgb' && (
        <div className="grid grid-cols-3 gap-1.5">
          {(['r', 'g', 'b'] as const).map((k) => (
            <NumberField
              key={k}
              label={k.toUpperCase()}
              value={rgb[k]}
              max={255}
              onValue={(n) => onHex(rgbToHex({ ...rgb, [k]: n }), true)}
              onCommit={seal}
              onEnter={enter}
              onPaste={onFieldPaste}
            />
          ))}
        </div>
      )}
      {format === 'hsl' && (
        <div className="grid grid-cols-3 gap-1.5">
          <NumberField
            label="H"
            value={Math.round(hsv.s === 0 ? hsv.h : hsl.h)}
            max={360}
            suffix="°"
            onValue={(n) =>
              onHex(rgbToHex(hslToRgb({ ...hsl, h: n % 360 })), true)
            }
            onCommit={seal}
            onEnter={enter}
            onPaste={onFieldPaste}
          />
          <NumberField
            label="S"
            value={Math.round(hsl.s * 100)}
            max={100}
            suffix="%"
            onValue={(n) => onHex(rgbToHex(hslToRgb({ ...hsl, s: n / 100 })), true)}
            onCommit={seal}
            onEnter={enter}
            onPaste={onFieldPaste}
          />
          <NumberField
            label="L"
            value={Math.round(hsl.l * 100)}
            max={100}
            suffix="%"
            onValue={(n) => onHex(rgbToHex(hslToRgb({ ...hsl, l: n / 100 })), true)}
            onCommit={seal}
            onEnter={enter}
            onPaste={onFieldPaste}
          />
        </div>
      )}
    </div>
  );
}

/** Hex box. A complete six-digit code applies as it's typed; anything
 *  else `parseColour` reads (`#abc`, `rgb(…)`, `hsl(…)`, `tomato`) applies
 *  on Enter or on leaving the field. Unreadable text is flagged, and put
 *  back on leaving. */
function HexField({
  hex,
  onHex,
  onBlurSeal,
  onEnter,
  onPaste,
}: {
  hex: string;
  onHex: (hex: string, live?: boolean) => void;
  onBlurSeal: () => void;
  onEnter?: (hex: string) => void;
  onPaste: (e: ClipboardEvent<HTMLInputElement>) => void;
}) {
  const [draft, setDraft] = useState(hex);
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(hex);
  }, [hex, focused]);
  const commit = () => {
    const parsed = parseColour(draft);
    if (!parsed) {
      setInvalid(true);
      return null;
    }
    setInvalid(false);
    if (parsed !== hex) onHex(parsed);
    setDraft(parsed);
    return parsed;
  };
  return (
    <div className="relative">
      <input
        value={draft}
        aria-label="Colour code"
        aria-invalid={invalid}
        spellCheck={false}
        autoComplete="off"
        onFocus={(e) => {
          setFocused(true);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          const t = e.target.value;
          setDraft(t);
          setInvalid(false);
          const six = /^#?[0-9a-f]{6}$/i.test(t.trim()) ? parseColour(t) : null;
          if (six && six !== hex) onHex(six, true);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const entered = commit();
          if (entered) onEnter?.(entered);
        }}
        onBlur={() => {
          setFocused(false);
          if (!commit()) {
            setDraft(hex);
            setInvalid(false);
          }
          onBlurSeal();
        }}
        onPaste={onPaste}
        placeholder="#rrggbb, rgb(), hsl() or a name"
        className="field-input mono py-1 text-[11px]"
        style={invalid ? { borderColor: 'var(--stroke-red)' } : undefined}
      />
      {invalid && (
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[var(--stroke-red)]">
          not a colour
        </span>
      )}
    </div>
  );
}

/** A 0…max integer box with its channel letter. Typing applies as soon as
 *  the number is valid; arrows step by 1 (Shift: 10). */
function NumberField({
  label,
  value,
  max,
  suffix,
  onValue,
  onCommit,
  onEnter,
  onPaste,
}: {
  label: string;
  value: number;
  max: number;
  suffix?: string;
  onValue: (n: number) => void;
  onCommit: () => void;
  onEnter?: () => void;
  onPaste: (e: ClipboardEvent<HTMLInputElement>) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);
  const clampTo = (n: number) => Math.max(0, Math.min(max, Math.round(n)));
  return (
    <label className="flex items-center gap-1 rounded-[4px] border border-border bg-bg-subtle pl-1.5 focus-within:border-accent">
      <span className="font-mono text-[10px] text-fg-muted">{label}</span>
      <input
        value={draft}
        inputMode="numeric"
        aria-label={`${label} (0 to ${max})`}
        onFocus={(e) => {
          setFocused(true);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          const t = e.target.value.replace(/[^\d]/g, '').slice(0, 3);
          setDraft(t);
          if (t !== '') onValue(clampTo(Number(t)));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onCommit();
            onEnter?.();
            return;
          }
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
          const n = clampTo((Number(draft) || 0) + step);
          setDraft(String(n));
          onValue(n);
        }}
        onBlur={() => {
          setFocused(false);
          setDraft(String(value));
          onCommit();
        }}
        onPaste={onPaste}
        className="min-w-0 flex-1 bg-transparent py-1 pr-1 font-mono text-[11px] text-fg outline-none"
      />
      {suffix && (
        <span className="pr-1.5 font-mono text-[10px] text-fg-muted">{suffix}</span>
      )}
    </label>
  );
}

// ─── Glyphs ─────────────────────────────────────────────────────────────

function PipetteGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M10.2 2.6a1.9 1.9 0 0 1 2.7 2.7l-1.3 1.3.7.7-1.1 1.1-.7-.7-4.9 4.9H3.5v-2.1l4.9-4.9-.7-.7 1.1-1.1.7.7z"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden="true">
      <path d="M5 1.5v7M1.5 5h7" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M1.75 5.25l2.25 2.25 4.25-4.75" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

