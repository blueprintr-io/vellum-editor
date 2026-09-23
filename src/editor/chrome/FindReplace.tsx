import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '@/store/editor';
import type { Connector, Shape, TableCell } from '@/store/types';

/** Floating Find/Replace panel - Cmd/Ctrl+F.
 *
 *  Searches across shape labels/body/sublabels, table cell text, and
 *  connector labels. Selects + centres the canvas on each match as the
 *  user steps through with Enter / Shift+Enter or the Prev/Next buttons.
 *
 *  Replace fires the store's `replaceTextAll` action which snapshots once
 *  for the batch (single ⌘Z restores).
 */
type Match = {
  /** Shape OR connector id used for selection + scroll. */
  id: string;
  /** Where the matched text is - drives the centre-on coordinates. */
  shape?: Shape;
  connector?: Connector;
  /** A short snippet around the match for the result list ("…before MATCH after…"). */
  snippet: string;
  /** Where in the source string the match starts; used to dedup multi-occurrences. */
  field: string;
  index: number;
};

const SNIPPET_PAD = 18;

export function FindReplace() {
  const open = useEditor((s) => s.findOpen);
  const setFindOpen = useEditor((s) => s.setFindOpen);
  const shapes = useEditor((s) => s.diagram.shapes);
  const connectors = useEditor((s) => s.diagram.connectors);
  const setSelected = useEditor((s) => s.setSelected);
  const setPan = useEditor((s) => s.setPan);
  const zoom = useEditor((s) => s.zoom);
  const replaceTextAll = useEditor((s) => s.replaceTextAll);

  const [find, setFind] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [cursor, setCursor] = useState(0);
  const findRef = useRef<HTMLInputElement | null>(null);

  // Refocus the find input every time the panel opens, even if it was already
  // open (re-pressing Cmd+F is a request to re-focus + select-all).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      findRef.current?.focus();
      findRef.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, [open]);

  const matches = useMemo<Match[]>(() => {
    if (!find) return [];
    const needle = matchCase ? find : find.toLowerCase();
    const out: Match[] = [];
    const scan = (text: string | undefined, owner: Match['field']): { i: number; snip: string }[] => {
      if (!text) return [];
      const hay = matchCase ? text : text.toLowerCase();
      const hits: { i: number; snip: string }[] = [];
      let i = 0;
      while (i <= hay.length - needle.length) {
        const idx = hay.indexOf(needle, i);
        if (idx === -1) break;
        const start = Math.max(0, idx - SNIPPET_PAD);
        const end = Math.min(text.length, idx + needle.length + SNIPPET_PAD);
        const snip =
          (start > 0 ? '…' : '') +
          text.slice(start, end) +
          (end < text.length ? '…' : '');
        hits.push({ i: idx, snip });
        i = idx + needle.length;
      }
      void owner;
      return hits;
    };
    for (const sh of shapes) {
      for (const f of ['label', 'body', 'sublabel'] as const) {
        for (const h of scan(sh[f], `shape:${f}`)) {
          out.push({ id: sh.id, shape: sh, snippet: h.snip, field: `${sh.id}:${f}`, index: h.i });
        }
      }
      if (sh.cells) {
        sh.cells.forEach((row, r) => {
          if (!row) return;
          row.forEach((cell: TableCell | null | undefined, c) => {
            if (!cell?.text) return;
            for (const h of scan(cell.text, `cell:${r}:${c}`)) {
              out.push({
                id: sh.id,
                shape: sh,
                snippet: h.snip,
                field: `${sh.id}:cell:${r}:${c}`,
                index: h.i,
              });
            }
          });
        });
      }
    }
    for (const c of connectors) {
      for (const h of scan(c.label, 'conn:label')) {
        out.push({ id: c.id, connector: c, snippet: h.snip, field: `${c.id}:label`, index: h.i });
      }
    }
    return out;
  }, [find, matchCase, shapes, connectors]);

  // Clamp the cursor whenever the match set shrinks under it.
  useEffect(() => {
    if (cursor >= matches.length) setCursor(0);
  }, [matches.length, cursor]);

  // Selecting + centring the canvas on the active match. Only fires when the
  // panel is open AND there is an active match - so opening the panel without
  // a query doesn't yank the user's view.
  useEffect(() => {
    if (!open || matches.length === 0) return;
    const m = matches[cursor];
    if (!m) return;
    setSelected([m.id]);
    const target = shapeCenter(m.shape) ?? connectorCenter(m.connector, shapes);
    if (target) {
      setPan({
        x: window.innerWidth / 2 - target.x * zoom,
        y: window.innerHeight / 2 - target.y * zoom,
      });
    }
    // intentionally omits zoom from the dep array - re-running when the user
    // zooms would fight their gesture. The pan-on-match only happens on a
    // navigation (next/prev/query change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, matches, open]);

  if (!open) return null;

  const next = () => {
    if (matches.length === 0) return;
    setCursor((c) => (c + 1) % matches.length);
  };
  const prev = () => {
    if (matches.length === 0) return;
    setCursor((c) => (c - 1 + matches.length) % matches.length);
  };
  const doReplace = () => {
    if (matches.length === 0 || !find) return;
    replaceTextAll(find, replacement, matchCase);
    // Cursor naturally rebases - the match list re-derives from the new
    // diagram on the next render.
  };
  const close = () => setFindOpen(false);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) prev();
      else next();
      return;
    }
  };

  return (
    // Absolute, not fixed: this panel belongs to the editor pane, so with the
    // right dock open it has to stop at the dock's edge rather than float
    // over it. In the narrow layout it also has to clear the toolbar's second
    // row (top 58 + 44 high), which is where it used to land on top of it.
    <div
      className="absolute top-[calc(var(--vellum-second-row-top,58px)+54px)] pane-wide:top-[var(--vellum-second-row-top,58px)] right-[14px] z-[40] float p-3 w-[calc(320px*var(--vellum-text-scale,1))] max-w-[calc(100%-28px)]"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[12px] font-semibold text-fg flex-1">Find</span>
        <button
          onClick={() => setShowReplace((v) => !v)}
          className="text-[10px] text-fg-muted hover:text-fg"
          title="Toggle replace"
        >
          {showReplace ? 'Hide replace' : 'Replace…'}
        </button>
        <button
          onClick={close}
          className="text-fg-muted hover:text-fg text-[14px] leading-none"
          aria-label="Close"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>
      <div className="flex items-center gap-1 mb-2">
        <input
          ref={findRef}
          value={find}
          onChange={(e) => {
            setFind(e.target.value);
            setCursor(0);
          }}
          placeholder="Find in diagram"
          className="flex-1 px-2 py-[5px] rounded-md bg-bg-subtle border border-border text-[12px] text-fg outline-none focus:border-accent"
        />
        <button
          onClick={() => setMatchCase((v) => !v)}
          title="Match case"
          className={`px-[6px] py-[3px] rounded-md text-[10px] border ${
            matchCase
              ? 'bg-accent-deep text-white border-accent-emphasis'
              : 'bg-bg-subtle text-fg-muted border-border hover:text-fg'
          }`}
        >
          Aa
        </button>
      </div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-fg-muted">
          {find
            ? matches.length === 0
              ? 'No matches'
              : `${cursor + 1} of ${matches.length}`
            : ' '}
        </span>
        <div className="flex gap-1">
          <button
            onClick={prev}
            disabled={matches.length === 0}
            className="px-[8px] py-[3px] rounded-md text-[11px] bg-bg-subtle border border-border text-fg hover:bg-bg-emphasis disabled:opacity-40 disabled:cursor-not-allowed"
            title="Previous match (Shift+Enter)"
          >
            ‹
          </button>
          <button
            onClick={next}
            disabled={matches.length === 0}
            className="px-[8px] py-[3px] rounded-md text-[11px] bg-bg-subtle border border-border text-fg hover:bg-bg-emphasis disabled:opacity-40 disabled:cursor-not-allowed"
            title="Next match (Enter)"
          >
            ›
          </button>
        </div>
      </div>
      {matches[cursor] && (
        <div className="text-[10px] text-fg-muted mb-2 px-2 py-[5px] rounded-md bg-bg-subtle border border-border truncate">
          {matches[cursor].snippet}
        </div>
      )}
      {showReplace && (
        <>
          <div className="flex items-center gap-1 mb-2">
            <input
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder="Replace with"
              className="flex-1 px-2 py-[5px] rounded-md bg-bg-subtle border border-border text-[12px] text-fg outline-none focus:border-accent"
            />
          </div>
          <div className="flex justify-end">
            <button
              onClick={doReplace}
              disabled={matches.length === 0 || !find}
              className="px-3 py-[5px] rounded-md text-[11px] text-white bg-accent-deep border border-accent-emphasis hover:bg-accent-emphasis disabled:opacity-40 disabled:cursor-not-allowed"
              title="Replace every match"
            >
              Replace all
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function shapeCenter(sh: Shape | undefined): { x: number; y: number } | null {
  if (!sh) return null;
  return { x: sh.x + sh.w / 2, y: sh.y + sh.h / 2 };
}

function connectorCenter(
  c: Connector | undefined,
  shapes: Shape[],
): { x: number; y: number } | null {
  if (!c) return null;
  const ep = (e: Connector['from']): { x: number; y: number } | null => {
    if ('x' in e) return { x: e.x, y: e.y };
    const sh = shapes.find((s) => s.id === e.shape);
    return sh ? { x: sh.x + sh.w / 2, y: sh.y + sh.h / 2 } : null;
  };
  const a = ep(c.from);
  const b = ep(c.to);
  if (a && b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return a ?? b;
}
