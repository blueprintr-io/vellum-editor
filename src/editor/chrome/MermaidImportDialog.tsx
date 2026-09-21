/* Paste-Mermaid-source dialog.
 *
 * Mermaid source almost always is in a chat / GitHub README / docs page
 * rather than on disk, so the import flow is paste-driven. The imported
 * shapes are MERGED into the active diagram (not replacing it) and
 * wrapped in an outer "Imported from Mermaid" container so the user can
 * drag the graph as a unit and tell at a glance which content came
 * from which import. Multiple imports stack vertically, each in its own
 * outer container.
 *
 * No file picker variant: if a user has a `.mmd` on disk, "open it in any
 * text editor → ⌘C → paste here" is one extra step but covers every case
 * including markdown code blocks (the parser strips ```mermaid fences). */

import { useEffect, useRef, useState } from 'react';
import { useEditor, newId } from '@/store/editor';
import { mermaidToDiagram } from '@/lib/mermaid';
import type { Connector, Shape } from '@/store/types';
import { DialogShell } from './ui/DialogShell';
import { Button } from './ui/Button';

/** Parse the source, then translate the parser's stable internal ids
 *  into per-import-unique ones (so a second import doesn't collide with
 *  the first), shift the bbox below any existing canvas content, and
 *  prepend an outer container that wraps every top-level shape. */
function buildImportFragment(source: string): {
  shapes: Shape[];
  connectors: Connector[];
} {
  const diagram = mermaidToDiagram(source);
  // Per-import id prefix so repeat imports never collide on `mmd-${id}`.
  const stamp = newId('imp').slice(4); // drop the "imp-" the helper added
  const remap = new Map<string, string>();
  for (const s of diagram.shapes) remap.set(s.id, `${s.id}-${stamp}`);

  // Offset: drop below whatever the user already has on the active
  // diagram so the new import doesn't overlap. If the canvas is empty,
  // start at the layout's natural origin.
  const existing = useEditor.getState().diagram.shapes;
  let dropY = 0;
  if (existing.length > 0) {
    const maxY = existing.reduce(
      (m, s) => Math.max(m, s.y + s.h),
      Number.NEGATIVE_INFINITY,
    );
    dropY = maxY + IMPORT_DROP_GAP;
  }
  // Compute the import's bbox so the outer wrapper hugs it tightly. Use
  // the parser's coords (pre-shift) so we don't double-count dropY.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const s of diagram.shapes) {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.w);
    maxY = Math.max(maxY, s.y + s.h);
  }
  // Translate to canvas origin (parser leaves a 40px margin around its
  // dagre output) and then to dropY so the import lands cleanly below.
  const shiftX = -minX + 80;
  const shiftY = -minY + dropY + 80;

  const wrapperId = `mmd-import-${stamp}`;
  const shapes: Shape[] = diagram.shapes.map((s) => {
    const next: Shape = {
      ...s,
      id: remap.get(s.id) ?? s.id,
      x: s.x + shiftX,
      y: s.y + shiftY,
    };
    if (s.parent && remap.has(s.parent)) {
      next.parent = remap.get(s.parent)!;
    } else {
      // Top-level imported shape - parent it to the outer wrapper so the
      // user can drag the import as a single unit.
      next.parent = wrapperId;
    }
    return next;
  });

  // The outer container. Sized to hug the shifted bbox of the import
  // with IMPORT_OUTER_PAD of breathing room on every side, so its label
  // strip doesn't crowd the topmost child.
  const wrapper: Shape = {
    id: wrapperId,
    kind: 'container',
    x: minX + shiftX - IMPORT_OUTER_PAD,
    y: minY + shiftY - IMPORT_OUTER_PAD,
    w: maxX - minX + IMPORT_OUTER_PAD * 2,
    h: maxY - minY + IMPORT_OUTER_PAD * 2,
    label: diagram.meta.title ?? 'Imported from Mermaid',
    layer: 'blueprint',
    strokeStyle: 'dashed',
  };

  // Wrapper renders behind its members (file order = paint order, mostly
  // - addFragment also stamps z so the wrapper gets the lowest z of the
  // batch, keeping it visually behind).
  const allShapes = [wrapper, ...shapes];

  // Translate connector endpoints to the new ids while PRESERVING any
  // fractional anchors the parser assigned for parallel-edge separation.
  // (Forcing anchor='auto' here would collapse parallel edges back into
  // a single overlapping bundle.)
  const connectors: Connector[] = [];
  for (const c of diagram.connectors) {
    if (!('shape' in c.from) || !('shape' in c.to)) continue;
    const from = remap.get(c.from.shape);
    const to = remap.get(c.to.shape);
    if (!from || !to) continue;
    connectors.push({
      ...c,
      id: `${c.id}-${stamp}`,
      from: { shape: from, anchor: c.from.anchor },
      to: { shape: to, anchor: c.to.anchor },
    });
  }
  return { shapes: allShapes, connectors };
}

const PLACEHOLDER = `flowchart TD
  A[Start] --> B{Is it valid?}
  B -->|Yes| C[Process]
  B -->|No| D[Reject]
  C --> E((End))
  D --> E`;

/** Padding around the imported group's bbox. The outer "Imported from
 *  Mermaid" container sits this far outside the layout's tightest hull
 *  on every side. */
const IMPORT_OUTER_PAD = 40;
/** Vertical gap between existing canvas content and the freshly imported
 *  fragment. Just large enough to avoid touching connectors that already
 *  hug the bottom of the prior content. */
const IMPORT_DROP_GAP = 80;

export function MermaidImportDialog({ onClose }: { onClose: () => void }) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pasteState, setPasteState] = useState<'idle' | 'pasted'>('idle');

  // Auto-focus the textarea so the user can paste immediately on open.
  useEffect(() => {
    taRef.current?.focus();
  }, []);

  const importNow = () => {
    if (!text.trim()) {
      setError('Paste some Mermaid source first.');
      return;
    }
    try {
      const fragment = buildImportFragment(text);
      useEditor.getState().addFragment(fragment.shapes, fragment.connectors);
      onClose();
    } catch (e) {
      setError((e as Error).message ?? String(e));
    }
  };

  const pasteFromClipboard = async () => {
    try {
      const fromClip = await navigator.clipboard.readText();
      if (!fromClip) {
        setError('Clipboard is empty.');
        return;
      }
      setText(fromClip);
      setError(null);
      setPasteState('pasted');
      setTimeout(() => setPasteState('idle'), 1200);
    } catch (e) {
      // Some browsers gate clipboard.readText behind a user-gesture +
      // permission prompt; fall back to telling the user to paste manually.
      setError(
        `Couldn't read clipboard automatically - paste with ⌘V / Ctrl+V instead. (${(e as Error).message ?? e})`,
      );
    }
  };

  return (
    <DialogShell
      onClose={onClose}
      title="Import Mermaid"
      subtitle="Paste Mermaid source - flowchart / graph / stateDiagram. Subgraphs become containers."
      panelClassName="w-[min(820px,92vw)] max-h-[88vh] flex flex-col p-4"
      contentClassName="flex flex-col gap-3 flex-1 min-h-0"
    >
      <textarea
          ref={taRef}
          value={text}
          placeholder={PLACEHOLDER}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          spellCheck={false}
          className="flex-1 min-h-[300px] font-mono text-[12px] leading-relaxed text-fg bg-bg-subtle border border-border rounded-md p-3 resize-none outline-none focus:border-accent placeholder:text-fg-muted/60"
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter applies. Power-user shortcut so heavy paste users
            // don't reach for the mouse to commit.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              importNow();
              return;
            }
            // Tab inserts two spaces rather than escaping focus.
            if (e.key === 'Tab' && !e.shiftKey) {
              e.preventDefault();
              const ta = e.currentTarget;
              const { selectionStart: s, selectionEnd: end } = ta;
              const next = `${text.slice(0, s)}  ${text.slice(end)}`;
              setText(next);
              requestAnimationFrame(() => {
                ta.setSelectionRange(s + 2, s + 2);
              });
            }
          }}
        />
        {error && (
          <div className="text-[11px] text-red-400 font-mono whitespace-pre-wrap break-words">
            {error}
          </div>
        )}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] text-fg-muted">
          Tip: Mermaid in a <code className="font-mono">```mermaid</code> code block works too - fences are stripped.
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={pasteFromClipboard}>
            {pasteState === 'pasted' ? 'Pasted!' : 'Paste from clipboard'}
          </Button>
          <Button variant="primary" onClick={importNow}>
            Import
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}
