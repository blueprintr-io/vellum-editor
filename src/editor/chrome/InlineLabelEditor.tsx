import { rackTextLayout } from '@/editor/rack/text-layout';
import { calloutTextBox, notationTextRegions } from '@/editor/notation/geometry';
import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@/store/editor';
import type { TextDirection } from '@/store/types';
import { resolveSwatchColor } from '@/editor/swatches';
import {
  TEXT_BOX_PAD_X,
  isVerticalDir,
  verticalTextStyle,
} from '@/editor/canvas/measure-text';
import {
  domToMd,
  insertLineBreakAtCaret,
  mdToHtml,
} from '@/lib/inline-marks';
import { FontPicker } from './inspector/FontPicker';
import { FontSizeField, SwatchRow } from './inspector/StyleControls';
import type { LabelAnchor } from '@/store/types';

/** Anchors that hang the text OFF the bbox. Mirrors the set in Shape.tsx -
 * those slots render as a plain SVG `<text>`, which never wraps and is free
 *  to overflow the shape, so the editor may widen itself to match. */
function isOutsideAnchor(a: LabelAnchor): boolean {
  return (
    a === 'above' ||
    a === 'below' ||
    a === 'left' ||
    a === 'right' ||
    a === 'outside-top-left' ||
    a === 'outside-top-right' ||
    a === 'outside-bottom-left' ||
    a === 'outside-bottom-right'
  );
}

/** Inline label editor - pops over the canvas at the editing shape's position
 *  and commits the label on blur or Enter. Listens for `vellum:edit-shape`
 *  CustomEvents (dispatched by Canvas's double-click handler).
 *
 *  The editor uses a `contenteditable` div (not a `<textarea>`) so we can
 *  vertically center the text via flexbox - that way the cursor sits at the
 *  same baseline the rendered label uses, and committing doesn't visibly jump
 *  the text from the top of the shape to the middle. */
export function InlineLabelEditor() {
  const [editingId, setLocalEditingId] = useState<string | null>(null);
  const setEditingShapeId = useEditor((s) => s.setEditingShapeId);
  // Mirror the local editing id into the store so Shape.tsx can suppress
  // its underlying label/body while the inline editor is overlaying it.
  // Without that suppression the editor's transparent background shows
  // the committed text painted underneath, producing a ghosted-double of
  // the typing cursor and making colour previews look wrong.
  const setEditingId = (id: string | null) => {
    setLocalEditingId(id);
    setEditingShapeId(id);
  };
  // The store's three edit pointers (shape / connector / cell) are mutually
  // exclusive - opening any one nulls the other two. Watch ours so this
  // component's session can follow when another editor takes over.
  const storeEditingShapeId = useEditor((s) => s.editingShapeId);
  const editorRef = useRef<HTMLDivElement | null>(null);
  // The toolbar holds its own elements (font picker, size input, swatches).
  // Focus shifts into any of them must NOT trigger the editor's commit-on-
  // blur - otherwise clicking the size input would unmount the flyout before
  // the user could type. We share a ref so onBlur can check containment.
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  // Snapshot of the text at edit-open so Escape can revert. Text shapes write
  // their edits to the store live (per keystroke), so "cancel" must restore
  // this value, not merely close the editor.
  const originalRef = useRef('');

  const update = useEditor((s) => s.updateShape);
  // The editing session is ONE undo step: keystrokes write live (below),
  // commit seals them, Escape rewinds them.
  const commitHistory = useEditor((s) => s.commitHistory);
  const cancelHistory = useEditor((s) => s.cancelHistory);
  const discardEmptyTextShape = useEditor((s) => s.discardEmptyTextShape);
  // Live mutation path - used by kind:'text' to write the typed string on
  // every keystroke so the store's autoFit can re-measure and the editor's
  // bbox grows under the user's cursor. Goes through
  // updateShapeLive (no _snapshot) so a paragraph of typing doesn't
  // produce a 200-step undo history.
  const updateLive = useEditor((s) => s.updateShapeLive);
  // Empty-text cleanup removes exactly one shape in one history step,
  // independent of what the selection happens to be at that moment.
  const setPan = useEditor((s) => s.setPan);
  const shape = useEditor((s) =>
    editingId ? s.diagram.shapes.find((sh) => sh.id === editingId) ?? null : null,
  );
  // Container labels anchor right of the icon child, so the inline editor
  // needs to follow. Mirror Shape.tsx: only count `kind === 'icon'`
  // children; non-icon children (nested containers, images, groups) don't
  // get the right-of-icon treatment, and the editor falls back to the
  // top-left "where the icon would have been" slot.
  const containerChild = useEditor((s) => {
    if (shape?.kind !== 'container') return null;
    if (shape.anchorId !== undefined) {
      const a = s.diagram.shapes.find((sh) => sh.id === shape.anchorId);
      if (a && a.parent === shape.id && a.kind === 'icon') return a;
      // Stale anchorId (icon was deleted) - don't silently re-anchor onto
      // some other icon-kind child. Mirror Shape.tsx's strict treatment.
      return null;
    }
    // Legacy fallback for diagrams pre-anchorId.
    return (
      s.diagram.shapes.find(
        (sh) => sh.parent === shape.id && sh.kind === 'icon',
      ) ?? null
    );
  });
  const pan = useEditor((s) => s.pan);
  const zoom = useEditor((s) => s.zoom);

  // Latest `commit` closure, so the imperative commit channel below can
  // flush the editor without going through DOM focus. Assigned during
  // render (both branches) because `commit` closes over `shape`, which
  // changes every render - an effect would lag a frame behind a
  // pointerdown that lands in the same tick.
  const commitRef = useRef<(() => void) | null>(null);
  // Guards against a double-commit when BOTH the imperative channel and a
  // trailing DOM blur fire for the same edit. Cleared on every open.
  const committedRef = useRef(false);

  // Listen for the canvas's double-click signal.
  useEffect(() => {
    const onEdit = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      const sh = useEditor.getState().diagram.shapes.find((s) => s.id === id);
      if (!sh) return;
      // Switching straight from one shape to another (double-clicking B
      // while A is open) must not silently drop A's edit.
      commitRef.current?.();
      committedRef.current = false;
      setEditingId(id);
    };
    window.addEventListener('vellum:edit-shape', onEdit);
    return () => window.removeEventListener('vellum:edit-shape', onEdit);
  }, []);

  // Imperative commit channel. The editor used to rely SOLELY on the
  // contenteditable's onBlur to persist an edit, with the canvas nudging it
  // along via `document.activeElement.blur()`. That silently lost the edit
  // whenever focus had already moved off the contenteditable - most easily
  // by touching the floating text toolbar's font-size input, which takes
  // actual focus and is deliberately exempt from commit-on-blur. Blurring the
  // size input then fires nothing at all: the pending text sat in the DOM,
  // the click was swallowed by the canvas's exit-editor branch, and the
  // next thing the user did threw the edit away. Anything that wants the
  // editor flushed now says so directly.
  useEffect(() => {
    const onCommitRequest = () => commitRef.current?.();
    window.addEventListener('vellum:commit-inline-edit', onCommitRequest);
    return () =>
      window.removeEventListener('vellum:commit-inline-edit', onCommitRequest);
  }, []);

  // If the editor unmounts while still flagged as editing - e.g. a hot
  // reload, or a parent route swap - reset the store flag so the
  // suppressed shape's label paints again. Otherwise the user's previously-
  // edited shape would render with no visible text on the next mount.
  useEffect(() => {
    return () => {
      useEditor.getState().setEditingShapeId(null);
    };
  }, []);

  // Self-heal a stranded edit session. If the shape being edited leaves the
  // diagram mid-edit - a diagram-tab switch, file open, undo, or an "edit
  // with AI" replace - the render below bails and nothing is on screen, but
  // `editingShapeId` stays latched in the store. Canvas's pointer-down reads
  // that flag as "an editor is open" and returns before ANY selection logic,
  // so the canvas freezes: clicking another shape stops changing the
  // selection and Delete stops working, with no visible editor to explain
  // why. Dropping the pointer as soon as its target is gone releases it.
  useEffect(() => {
    if (editingId && !shape) setEditingId(null);
    // setEditingId is re-created every render; the id/shape pair is the
    // actual trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, shape]);

  // Stand down when another inline editor takes over - a connector label or
  // a table cell. The store drops our pointer as part of opening theirs, but
  // the local session is what actually RENDERS, so without this the
  // contenteditable stayed mounted over the shape: an invisible overlay that
  // swallowed every click landing on it, leaving that shape impossible to
  // select or deselect by clicking. Flush first so pending text isn't lost.
  useEffect(() => {
    if (editingId && storeEditingShapeId !== editingId) {
      commitRef.current?.();
      setLocalEditingId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, storeEditingShapeId]);

  // Surface the line-break tip for as long as the editor is open. On every
  // kind but `text`, a bare Enter finishes the edit - so ⇧Enter is the only
  // way to add a second line, and nothing on screen said so. Goes through
  // the same quiet bottom-of-canvas toast every other gesture hint uses, so
  // it inherits the global tips toggle.
  useEffect(() => {
    if (!editingId) return;
    useEditor.getState().setActiveTipKey('label-edit-newline');
    return () => {
      if (useEditor.getState().activeTipKey === 'label-edit-newline') {
        useEditor.getState().setActiveTipKey(null);
      }
    };
  }, [editingId]);

  // Which field should this kind's inline editor mutate? Body-bearing shapes
  // (rect/ellipse/diamond/note/service) keep typing as their wrapping interior
  // body - distinct from `label`, which always renders at the anchor. That
  // keeps "the label of this container" separate from "the words inside this
  // box," which is the user's mental model.
  const writesToBody =
    !!shape && !shape.rackUnit &&
    (shape.kind === 'rect' ||
      shape.kind === 'ellipse' ||
      shape.kind === 'diamond' ||
      shape.kind === 'polygon' ||
      shape.kind === 'note' ||
      shape.kind === 'service');
  const editingField: 'label' | 'body' = writesToBody ? 'body' : 'label';

  // Text orientation is offered for `kind: 'text'` shapes and for the
  // interior body of basic body-bearing kinds - the same set Shape.tsx
  // honours `textDirection` on. Drives both the toolbar control and the
  // contenteditable's own writing-mode while typing.
  const supportsDir = !!shape && (shape.kind === 'text' || writesToBody);
  const editorVStyle = verticalTextStyle(
    supportsDir ? shape?.textDirection : undefined,
  );

  // On mount, seed the editor with the current label/body, focus, place caret
  // at end, and select-all so a fresh type replaces the existing text. For
  // empty values we seed a zero-width space and select it - that way the
  // browser's caret has an actual glyph to anchor against (otherwise it pins to
  // the top edge of the contenteditable until typing starts).
  useEffect(() => {
    if (!editingId || !editorRef.current || !shape) return;
    const el = editorRef.current;
    // Arm the commit guard for this edit session. Covers every way the
    // editor can be opened, not just the `vellum:edit-shape` handler.
    committedRef.current = false;
    const initial = (writesToBody ? shape.body : shape.label) ?? '';
    originalRef.current = initial;
    if (initial === '') {
      // Zero-width space → caret centres correctly on first focus.
      el.textContent = '​';
    } else {
      // Convert stored markdown markers (**/`__`/`*`) to inline-formatted
      // HTML so bold / italic / underline survive a re-edit. Sanitised at
      // emit - the helper only ever produces b/i/u/br tags + escaped text.
      el.innerHTML = mdToHtml(initial);
    }
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // editingId only - we don't want this to re-run when the live shape state
    // changes (every keystroke triggers an update via the parent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  // Auto-pan to keep the editor visible while typing. Without this, a text
  // shape near the bottom edge grows downward as newlines are added, the
  // editor's bbox extends past the viewport, and the cursor "escapes" the
  // canvas - the user is typing into a region they can't see. Same trick
  // word processors use: nudge the canvas so the editor's
  // edges stay on-screen with a small margin.
  //
  // MUST sit above the early-return below - moving it below would change
  // the hook count between "no editing shape" (skipped) and "editing"
  // (called), which violates the Rules of Hooks and crashes the app.
  // We use shape.x/y/w/h rather than the per-anchor worldX/Y/W/H computed
  // further down because (a) it's good enough - the only kind that grows
  // during edit is `text`, whose world coords match shape coords, and (b)
  // the anchor-routed slot is inside or beside the shape bbox, so
  // keeping the shape on screen keeps the editor on screen too.
  //
  // Effect deps deliberately exclude `pan`: we react to bbox growth (during
  // typing), not to manual canvas panning. If the user pans away mid-edit
  // and then types again, the next keystroke that resizes the bbox will
  // re-pan the canvas to follow the cursor - which is the desired UX.
  useEffect(() => {
    if (!editingId || !shape) return;
    if (typeof window === 'undefined') return;
    // Margins clear the floating chrome that is at the viewport edges
    // (text toolbar above the editor, dock row at the bottom) without
    // needing to measure each panel's exact height.
    const TOP_MARGIN = 60;
    const BOTTOM_MARGIN = 80;
    const SIDE_MARGIN = 24;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const top = shape.y * zoom + pan.y;
    const bottom = (shape.y + shape.h) * zoom + pan.y;
    const left = shape.x * zoom + pan.x;
    const right = (shape.x + shape.w) * zoom + pan.x;
    let dx = 0;
    let dy = 0;
    if (bottom > vh - BOTTOM_MARGIN) {
      dy = -(bottom - (vh - BOTTOM_MARGIN));
    } else if (top < TOP_MARGIN) {
      // Only nudge up when the top is clipped AND the bottom would still
      // fit - otherwise we thrash between the two clamps when the editor
      // is taller than the viewport (rare but possible at high zoom).
      const want = TOP_MARGIN - top;
      const room = vh - BOTTOM_MARGIN - bottom;
      dy = Math.min(want, Math.max(0, room));
    }
    if (right > vw - SIDE_MARGIN) {
      dx = -(right - (vw - SIDE_MARGIN));
    } else if (left < SIDE_MARGIN) {
      const want = SIDE_MARGIN - left;
      const room = vw - SIDE_MARGIN - right;
      dx = Math.min(want, Math.max(0, room));
    }
    if (dx !== 0 || dy !== 0) {
      setPan({ x: pan.x + dx, y: pan.y + dy });
    }
    // pan deliberately omitted - see comment block above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, shape?.x, shape?.y, shape?.w, shape?.h, zoom]);

  if (!editingId || !shape) {
    commitRef.current = null;
    return null;
  }

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    // Walk the contenteditable's DOM to capture inline marks (b/i/u) as
    // markdown tokens. innerText would drop them, which was the original
    // "format buttons don't commit" bug - the marks rendered live but
    // never made it past the contenteditable boundary.
    const next = domToMd(editorRef.current);
    // Plain-text view of the result for "is it really empty?" checks. We
    // can't trim `next` directly because the markers aren't whitespace and
    // a label of just "**" should be treated as empty.
    const plain = next.replace(/\*\*|__|\*/g, '');
    // Empty text shape committed → delete it. A `text` shape with no label is
    // visually invisible but still hit-testable, which surprised the user when
    // a stray double-click left an empty hit zone behind. The kind 'text'
    // check is intentional: emptying a rect/note's body just removes the
    // text but keeps the shape; emptying a text-tool drop should remove it.
    if (shape.kind === 'text' && plain.trim() === '') {
      setEditingId(null);
      // Delete by id rather than routing through the selection. The old path
      // selected the shape and deferred `deleteSelection()` one tick - but
      // the pointer-down that closes the editor keeps running after this
      // commit returns, and a click on empty canvas clears the selection
      // synchronously (Canvas's exit-editor branch). The deferred delete
      // then found an empty selection and no-op'd, stranding an invisible
      // but still hit-testable empty text box on the canvas. Removing the
      // shape by id lands the same single history step regardless of what
      // the selection does afterwards. discardEmptyTextShape also drops the
      // session's live writes first and, for a text-tool click the user
      // then abandoned, unwinds the creation instead of stacking a delete
      // on it - so Cmd+Z never has to "restore" an invisible empty box.
      discardEmptyTextShape(shape.id);
      return;
    }
    const current = (writesToBody ? shape.body : shape.label) ?? '';
    const finalValue = plain.trim() === '' ? '' : next;
    // Fold the final value into the live editing session (text shapes have
    // been writing per keystroke; other kinds write here for the first
    // time) and seal the session as ONE undo step. commitHistory is
    // a no-op when nothing was written, so click-in / click-out records
    // nothing. Text shapes used to skip this entirely - their live writes
    // matched the final value, so the atomic update never ran and the
    // typing was left un-sealed for the NEXT edit to swallow.
    if (current !== finalValue) {
      updateLive(shape.id, {
        [editingField]: finalValue || undefined,
      } as Partial<typeof shape>);
    }
    commitHistory();
    setEditingId(null);
  };
  commitRef.current = commit;
  const cancel = () => {
    // Latch the same guard commit uses: a trailing blur after Escape must
    // not resurrect the reverted text.
    committedRef.current = true;
    // Escape reverts. Text shapes wrote their edits to the store live (per
    // keystroke via onInput), so restore the value captured at edit-open;
    // other kinds never touched the store, so closing is enough. This makes
    // Escape consistent across shape kinds and matches the universal "Escape
    // abandons my edits" convention.
    if (shape.kind === 'text') {
      // A text shape that was already empty when the editor opened is an
      // abandoned drop (double-click on blank canvas, or a bare text-tool
      // click). Reverting it to empty would leave the same invisible-but-
      // hit-testable box the empty-commit path deletes, so take the same
      // exit - Escape and click-away should not disagree about whether an
      // untouched text box survives.
      if (originalRef.current.trim() === '') {
        setEditingId(null);
        discardEmptyTextShape(shape.id);
        return;
      }
      // Rewind the session's live writes: the store restores the diagram it
      // captured before the first keystroke and records nothing. If a
      // toolbar action mid-session (font change etc.) already sealed part
      // of the typing, that part is a recorded edit - put the opening text
      // back on top of it as one explicit step.
      cancelHistory();
      const now = useEditor
        .getState()
        .diagram.shapes.find((s) => s.id === shape.id);
      const nowText = (writesToBody ? now?.body : now?.label) ?? '';
      if (nowText !== originalRef.current) {
        updateLive(shape.id, {
          [editingField]: originalRef.current,
        } as Partial<typeof shape>);
        commitHistory();
      }
    }
    setEditingId(null);
  };

  // Project shape world coords to screen coords. We then nudge the editor's
  // box so it visually sits where the *rendered* label/body will land - that
  // way the text doesn't visibly jump on commit. Per-anchor logic mirrors
  // computeLabelLayout in Shape.tsx; keep them in sync.
  //
  // The inline editor mirrors the committed text's position: typing happens
  // exactly where the rendered label/body will land so commit doesn't visibly
  // jump. For body-bearing kinds (rect/ellipse/diamond/note/service), body
  // now honours `labelAnchor` for the inside anchors (center + corners) -
  // see Shape.tsx's `bodyAlign`. Outside anchors (above/below/left/right)
  // remain heading-only; the body collapses to centred for those, so the
  // editor follows suit. Without this branching, switching the anchor to a
  // corner would commit the body into that corner but the editor would
  // still hover at centre, producing a visible jump on commit.
  // Outside anchors hang the label OFF the bbox. For body-bearing kinds
  // (rect/ellipse/diamond/note/service) the renderer "promotes" body→label-
  // position when an outside anchor is picked + no separate label is set -
  // see Shape.tsx promoteBodyToLabel. The editor mirrors that promotion: it
  // positions OUTSIDE for these gestures so what the user types appears
  // exactly where commit will paint it. Inside-* edge midpoints stay within
  // the bbox and keep the editor inside.
  const rawAnchor =
    shape.labelAnchor ??
    (shape.kind === 'icon' || shape.kind === 'image'
      ? 'below'
      : shape.kind === 'container'
        ? 'right-of-icon'
        : 'center');
  const anchor = rawAnchor;

  let worldX = shape.x;
  let worldY = shape.y;
  let worldW = shape.w;
  let worldH = shape.h;

  if (anchor === 'below') {
    // A box slightly wider than the body so multi-word labels don't cramp.
    worldX = shape.x - shape.w * 0.15;
    worldY = shape.y + shape.h + 4;
    worldW = shape.w * 1.3;
    worldH = Math.max(shape.h * 0.5, 22);
  } else if (anchor === 'above') {
    worldX = shape.x - shape.w * 0.15;
    worldY = shape.y - Math.max(shape.h * 0.5, 22) - 4;
    worldW = shape.w * 1.3;
    worldH = Math.max(shape.h * 0.5, 22);
  } else if (anchor === 'right') {
    worldX = shape.x + shape.w + 4;
    worldY = shape.y + shape.h / 2 - 12;
    worldW = Math.max(shape.w, 80);
    worldH = 24;
  } else if (anchor === 'left') {
    worldX = shape.x - Math.max(shape.w, 80) - 4;
    worldY = shape.y + shape.h / 2 - 12;
    worldW = Math.max(shape.w, 80);
    worldH = 24;
  } else if (anchor === 'right-of-icon') {
    if (containerChild) {
      const cw = Math.abs(containerChild.w);
      const ch = Math.abs(containerChild.h);
      worldX = containerChild.x + cw + 8;
      worldY = containerChild.y + ch / 2 - 14;
      worldW = Math.max(shape.w - cw - 24, 100);
      worldH = 28;
    } else {
      // Mirror Shape.tsx's "no icon" fallback: editor sits where the icon
      // WOULD render (top-left corner of the container, after the virtual
      // 12px pad + 40px icon slot) so what the user types lands exactly
      // where the committed text will paint.
      const PAD = 12;
      const ANCHOR_ICON_SIZE = 40;
      worldX = shape.x + PAD + ANCHOR_ICON_SIZE + 8;
      worldY = shape.y + PAD + ANCHOR_ICON_SIZE / 2 - 14;
      worldW = Math.max(shape.w - PAD - ANCHOR_ICON_SIZE - 24, 100);
      worldH = 28;
    }
  } else if (
    anchor === 'outside-top-left' ||
    anchor === 'outside-top-right' ||
    anchor === 'outside-bottom-left' ||
    anchor === 'outside-bottom-right'
  ) {
    // Hanging-off-the-corner label slot - sized like above/below so wrap
    // width is forgiving but anchored at the matching exterior corner.
    // Body-bearing kinds don't reach this branch; isOutsideAnchor() above
    // collapses them to 'center'. Only label-only kinds (text / icon /
    // image / container) end up here.
    const slotW = Math.max(shape.w * 1.0, 100);
    const slotH = Math.max(shape.h * 0.45, 22);
    if (anchor === 'outside-top-left') {
      worldX = shape.x - slotW - 4;
      worldY = shape.y - slotH - 4;
    } else if (anchor === 'outside-top-right') {
      worldX = shape.x + shape.w + 4;
      worldY = shape.y - slotH - 4;
    } else if (anchor === 'outside-bottom-left') {
      worldX = shape.x - slotW - 4;
      worldY = shape.y + shape.h + 4;
    } else {
      worldX = shape.x + shape.w + 4;
      worldY = shape.y + shape.h + 4;
    }
    worldW = slotW;
    worldH = slotH;
  } else if (
    anchor === 'top-left' ||
    anchor === 'top-right' ||
    anchor === 'bottom-left' ||
    anchor === 'bottom-right' ||
    anchor === 'inside-top' ||
    anchor === 'inside-bottom' ||
    anchor === 'inside-left' ||
    anchor === 'inside-right'
  ) {
    if (writesToBody) {
      // Body-bearing kinds (rect/ellipse/diamond/note/service): the editor
      // covers the FULL shape bbox so wrap-width matches Shape.tsx's
      // bodyEl. Corner / inside-edge alignment is handled via flex axes
      // (justifyContent / textAlign) below - same axes the bodyEl uses,
      // so commit doesn't visibly jump the text.
      worldX = shape.x;
      worldY = shape.y;
      worldW = shape.w;
      worldH = shape.h;
    } else {
      // Single-line label tucked into the picked cell. Corner anchors get
      // half the bbox of typing room (so the editor doesn't visually cross
      // into the opposite half); inside-edge anchors get the full width
      // (top/bottom) or full height (left/right) along their long axis,
      // matching where the rendered <text> is.
      worldH = 26;
      if (anchor === 'inside-top') {
        worldX = shape.x + 4;
        worldY = shape.y + 4;
        worldW = Math.max(shape.w - 8, 80);
      } else if (anchor === 'inside-bottom') {
        worldX = shape.x + 4;
        worldY = shape.y + shape.h - worldH - 4;
        worldW = Math.max(shape.w - 8, 80);
      } else if (anchor === 'inside-left') {
        worldX = shape.x + 4;
        worldY = shape.y + shape.h / 2 - 13;
        worldW = Math.max(shape.w / 2 - 12, 80);
      } else if (anchor === 'inside-right') {
        const slotW = Math.max(shape.w / 2 - 12, 80);
        worldX = shape.x + shape.w - slotW - 4;
        worldY = shape.y + shape.h / 2 - 13;
        worldW = slotW;
      } else {
        const slotW = Math.max(shape.w / 2 - 12, 80);
        worldW = slotW;
        if (anchor === 'top-left') {
          worldX = shape.x + 4;
          worldY = shape.y + 4;
        } else if (anchor === 'top-right') {
          worldX = shape.x + shape.w - slotW - 4;
          worldY = shape.y + 4;
        } else if (anchor === 'bottom-left') {
          worldX = shape.x + 4;
          worldY = shape.y + shape.h - worldH - 4;
        } else {
          worldX = shape.x + shape.w - slotW - 4;
          worldY = shape.y + shape.h - worldH - 4;
        }
      }
    }
  }

  // Native titles and callout text share the renderer's layout bounds.
  const rackText = shape.kind === 'rack' || shape.rackUnit ? rackTextLayout(shape) : undefined;
  const nativeTitle = shape.notation ? notationTextRegions(shape).find(r=>r.role==='title') : undefined;
  const nativeBox = rackText ?? nativeTitle ?? (shape.polygonPreset === 'callout' && anchor === 'center' ? calloutTextBox(shape) : undefined);
  if (nativeBox) { worldX=nativeBox.x; worldY=nativeBox.y; worldW=nativeBox.w; worldH=nativeBox.h; }

  // Screen projection is deferred until after the align axes are known -
  // the "room to type" pass below still adjusts worldX / worldW.

  // Match the rendered label's typography so committing doesn't change the
  // visual size or weight. `shape.fontFamily` (set via the inspector's font
  // picker) wins over the kind-default - and because we read it here on every
  // render, swapping the font in the picker mid-edit immediately re-typesets
  // the contenteditable. Without this read the picker's change only became
  // visible after commit, since the editor's style was frozen at mount.
  const sketchy = shape.kind === 'note';
  const fontFamily =
    shape.fontFamily ?? (sketchy ? 'var(--font-sketch)' : 'var(--font-body)');
  // World-space font size - mirrors the renderer's fallback so the editor and
  // committed text agree when the user hasn't overridden via the flyout.
  const worldFontSize = rackText?.size ?? shape.fontSize ?? (sketchy ? 18 : 13);
  const fontSize = worldFontSize * zoom;
  const fontWeight = sketchy ? 400 : 500;

  // Mirror the renderer's label-colour rule (Shape.tsx) so the user sees
  // their textColor / stroke / layer-default choice live as they type -
  // previously the editor forced var(--ink) regardless, and a green
  // textColor only painted on commit, which made the swatch row feel
  // broken.
  const onNotesLayer = shape.layer === 'notes';
  // Resolve through the swatch palette so a legacy-hex stroke also drives
  // the live editor colour to the theme-aware var (matches Shape.tsx).
  const resolvedStroke = resolveSwatchColor(shape.stroke, 'stroke');
  const liveLabelColor =
    shape.textColor ??
    (nativeTitle?.inkBackground ? 'var(--paper)' : shape.kind === 'note'
      ? '#5b4a14'
      : resolvedStroke ??
        (onNotesLayer ? 'var(--notes-ink)' : 'var(--ink)'));

  // Text alignment + flex axes track the rendered label/body anchor so the
  // typing position matches what'll paint on commit. The editor's outer
  // <div> is `display: flex; flex-direction: column`, so:
  //   - main axis (vertical)  → justifyContent  (top / center / bottom)
  //   - cross axis (horizontal) → alignItems    (left / center / right)
  //   - in-line glyph flow      → textAlign
  // For label slot boxes (cardinal + right-of-icon + label corners) the
  // slot is sized so the editor lines up visually regardless of these
  // axes - they're correctness-cheap. The full-bbox body-corner case
  // (added with the labelAnchor-for-body fix) actually needs them so
  // typing happens in the same corner the body will commit to.
  let textAlign: 'left' | 'center' | 'right' = 'center';
  let justifyContent: 'flex-start' | 'center' | 'flex-end' = 'center';
  let alignItems: 'flex-start' | 'center' | 'flex-end' = 'center';
  // Vertical (column main axis) - pin to top / bottom for the matching
  // anchor cells, centred otherwise.
  if (
    anchor === 'top-left' ||
    anchor === 'top-right' ||
    anchor === 'inside-top'
  ) {
    justifyContent = 'flex-start';
  } else if (
    anchor === 'bottom-left' ||
    anchor === 'bottom-right' ||
    anchor === 'inside-bottom'
  ) {
    justifyContent = 'flex-end';
  }
  // Horizontal (column cross axis + textAlign).
  if (
    anchor === 'top-left' ||
    anchor === 'bottom-left' ||
    anchor === 'left' ||
    anchor === 'inside-left' ||
    anchor === 'right-of-icon' ||
    anchor === 'outside-top-right' ||
    anchor === 'outside-bottom-right'
  ) {
    // outside-*-right anchors live to the RIGHT of the bbox; their slot's
    // text reads naturally left-aligned, hugging the shape's edge.
    textAlign = 'left';
    alignItems = 'flex-start';
  } else if (
    anchor === 'top-right' ||
    anchor === 'bottom-right' ||
    anchor === 'right' ||
    anchor === 'inside-right' ||
    anchor === 'outside-top-left' ||
    anchor === 'outside-bottom-left'
  ) {
    // outside-*-left anchors live to the LEFT of the bbox; their slot's
    // text reads right-aligned so it ends flush with the shape edge.
    textAlign = 'right';
    alignItems = 'flex-end';
  }
  // For outside-top-* the label sits ABOVE the bbox; outside-bottom-* below.
  // Vertical axis pinning makes the typing slot bottom-flush (top-*) or
  // top-flush (bottom-*) so it visually hugs the shape edge.
  if (anchor === 'outside-top-left' || anchor === 'outside-top-right') {
    justifyContent = 'flex-end';
  } else if (
    anchor === 'outside-bottom-left' ||
    anchor === 'outside-bottom-right'
  ) {
    justifyContent = 'flex-start';
  }

  if (rackText) {
    textAlign = rackText.align;
    alignItems = rackText.align === 'left' ? 'flex-start' : 'center';
    justifyContent = 'center';
  }

  // --- Room to type -------------------------------------------------------
  //
  // Every slot above is sized for ONE line at the shape's own width, and the
  // box used to be pinned to exactly that with `overflow: hidden`. So a
  // second line simply vanished: the user pressed ⇧⏎, nothing appeared, and
  // the label looked like it had eaten the text. On a small icon there
  // wasn't even room for a long first line.
  //
  // Two changes fix that, both applied only to the label/body kinds - a
  // `kind: 'text'` shape's bbox already tracks its content through the
  // store's autoFit, so its editor is correct as-is and stays on the old
  // path.
  //
  //   1. The box GROWS with the content (`height: auto` + `minHeight`),
  //      away from whichever edge the anchor pins, so the growth direction
  //      matches where the committed text lands.
  //   2. Slots narrower than MIN_EDIT_W get widened around their alignment
  //      origin. That's accurate only where the renderer doesn't wrap - the
  //      outside anchors draw a plain <text> that overflows the bbox
  //      freely, so a wider editor matches the commit better than a
  //      cramped one does. Inside anchors wrap to the shape and keep their
  //      width.
  //
  // The pinned edge is read off `justifyContent`, which already encodes it:
  // flex-start pins the top (grow down), flex-end the bottom (grow up),
  // center pins the middle (grow both ways). The two cardinal slots that
  // don't - 'below' and 'above' centre their single line inside a slot that
  // is itself pinned to the shape's edge - are named directly, so a label
  // under an icon grows DOWNWARD, away from the icon, instead of creeping
  // back over it.
  const growFrom: 'top' | 'center' | 'bottom' =
    anchor === 'below'
      ? 'top'
      : anchor === 'above'
        ? 'bottom'
        : justifyContent === 'flex-start'
          ? 'top'
          : justifyContent === 'flex-end'
            ? 'bottom'
            : 'center';
  /** World-units floor for the typing width of a non-wrapping label slot.
   *  ~9 characters at the 13px default - enough that a word doesn't wrap
   *  mid-edit on a small icon, without ballooning over the neighbours. */
  const MIN_EDIT_W = 110;
  const widensToFit =
    shape.kind !== 'text' &&
    !writesToBody &&
    isOutsideAnchor(anchor) &&
    worldW < MIN_EDIT_W;
  if (widensToFit) {
    const extra = MIN_EDIT_W - worldW;
    // Grow away from the alignment origin so the text doesn't slide: a
    // centred slot expands both ways, a right-aligned one only leftwards.
    if (textAlign === 'center') worldX -= extra / 2;
    else if (textAlign === 'right') worldX -= extra;
    worldW = MIN_EDIT_W;
  }

  const screenX = worldX * zoom + pan.x;
  const screenY = worldY * zoom + pan.y;
  const screenW = worldW * zoom;
  const screenH = worldH * zoom;

  return (
    <>
      <FloatingTextToolbar
        editorRef={editorRef}
        toolbarRef={toolbarRef}
        screenX={screenX}
        screenY={screenY}
        screenW={screenW}
        currentFontFamily={shape.fontFamily}
        currentFontSize={worldFontSize}
        currentTextColor={shape.textColor}
        currentTextAlign={
          shape.textAlign ?? (shape.kind === 'text' ? 'center' : undefined)
        }
        // Orientation picker is surfaced for text shapes AND basic
        // body-bearing kinds (their interior body honours textDirection).
        // Anchor-positioned labels (icon/image/container) + table cells
        // always read horizontally, so they don't pass the handler.
        currentTextDirection={
          supportsDir ? shape.textDirection ?? 'horizontal' : undefined
        }
        onFontFamily={(v) => update(shape.id, { fontFamily: v })}
        onFontSize={(v) => update(shape.id, { fontSize: v })}
        onTextColor={(v) => update(shape.id, { textColor: v })}
        onTextAlign={(v) => update(shape.id, { textAlign: v })}
        onTextDirection={
          supportsDir
            ? (v) =>
                // For kind:'text', a vertical direction always shrink-wraps,
                // so flip autoSize back to true on switch - otherwise a shape
                // left in wrap/fit mode would keep its pinned width and the
                // column couldn't grow. Body-bearing kinds keep their
                // user-sized bbox, so no autoSize change there.
                update(shape.id, {
                  textDirection: v,
                  ...(shape.kind === 'text' && isVerticalDir(v)
                    ? { autoSize: true }
                    : null),
                })
            : undefined
        }
      />
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onBlur={(e) => {
          // Don't commit when focus is jumping to a toolbar control -
          // that's the user opening the font picker, clicking a colour
          // swatch, or focusing the size input to type a new value. The
          // toolbar root carries the ref; anything contained by it is
          // "still editing" from the user's perspective.
          const next = e.relatedTarget as Node | null;
          if (next && toolbarRef.current?.contains(next)) return;
          commit();
        }}
        onPaste={(e) => {
          // Paste as PLAIN TEXT. A bare contentEditable otherwise injects the
          // source's HTML - foreign tags and inline font-weight/style spans -
          // which domToMd then collapses onto one line (no <br>s) and
          // mis-reads as bold/italic. Insert only the text/plain payload.
          e.preventDefault();
          const text = e.clipboardData.getData('text/plain');
          if (text) document.execCommand('insertText', false, text);
        }}
        onInput={(e) => {
          // Live grow: for kind:'text' shapes, mirror
          // the contenteditable's current text into the shape on every
          // keystroke. The store's autoFit re-measures and writes back
          // w/h, the editor reads the new bbox, and the dashed-border
          // box grows under the user's cursor without re-rendering the
          // contenteditable's children (we only update the shape, not
          // the textContent - the DOM keeps the cursor in place).
          //
          // Goes through updateShapeLive (no _snapshot) so a paragraph
          // of typing produces ONE undo step (added at commit), not one
          // per keystroke. Other kinds skip live update - their bbox
          // doesn't track text, so re-measuring on every input would
          // just thrash the store.
          //
          // Skip while an IME composition is in flight - writing to the store
          // re-lays-out (and can re-pan) the canvas, which aborts the
          // composition and drops half-typed CJK/accented characters. The
          // composed text is flushed once on compositionend below.
          if ((e.nativeEvent as InputEvent).isComposing) return;
          if (shape.kind !== 'text') return;
          // Mirror commit's DOM-to-markdown walk so a typed bold/italic
          // run survives the live updates and the store autoFit measures
          // off the same string the user typed.
          const next = domToMd(editorRef.current);
          updateLive(shape.id, { [editingField]: next } as Partial<typeof shape>);
        }}
        onCompositionEnd={() => {
          // Flush the final composed text once the IME session ends (onInput
          // skipped the live writes while composing).
          if (shape.kind !== 'text') return;
          const next = domToMd(editorRef.current);
          updateLive(shape.id, { [editingField]: next } as Partial<typeof shape>);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // ⌘/Ctrl+Enter always finishes the edit - the one shortcut
            // that means the same thing on every kind, including the text
            // shapes where a bare Enter is a line break.
            if (e.metaKey || e.ctrlKey) {
              e.preventDefault();
              commit();
              return;
            }
            // Line break: ⇧Enter on any kind, and a bare Enter on text
            // shapes (Esc or a click away commits
            // those). Other kinds keep bare Enter = commit, which is the
            // existing label-edit muscle memory.
            //
            // Always driven through our own range surgery rather than the
            // browser default, which inserts a <div> or <p> block that
            // domToMd collapses on serialize - the user types the break,
            // sees no \n survive the commit, and assumes it didn't work.
            // execCommand('insertLineBreak') was the previous stand-in and
            // is worse still inside this `display: flex` box: WebKit (the
            // desktop app's engine) inserts the break and then puts the
            // caret back at the start of the line it was already on. See
            // insertLineBreakAtCaret for the story.
            if (e.shiftKey || shape.kind === 'text') {
              e.preventDefault();
              insertLineBreakAtCaret(editorRef.current);
              return;
            }
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        style={{
          position: 'absolute',
          left: screenX,
          // Text shapes keep an exact box - the store's autoFit already
          // resizes the shape to its content on every keystroke, so screenH
          // IS the content height. Every other kind gets the grow model:
          // pin the edge the anchor pins, let the opposite edge move.
          ...(shape.kind === 'text'
            ? { top: screenY, height: screenH }
            : growFrom === 'top'
              ? { top: screenY, minHeight: screenH }
              : growFrom === 'bottom'
                ? {
                    top: screenY + screenH,
                    transform: 'translateY(-100%)',
                    minHeight: screenH,
                  }
                : {
                    top: screenY + screenH / 2,
                    transform: 'translateY(-50%)',
                    minHeight: screenH,
                  }),
          width: screenW,
          // Free text shapes: bbox already matches text
          // (via store autoFit), so render flush top-left with no
          // padding/flex. Wrap behaviour mirrors Shape.tsx's text path:
          //   autoSize=true  → white-space: pre  (no wrap; \n only)
          //   autoSize=false → white-space: pre-wrap (wraps at shape.w)
          // For other kinds, keep the existing flex-centred treatment.
          display: shape.kind === 'text' ? 'block' : 'flex',
          alignItems: shape.kind === 'text' ? undefined : alignItems,
          justifyContent: shape.kind === 'text' ? undefined : justifyContent,
          flexDirection: shape.kind === 'text' ? undefined : 'column',
          // Text shapes get horizontal padding so the dashed editor border
          // sits OFF the glyphs (mirrors Shape.tsx's TEXT_BOX_PAD_X inset
          // on the rendered shape, so commit doesn't visually jump). Other
          // kinds keep the flex-centred 4×6px chrome padding.
          padding:
            shape.kind === 'text'
              ? `0 ${TEXT_BOX_PAD_X * zoom}px`
              : '4px 6px',
          boxSizing: 'border-box',
          // Editor chrome: a thin dashed accent ring + a faint blue glow so
          // the user sees that they're editing, but NO opaque paper fill.
          // The previous treatment painted the shape's body white
          // during edit (a green-filled box looked white while typing); a
          // transparent background lets the actual shape fill / icon /
          // container frame show through. The dashed border + outer glow
          // are enough of an "you're editing" cue without hiding the
          // committed appearance.
          border: '1px dashed var(--accent)',
          borderRadius: 4,
          background: 'transparent',
          // Live label colour mirrors the rendered text - typing in green
          // now paints green immediately instead of black-then-green-on-
          // commit.
          color: liveLabelColor,
          fontFamily,
          fontSize,
          fontWeight,
          lineHeight: 1.2,
          // Text shapes default to centred so typing a short word doesn't
          // sit on the left edge with a big right gap (which read as
          // "padding too much on the right" before - the bbox padding is
          // symmetric, but left-aligned text leaves the right gap visible).
          // shape.textAlign overrides per-shape via the flyout's align
          // toggle. Other kinds (rect/icon labels) keep the per-anchor
          // textAlign computed above.
          textAlign:
            shape.kind === 'text'
              ? shape.textAlign ?? 'center'
              : shape.textAlign ?? textAlign,
          outline: 'none',
          whiteSpace:
            shape.kind === 'text' && shape.autoSize !== false
              ? 'pre'
              : 'pre-wrap',
          wordBreak:
            shape.kind === 'text' && shape.autoSize === false
              ? 'break-word'
              : undefined,
          // Text shapes in shrink-wrap mode (autoSize=true) need overflow
          // visible so the dashed border doesn't clip a descender on the
          // last line - the bbox matches the text exactly, so there's no
          // actual overflow anyway. In wrap mode (autoSize=false) the bbox
          // height also tracks content now (the old 800px cap is gone),
          // but keep overflow:auto as a safety valve for the transient
          // frames where the contenteditable's rendered marks (b/i/u)
          // measure slightly differently than the raw markdown string the
          // store's autoFit measured. Other kinds clip to bbox.
          // Never clip while editing. The box grows with the content (see
          // the grow model above), so there's usually nothing to spill -
          // but when there is (a line longer than a wrapping slot, an
          // overflowing body), showing it is the point. `hidden` here
          // is what made a newline look like it had been swallowed.
          overflow:
            shape.kind === 'text' && shape.autoSize === false
              ? 'auto'
              : 'visible',
          zIndex: 30,
          boxShadow: '0 0 0 3px rgba(31,111,235,0.18)',
          cursor: 'text',
          // Vertical text types under writing-mode: vertical-rl (rotated or
          // upright) with the matching tighter line-height + tracking so the
          // caret + glyphs flow exactly as Shape.tsx will paint on commit.
          // Spread last so it overrides the horizontal lineHeight above; {}
          // for horizontal. (For kind:'text' measureText + autoFit use the
          // same metrics; body-bearing kinds keep their flex centring.)
          ...editorVStyle,
        }}
      />
    </>
  );
}

/** Floating toolbar that hovers above the inline editor while text editing
 *  is active. Bold / italic / underline run through `execCommand` on the
 *  current selection - still the only practical way to apply inline rich
 *  formatting inside a contentEditable without a full rich-text framework.
 *
 *  Font family, font size, and text colour all write through to the
 *  underlying shape via `update(shape.id, …)` so the styling persists after
 *  the editor commits - not as a transient editor-local preview. The font
 *  picker and colour swatches are the same components the inspector uses,
 *  so the chrome reads identically in both places.
 *
 *  Exported because InlineCellEditor wants the same widget. The callbacks
 *  are generic - caller decides whether the writes target a shape or a
 *  table cell. */
export function FloatingTextToolbar({
  editorRef,
  toolbarRef,
  screenX,
  screenY,
  screenW,
  currentFontFamily,
  currentFontSize,
  currentTextColor,
  currentTextAlign,
  currentTextDirection,
  onFontFamily,
  onFontSize,
  onTextColor,
  onTextAlign,
  onTextDirection,
}: {
  editorRef: React.RefObject<HTMLDivElement | null>;
  // MutableRefObject (not RefObject) so we can attach to a div's `ref`
  // attribute - React 18's RefObject<T | null> is invariant and won't
  // assign to LegacyRef<HTMLDivElement>.
  toolbarRef: React.MutableRefObject<HTMLDivElement | null>;
  screenX: number;
  screenY: number;
  screenW: number;
  currentFontFamily: string | undefined;
  currentFontSize: number;
  currentTextColor: string | undefined;
  /** Currently selected text alignment for the active shape/cell. Undefined
   *  shows no chip as active (caller passes the kind-default if it wants the
   *  toggle to read like "centre is active by default"). */
  currentTextAlign?: 'left' | 'center' | 'right';
  onFontFamily: (f: string | undefined) => void;
  onFontSize: (px: number | undefined) => void;
  onTextColor: (c: string | undefined) => void;
  /** Called when the user picks a new alignment via the toggle group.
   *  Optional so callers (e.g. table-cell editor) can omit the affordance
   *  if alignment isn't surfaced for that surface yet. */
  onTextAlign?: (a: 'left' | 'center' | 'right') => void;
  /** Current writing direction of the active shape. Undefined hides the
   *  orientation picker (it's surfaced only for text + body-bearing kinds). */
  currentTextDirection?: TextDirection;
  /** Called when the user picks a new text orientation. Optional + paired
   *  with `currentTextDirection` - both must be supplied for it to show. */
  onTextDirection?: (d: TextDirection) => void;
}) {
  // Position above the editor by 46px. Clamp to viewport so the toolbar
  // doesn't jump off the top edge when the shape sits near y=0.
  const top = Math.max(8, screenY - 46);
  const left = screenX;

  // Colour swatches now live behind a popover trigger so the toolbar reads
  // as one compact row rather than a wall of cells. Open state is local -
  // closes on outside click via a document listener wired up in the effect
  // below. The trigger button is INSIDE toolbarRef so opening it doesn't
  // commit the editor's contenteditable.
  const [colorOpen, setColorOpen] = useState(false);
  const colorPopRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!colorOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      // Click inside popover or on the trigger (which is inside toolbarRef
      // ↦ contains check) keeps it open. Anything else closes.
      if (colorPopRef.current?.contains(t)) return;
      // The trigger is in toolbarRef but isn't in colorPopRef - guard
      // against the trigger's own click closing the popover before it
      // even rendered by skipping any element marked data-color-trigger.
      if (t instanceof Element && t.closest('[data-color-trigger]')) return;
      setColorOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [colorOpen]);

  const exec = (cmd: string, value?: string) => {
    // Keep the editor focused so execCommand has a target selection.
    editorRef.current?.focus();
    document.execCommand(cmd, false, value);
  };

  // Visual swatch on the colour-trigger button - show the current text
  // colour so the user can see at a glance what's selected without opening
  // the popover. Default (undefined) renders as the same conic gradient
  // the SwatchRow uses for "custom" - visually distinct from any picked
  // colour while still hinting "this is colour-related".
  const triggerSwatch =
    currentTextColor ??
    'conic-gradient(from 0deg, #ef4444, #f59e0b, #eab308, #84cc16, #10b981, #06b6d4, #3b82f6, #8b5cf6, #ec4899, #ef4444)';

  return (
    <div
      ref={toolbarRef}
      // No broad preventDefault here - that previously blocked the size
      // input from receiving focus on click. Instead the editor's onBlur
      // checks `toolbarRef.contains(relatedTarget)` and skips commit when
      // focus is moving to any control inside this toolbar. The format
      // buttons (B/I/U) DO preventDefault on themselves so they don't
      // pull focus on PC (Mac doesn't focus buttons on click anyway), but
      // the input + FontPicker trigger + swatches focus normally.
      className="float absolute"
      style={{
        top,
        left,
        // Compacted now that swatches collapse into a popover - the row
        // only has to fit picker + size + B/I/U + 3 align chips + colour
        // trigger, so 380px gives breathing room on tiny shapes without
        // the row stretching off-screen on big ones.
        minWidth: Math.max(screenW, 380),
        zIndex: 31,
        padding: '5px 6px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      {/* Font family - same picker the inspector uses, so the dropdown
       *  shows each face in its own typeface and 'Default' correctly maps
       *  to undefined (clearing the override). */}
      <div style={{ width: 130, flexShrink: 0 }}>
        <FontPicker value={currentFontFamily} onChange={onFontFamily} />
      </div>

      {/* Font size - Google-Docs-style stepper + presets. Writes through to
       *  shape.fontSize; the dropdown ladder mirrors Docs because that's the
       *  muscle memory the user is reaching for. Default fallback uses the
       *  same kind-based fallback the editor itself applies (sketchy=18,
       *  otherwise 13) so the field doesn't lie when nothing is overridden. */}
      <FontSizeField
        value={undefined /* see below: we want the absolute current size shown */}
        defaultSize={currentFontSize}
        onChange={(v) => onFontSize(v)}
      />

      <Divider />

      <ToolbarBtn label="B" weight={700} onClick={() => exec('bold')} title="Bold" />
      <ToolbarBtn label="I" italic onClick={() => exec('italic')} title="Italic" />
      <ToolbarBtn
        label="U"
        underline
        onClick={() => exec('underline')}
        title="Underline"
      />

      {onTextAlign && (
        <>
          <Divider />
          {/* One trigger keeps the alignment choices compact beside the
           *  formatting controls. Its glyph shows the current alignment
           *  without opening the popover. */}
          <AlignFoldout
            current={currentTextAlign ?? 'left'}
            onPick={(a) => onTextAlign(a)}
          />
        </>
      )}

      {onTextDirection && currentTextDirection && (
        <>
          <Divider />
          {/* Orientation fold-out - horizontal rows, vertical rotated
           *  (sideways), or vertical upright (stacked glyphs). Trigger shows
           *  the active orientation; popover offers all three. */}
          <OrientationFoldout
            current={currentTextDirection}
            onPick={onTextDirection}
          />
        </>
      )}

      <Divider />

      {/* Text colour - collapsed into a popover-triggered swatch row so the
       *  toolbar doesn't waste a long horizontal slot on cells the user
       *  rarely needs visible. The trigger button shows the active colour
       *  as a tiny chip; clicking it opens the same SwatchRow the inspector
       *  uses, anchored just below the trigger. allowNone stays off -
 * "no text colour" isn't a thing. */}
      <div style={{ position: 'relative' }}>
        <button
          data-color-trigger
          type="button"
          title="Text colour"
          // preventDefault on mousedown so opening the popover doesn't
          // pull focus from the contenteditable (same trick the B/I/U
          // buttons use).
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setColorOpen((v) => !v)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            background: 'var(--bg-subtle)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            height: 24,
            padding: '0 6px',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: 2,
              background: triggerSwatch,
              border: '1px solid var(--border)',
            }}
          />
          <span style={{ fontSize: 10, lineHeight: 1 }}>▾</span>
        </button>
        {colorOpen && (
          <div
            ref={colorPopRef}
            // Anchor the popover BELOW the trigger so it never overlaps
            // the toolbar row above. Padding gives the swatch cells some
            // breathing room from the popover border.
            style={{
              position: 'absolute',
              top: 28,
              right: 0,
              padding: 6,
              borderRadius: 6,
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
              zIndex: 32,
              // Don't squash the swatches when the row has wrapped - the
              // popover sets its own width based on cells.
              minWidth: 220,
            }}
          >
            <SwatchRow
              kind="stroke"
              value={currentTextColor}
              onChange={(c) => {
                onTextColor(c);
                // Don't auto-close: the user often tries a couple of
                // colours in quick succession. Outside-click handles
                // dismissal.
              }}
              allowNone={false}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** Single trigger button + popover that exposes the three alignment options.
 *  Trigger shows the current alignment's glyph; click opens a row of three
 *  AlignBtn chips, click an option to pick + close. Saves ~70px on the
 *  toolbar versus three inline chips. */
function AlignFoldout({
  current,
  onPick,
}: {
  current: 'left' | 'center' | 'right';
  onPick: (a: 'left' | 'center' | 'right') => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  // Outside-click closes - same pattern as the colour fold-out elsewhere
  // in the toolbar. The trigger is excluded so its own onClick still toggles
  // open/closed reliably.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (popRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);
  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        title={`Text alignment - ${current}`}
        // preventDefault on mousedown so toggling the fold-out doesn't pull
        // focus out of the contenteditable (matches the colour trigger).
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        style={{
          background: open ? 'var(--bg-emphasis)' : 'var(--bg-subtle)',
          color: 'var(--fg)',
          border: `1px solid ${open ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 4,
          width: 30,
          height: 24,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          flexShrink: 0,
          gap: 2,
        }}
      >
        <AlignGlyph kind={current} />
        <span style={{ fontSize: 9, lineHeight: 1, opacity: 0.7 }}>▾</span>
      </button>
      {open && (
        <div
          ref={popRef}
          style={{
            position: 'absolute',
            top: 28,
            left: 0,
            padding: 4,
            borderRadius: 6,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
            zIndex: 32,
            display: 'flex',
            gap: 4,
          }}
        >
          {(['left', 'center', 'right'] as const).map((k) => (
            <AlignBtn
              key={k}
              kind={k}
              active={current === k}
              onClick={() => {
                onPick(k);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Tiny three-line SVG glyph used by both AlignBtn (popover row) and the
 *  AlignFoldout trigger. Mirrors the chosen alignment visually. */
function AlignGlyph({ kind }: { kind: 'left' | 'center' | 'right' }) {
  const lines: { x1: number; x2: number }[] =
    kind === 'left'
      ? [
          { x1: 2, x2: 12 },
          { x1: 2, x2: 14 },
          { x1: 2, x2: 10 },
        ]
      : kind === 'right'
        ? [
            { x1: 4, x2: 14 },
            { x1: 2, x2: 14 },
            { x1: 6, x2: 14 },
          ]
        : [
            { x1: 3, x2: 13 },
            { x1: 1, x2: 15 },
            { x1: 4, x2: 12 },
          ];
  return (
    <svg width={16} height={12} viewBox="0 0 16 12" aria-hidden>
      {lines.map((l, i) => (
        <line
          key={i}
          x1={l.x1}
          x2={l.x2}
          y1={3 + i * 3}
          y2={3 + i * 3}
          stroke="currentColor"
          strokeWidth={1.4}
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

/** Alignment chip used inside the AlignFoldout popover. */
function AlignBtn({
  kind,
  active,
  onClick,
}: {
  kind: 'left' | 'center' | 'right';
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={`Align ${kind}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={{
        background: active ? 'var(--bg-emphasis)' : 'var(--bg-subtle)',
        color: 'var(--fg)',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        boxShadow: active ? '0 0 0 1px var(--accent) inset' : undefined,
        borderRadius: 4,
        width: 26,
        height: 24,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      <AlignGlyph kind={kind} />
    </button>
  );
}

const ORIENTATION_OPTIONS: {
  key: TextDirection;
  label: string;
}[] = [
  { key: 'horizontal', label: 'Horizontal' },
  { key: 'vertical', label: 'Vertical (rotated)' },
  { key: 'vertical-upright', label: 'Vertical (stacked)' },
];

/** Trigger button + popover that exposes the three text orientations. Mirrors
 *  AlignFoldout: the trigger shows the active orientation's glyph; the popover
 *  is a row of option chips. */
function OrientationFoldout({
  current,
  onPick,
}: {
  current: TextDirection;
  onPick: (d: TextDirection) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const active = current !== 'horizontal';
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (popRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);
  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        title={`Text orientation - ${
          ORIENTATION_OPTIONS.find((o) => o.key === current)?.label ?? 'Horizontal'
        }`}
        // preventDefault on mousedown so toggling the fold-out doesn't pull
        // focus out of the contenteditable (matches the align / colour
        // triggers).
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        style={{
          background: open || active ? 'var(--bg-emphasis)' : 'var(--bg-subtle)',
          color: 'var(--fg)',
          border: `1px solid ${
            open || active ? 'var(--accent)' : 'var(--border)'
          }`,
          boxShadow: active ? '0 0 0 1px var(--accent) inset' : undefined,
          borderRadius: 4,
          width: 30,
          height: 24,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          flexShrink: 0,
          gap: 2,
        }}
      >
        <OrientationGlyph kind={current} />
        <span style={{ fontSize: 9, lineHeight: 1, opacity: 0.7 }}>▾</span>
      </button>
      {open && (
        <div
          ref={popRef}
          style={{
            position: 'absolute',
            top: 28,
            left: 0,
            padding: 4,
            borderRadius: 6,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
            zIndex: 32,
            display: 'flex',
            gap: 4,
          }}
        >
          {ORIENTATION_OPTIONS.map((o) => (
            <button
              key={o.key}
              type="button"
              title={o.label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(o.key);
                setOpen(false);
              }}
              style={{
                background:
                  current === o.key ? 'var(--bg-emphasis)' : 'var(--bg-subtle)',
                color: 'var(--fg)',
                border: `1px solid ${
                  current === o.key ? 'var(--accent)' : 'var(--border)'
                }`,
                boxShadow:
                  current === o.key ? '0 0 0 1px var(--accent) inset' : undefined,
                borderRadius: 4,
                width: 30,
                height: 24,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <OrientationGlyph kind={o.key} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Glyph for each text orientation:
 *   - horizontal       → a glyph block + rightward flow arrow.
 *   - vertical         → the same artwork rotated 90° (reads sideways).
 *   - vertical-upright → two upright glyph blocks stacked top-to-bottom. */
function OrientationGlyph({ kind }: { kind: TextDirection }) {
  if (kind === 'vertical-upright') {
    return (
      <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
        <rect x={5} y={2} width={6} height={5} rx={1} fill="currentColor" />
        <rect x={5} y={9} width={6} height={5} rx={1} fill="currentColor" />
      </svg>
    );
  }
  const vertical = kind === 'vertical';
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
      <g transform={vertical ? 'rotate(90 8 8)' : undefined}>
        <rect x={2} y={4} width={5} height={8} rx={1} fill="currentColor" />
        <line
          x1={8}
          y1={8}
          x2={13}
          y2={8}
          stroke="currentColor"
          strokeWidth={1.4}
          strokeLinecap="round"
        />
        <path
          d="M11.4 6 L14 8 L11.4 10"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

function ToolbarBtn({
  label,
  weight,
  italic,
  underline,
  onClick,
  title,
}: {
  label: string;
  weight?: number;
  italic?: boolean;
  underline?: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      // preventDefault on mousedown stops the button from stealing focus
      // from the contenteditable on PC (Mac doesn't focus buttons on click,
      // so this is a no-op there). Without it, B/I/U on Windows/Linux
      // would shift focus, blur the editor, and cause execCommand to run
      // against an empty selection.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      style={{
        background: 'var(--bg-subtle)',
        color: 'var(--fg)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        width: 26,
        height: 24,
        fontWeight: weight ?? 500,
        fontStyle: italic ? 'italic' : 'normal',
        textDecoration: underline ? 'underline' : 'none',
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
}

function Divider() {
  return (
    <span
      aria-hidden
      style={{
        width: 1,
        height: 18,
        background: 'var(--border)',
        flexShrink: 0,
      }}
    />
  );
}
