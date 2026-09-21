import { useEffect } from 'react';
import { useEditor } from '@/store/editor';
import { visibleItemIds } from '@/store/layers';
import type { ToolKey } from '@/store/types';
import { handleCopyPng, handleNew, handleOpen, handleSaveAs } from './files';

/** Editor-global keymap.
 *
 *  Tool / overlay:
 *    1-9                    activate hotkey slot (1=select, 2=rect, 3=ellipse,
 *                           4=diamond, 5=arrow, 6=line, 7=text, 8=container,
 *                           9=pen)
 *    L                      laser pointer
 *    T                      table
 *    S                      toggle library panel
 *    Cmd+K (or Ctrl+K)      open searchable picker
 *    Cmd+F (or Ctrl+F)      open find / replace
 *    Q                      toggle tool lock
 *    W                      switch draw layer (Notes / Blueprint)
 *    X                      toggle snap (workspace default)
 *    M                      toggle measurements
 *    A                      toggle Default Smart Anchors (workspace default)
 *    F2                     edit label of the selected shape
 *    Esc                    close any open overlay; clear selection
 *
 *  Edit:
 *    Delete / Backspace     delete selection
 *    Cmd+Z / Cmd+Shift+Z    undo / redo
 *    Cmd+C / Cmd+X / Cmd+V  copy / cut / paste
 *    Cmd+D                  duplicate selection
 *    Cmd+A                  select all (visible)
 *    Cmd+Shift+A            deselect all
 *    Arrow keys             nudge selection by 1px
 *    Shift+Arrow            nudge selection by 10px
 *    Cmd/Ctrl+Arrow         estimate spacing from neighbours and nudge by that
 *    [ / ]                  send backward / bring forward
 *    Shift+Cmd+[ / ]        send to back / bring to front
 *    Shift+Cmd+. / ,        bump font size of selection by ±1px
 *                           (>/< also accepted - they ARE Shift+./Shift+,)
 *    Shift+H / Shift+V      flip selection horizontally / vertically
 *
 *  View:
 *    Cmd+;                  toggle major-gridline overlay
 *    Cmd+Shift+D            toggle light / dark theme
 *    PageUp / PageDown      previous / next diagram tab
 *
 *  Connectors:
 *    Space + drag           drag-out connector (canvas-level)
 *    R                      reverse selected connector direction
 *    Tab                    swap selected connector endpoints
 *    Shift+Cmd+P            promote selection Notes -> Blueprint
 *
 *  Viewport:
 *    Cmd+= / Cmd+-          zoom in / out
 *    Cmd+0                  reset view
 *    Cmd+1                  fit to content
 *
 *  Suppressed when the user is typing in a form field. Bare-key shortcuts
 *  (S, T, W, X, M, A, L, Q, N, 1-9) are additionally suppressed when focus is
 *  inside a dialog/menu portal - pressing 'S' on a focused dialog button
 *  used to toggle the library underneath. Modifier shortcuts (Cmd+S etc.)
 *  still fire from dialogs as expected. */

/** Returns true if the matched binding actually fired. False means the
 *  state precondition didn't hold (e.g. arrow key with no selection) and
 *  the browser default should pass through - important for arrows (page
 *  scroll), Tab (focus next element), etc. */
type Run = () => boolean;

type KeybindingDef = {
  id: string;
  label: string;
  test: (e: KeyboardEvent) => boolean;
  run: Run;
  /** Fire even when focus is in a text input. Default false. Used for
   *  Cmd+F, Cmd+S, Cmd+Shift+D - globals that should still work mid-edit. */
  allowInForm?: boolean;
  /** Fire when focus is inside a Radix portal (dialog/menu). Default
   *  false for BARE-KEY shortcuts, true for modifier shortcuts. Set
   *  explicitly to override. */
  allowInDialog?: boolean;
};

const m = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;
const k = (e: KeyboardEvent) => e.key.toLowerCase();
/** Wrap a void action so it always reports as "ran" (preventDefault). */
const ok = (fn: () => void): Run => () => {
  fn();
  return true;
};

const BINDINGS: readonly KeybindingDef[] = [
  // ─── Hoisted globals ────────────────────────────────────────────────────
  // Fire even from inside a text input - re-pressing toggles the panel
  // closed and the browser's native page-find never reaches the canvas.
  {
    id: 'find-replace',
    label: 'Find / replace',
    test: (e) => m(e) && !e.shiftKey && k(e) === 'f',
    run: ok(() => useEditor.getState().toggleFind()),
    allowInForm: true,
    allowInDialog: true,
  },
  {
    id: 'toggle-theme',
    label: 'Toggle light/dark theme',
    test: (e) => m(e) && e.shiftKey && k(e) === 'd',
    run: ok(() => useEditor.getState().toggleTheme()),
    allowInForm: true,
    allowInDialog: true,
  },
  // Shift+⌘+. / , (= >/<) bump font size - works mid-label-edit so the
  // word-processor habit of sizing text while typing works.
  {
    id: 'font-size-bump',
    label: 'Bump font size ±1px',
    test: (e) =>
      m(e) &&
      e.shiftKey &&
      (e.key === '>' || e.key === '<' || e.key === '.' || e.key === ','),
    run: () => {
      const st = useEditor.getState();
      if (
        st.selectedIds.length === 0 &&
        !st.editingShapeId &&
        !st.editingCell
      ) {
        return false;
      }
      const dir = e_key_isUp(lastEvent) ? 1 : -1;
      const targetId =
        st.editingShapeId ?? st.editingCell?.shapeId ?? st.selectedIds[0];
      const sh = st.diagram.shapes.find((s) => s.id === targetId);
      const cur = sh?.fontSize ?? st.lastStyles.fontSize ?? 13;
      const nextSize = Math.max(6, Math.min(200, Math.round(cur) + dir));
      if (st.editingCell) {
        st.setCellPatch(
          st.editingCell.shapeId,
          st.editingCell.row,
          st.editingCell.col,
          { fontSize: nextSize },
        );
      } else if (st.editingShapeId) {
        st.updateShape(st.editingShapeId, { fontSize: nextSize });
      } else {
        st.updateSelection({ fontSize: nextSize });
      }
      return true;
    },
    allowInForm: true,
    allowInDialog: true,
  },

  // ─── Cmd+K palette ──────────────────────────────────────────────────────
  {
    id: 'palette',
    label: 'Command palette',
    test: (e) => m(e) && k(e) === 'k',
    run: ok(() => useEditor.getState().toggleCmdk()),
    allowInDialog: true,
  },

  // ─── Selection / edit ───────────────────────────────────────────────────
  {
    id: 'edit-label',
    label: 'Edit selected label (F2)',
    test: (e) => !m(e) && !e.shiftKey && e.key === 'F2',
    run: () => {
      const st = useEditor.getState();
      const id = st.selectedIds[0];
      if (!id || st.selectedIds.length !== 1) return false;
      const sh = st.diagram.shapes.find((s) => s.id === id);
      if (!sh) return false;
      // Route through the same signal every other edit-entry point uses
      // (canvas double-click, context menu). Writing `editingShapeId`
      // straight to the store only flipped the flag: InlineLabelEditor
      // opens off its own session state, so no editor ever appeared - and
      // the latched flag made Canvas's pointer-down swallow every press,
      // which froze the selection until something else reset the flag.
      window.dispatchEvent(
        new CustomEvent('vellum:edit-shape', { detail: { id } }),
      );
      return true;
    },
  },
  {
    id: 'delete-selection',
    label: 'Delete selection',
    test: (e) => e.key === 'Delete' || e.key === 'Backspace',
    run: () => {
      const st = useEditor.getState();
      // Belt-and-suspenders: the form guard already suppresses this while a
      // contentEditable is focused, but that relies purely on DOM focus. If
      // focus is lost mid-edit without a clean blur (editor still open per
      // these flags), Backspace must NOT delete the shape being edited. Bail
      // on the editing flags directly, the way the font-size bindings do.
      if (st.editingShapeId || st.editingConnectorId || st.editingCell)
        return false;
      if (st.selectedIds.length === 0) return false;
      st.deleteSelection();
      return true;
    },
  },
  {
    id: 'undo',
    label: 'Undo',
    test: (e) => m(e) && !e.shiftKey && k(e) === 'z',
    run: ok(() => useEditor.getState().undo()),
    allowInDialog: true,
  },
  {
    id: 'redo-shift-z',
    label: 'Redo',
    test: (e) => m(e) && e.shiftKey && k(e) === 'z',
    run: ok(() => useEditor.getState().redo()),
    allowInDialog: true,
  },
  // Some keyboards fire Cmd+Y for redo - accept it too.
  {
    id: 'redo-y',
    label: 'Redo (Cmd+Y)',
    test: (e) => m(e) && k(e) === 'y',
    run: ok(() => useEditor.getState().redo()),
    allowInDialog: true,
  },
  // NOTE: Cmd+C / Cmd+X / Cmd+V are intentionally NOT in this table.
  // preventDefault would block the native clipboard event the Canvas
  // listens for, so we couldn't mirror the selection onto the OS
  // clipboard or read images from it. The Canvas owns the full clipboard
  // dispatch.
  {
    id: 'duplicate-selection',
    label: 'Duplicate selection',
    test: (e) => m(e) && !e.shiftKey && k(e) === 'd',
    run: ok(() => useEditor.getState().duplicateSelection()),
    allowInDialog: true,
  },
  {
    id: 'select-all',
    label: 'Select all visible',
    test: (e) => m(e) && !e.shiftKey && k(e) === 'a',
    run: ok(() => {
      // Select-all includes connectors - they're first-class selectable
      // items (style/delete from the inspector + via keybindings), and a
      // "select everything visible" hotkey that leaves the arrows
      // behind violates least surprise. Marquee select uses the same
      // shape+connector composition, so this brings Cmd+A in line.
      const st = useEditor.getState();
      // Respect the active layer. "Select all VISIBLE" must not grab items on
      // a hidden layer - otherwise a following Delete/nudge silently mutates
      // shapes the user can't even see. `visibleItemIds` is the same rule
      // the canvas renders with (store/layers.ts), so the two can't drift.
      const visible = visibleItemIds(
        st.diagram.shapes,
        st.diagram.connectors,
        st.layerMode,
      );
      st.setSelected([...visible]);
    }),
    allowInDialog: true,
  },
  {
    id: 'deselect-all',
    label: 'Deselect all',
    test: (e) => m(e) && e.shiftKey && k(e) === 'a',
    run: ok(() => useEditor.getState().setSelected(null)),
    allowInDialog: true,
  },

  // ─── Arrow-key nudge ────────────────────────────────────────────────────
  // Plain → 1px. Shift → 10px. Cmd/Ctrl → estimate spacing from neighbours.
  // No selection → falls through to browser default (page scroll).
  {
    id: 'nudge',
    label: 'Nudge selection',
    test: (e) =>
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight',
    run: () => {
      const st = useEditor.getState();
      if (st.selectedIds.length === 0) return false;
      const key = lastEvent.key;
      const sx = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
      const sy = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
      if (m(lastEvent)) {
        st.nudgeSelection(sx, sy, 'estimate');
      } else {
        const step = lastEvent.shiftKey ? 10 : 1;
        st.nudgeSelection(sx * step, sy * step, 'fixed');
      }
      return true;
    },
  },

  // ─── Z-order ────────────────────────────────────────────────────────────
  // Shift+⌘+] / [ jump to front / back; plain [ / ] step one layer.
  {
    id: 'z-bring-to-front',
    label: 'Bring to front',
    test: (e) => m(e) && e.shiftKey && e.key === ']',
    run: ok(() => useEditor.getState().bringToFront()),
    allowInDialog: true,
  },
  {
    id: 'z-send-to-back',
    label: 'Send to back',
    test: (e) => m(e) && e.shiftKey && e.key === '[',
    run: ok(() => useEditor.getState().sendToBack()),
    allowInDialog: true,
  },
  {
    id: 'z-bring-forward',
    label: 'Bring forward',
    test: (e) => !m(e) && !e.shiftKey && e.key === ']',
    run: ok(() => useEditor.getState().bringForward()),
  },
  {
    id: 'z-send-backward',
    label: 'Send backward',
    test: (e) => !m(e) && !e.shiftKey && e.key === '[',
    run: ok(() => useEditor.getState().sendBackward()),
  },

  // ─── View ───────────────────────────────────────────────────────────────
  {
    id: 'toggle-gridlines',
    label: 'Toggle major-gridline overlay',
    test: (e) => m(e) && !e.shiftKey && e.key === ';',
    run: ok(() => {
      const st = useEditor.getState();
      st.setShowGrid(!st.showGrid);
    }),
    allowInDialog: true,
  },
  {
    id: 'next-tab',
    label: 'Switch to next/previous diagram tab',
    test: (e) => !m(e) && (e.key === 'PageUp' || e.key === 'PageDown'),
    run: () => {
      const st = useEditor.getState();
      const tabs = st.diagramTabs;
      if (tabs.length < 2) return false;
      const idx = tabs.findIndex((t) => t.id === st.activeTabId);
      if (idx < 0) return false;
      const dir = lastEvent.key === 'PageDown' ? 1 : -1;
      const nextIdx = (idx + dir + tabs.length) % tabs.length;
      st.switchDiagramTab(tabs[nextIdx].id);
      return true;
    },
  },

  // ─── Flip ───────────────────────────────────────────────────────────────
  // Shift+H / Shift+V. No bare H or V binding (reserved); Shift modifier
  // matches the "transform" gesture muscle memory in most vector editors.
  {
    id: 'flip-horizontal',
    label: 'Flip horizontal',
    test: (e) => !m(e) && e.shiftKey && (e.key === 'H' || e.key === 'h'),
    run: () => {
      const st = useEditor.getState();
      if (st.selectedIds.length === 0) return false;
      st.flipSelection('horizontal');
      return true;
    },
  },
  {
    id: 'flip-vertical',
    label: 'Flip vertical',
    test: (e) => !m(e) && e.shiftKey && (e.key === 'V' || e.key === 'v'),
    run: () => {
      const st = useEditor.getState();
      if (st.selectedIds.length === 0) return false;
      st.flipSelection('vertical');
      return true;
    },
  },

  // ─── Promote / group ────────────────────────────────────────────────────
  {
    id: 'promote-selection',
    label: 'Promote selection Notes → Blueprint',
    test: (e) => m(e) && e.shiftKey && k(e) === 'p',
    run: ok(() => useEditor.getState().promoteSelection()),
    allowInDialog: true,
  },
  {
    id: 'group',
    label: 'Group selection',
    test: (e) => m(e) && !e.shiftKey && k(e) === 'g',
    run: ok(() => useEditor.getState().groupSelection()),
    allowInDialog: true,
  },
  {
    id: 'ungroup',
    label: 'Ungroup selection',
    test: (e) => m(e) && e.shiftKey && k(e) === 'g',
    run: ok(() => useEditor.getState().ungroupSelection()),
    allowInDialog: true,
  },

  // ─── Connectors ─────────────────────────────────────────────────────────
  // R / Tab swap from/to. Aliases for now; a future spec might split them.
  {
    id: 'reverse-connector',
    label: 'Reverse connector direction',
    test: (e) => !m(e) && (e.key === 'r' || e.key === 'R'),
    run: () => {
      const s = useEditor.getState();
      const id = s.selectedIds[0];
      if (!id) return false;
      const conn = s.diagram.connectors.find((c) => c.id === id);
      if (!conn) return false;
      s.updateConnector(conn.id, { from: conn.to, to: conn.from });
      return true;
    },
  },
  {
    id: 'swap-connector',
    label: 'Swap connector endpoints',
    test: (e) => e.key === 'Tab',
    run: () => {
      const s = useEditor.getState();
      const id = s.selectedIds[0];
      if (!id) return false;
      const conn = s.diagram.connectors.find((c) => c.id === id);
      if (!conn) return false;
      s.updateConnector(conn.id, { from: conn.to, to: conn.from });
      return true;
    },
  },

  // ─── File ───────────────────────────────────────────────────────────────
  {
    id: 'save-as',
    label: 'Save as…',
    test: (e) => m(e) && e.shiftKey && k(e) === 's',
    run: ok(() => {
      void handleSaveAs();
    }),
    allowInDialog: true,
  },
  {
    id: 'save',
    label: 'Save (format picker)',
    test: (e) => m(e) && !e.shiftKey && k(e) === 's',
    run: ok(() => useEditor.getState().setSaveDialogOpen(true)),
    allowInForm: true,
    allowInDialog: true,
  },
  {
    id: 'copy-png',
    label: 'Copy as PNG (selection, or the whole diagram)',
    test: (e) => m(e) && e.shiftKey && k(e) === 'c',
    run: ok(() => {
      const hasSelection = useEditor.getState().selectedIds.length > 0;
      void handleCopyPng({ area: hasSelection ? 'selection' : 'diagram' });
    }),
    allowInDialog: true,
  },
  {
    id: 'open',
    label: 'Open file',
    test: (e) => m(e) && k(e) === 'o',
    run: ok(() => {
      void handleOpen();
    }),
    allowInDialog: true,
  },
  // ⌥⌘N → new diagram. Plain Cmd+N is claimed by the browser/OS for "new
  // window"; Cmd+Shift+N is Incognito/Private. ⌥⌘N is the universally-
  // free fallback. On macOS Alt+letter emits a dead-key character
  // (Alt+N → "˜"), so we match on e.code rather than e.key.
  {
    id: 'new-diagram',
    label: 'New diagram',
    test: (e) => m(e) && e.altKey && e.code === 'KeyN',
    run: ok(() => handleNew()),
    allowInDialog: true,
  },

  // ─── Viewport ───────────────────────────────────────────────────────────
  {
    id: 'zoom-in',
    label: 'Zoom in',
    test: (e) => m(e) && (e.key === '=' || e.key === '+'),
    run: ok(() => useEditor.getState().zoomBy(1.2)),
    allowInDialog: true,
  },
  {
    id: 'zoom-out',
    label: 'Zoom out',
    test: (e) => m(e) && e.key === '-',
    run: ok(() => useEditor.getState().zoomBy(1 / 1.2)),
    allowInDialog: true,
  },
  {
    id: 'reset-view',
    label: 'Reset view',
    test: (e) => m(e) && e.key === '0',
    run: ok(() => useEditor.getState().resetView()),
    allowInDialog: true,
  },
  {
    id: 'fit-content',
    label: 'Fit to content',
    test: (e) => m(e) && e.key === '1',
    run: ok(() =>
      useEditor
        .getState()
        .fitToContent(window.innerWidth, window.innerHeight),
    ),
    allowInDialog: true,
  },

  // ─── Tools (bare keys) ──────────────────────────────────────────────────
  // Bare-key tool shortcuts are suppressed inside dialogs and menus.
  {
    id: 'toggle-lock',
    label: 'Toggle tool lock',
    test: (e) => !m(e) && (e.key === 'q' || e.key === 'Q'),
    run: ok(() => useEditor.getState().toggleLock()),
  },
  // W neighbours Q under the left hand - the other persistent gesture-mode
  // switch, and the nearest free key to it. Unlike the N sticky-note tool
  // this needs no layer gate: switching to a hidden layer widens the view to
  // it (see setActiveLayer), so the key can never strand the user.
  {
    id: 'toggle-draw-layer',
    label: 'Switch draw layer (Notes / Blueprint)',
    test: (e) => !m(e) && (e.key === 'w' || e.key === 'W'),
    run: ok(() => useEditor.getState().toggleActiveLayer()),
  },
  {
    id: 'toggle-library',
    label: 'Toggle library panel',
    test: (e) => !m(e) && !e.shiftKey && (e.key === 's' || e.key === 'S'),
    run: ok(() => useEditor.getState().toggleLibraryPanel()),
  },
  {
    id: 'tool-digit',
    label: 'Activate tool 1-9',
    test: (e) => !m(e) && /^[1-9]$/.test(e.key),
    run: ok(() => useEditor.getState().setActiveTool(lastEvent.key as ToolKey)),
  },
  {
    id: 'tool-laser',
    label: 'Laser pointer',
    test: (e) => !m(e) && (e.key === 'l' || e.key === 'L'),
    run: ok(() => useEditor.getState().setActiveTool('l' as ToolKey)),
  },
  {
    id: 'tool-freeform',
    label: 'Freeform shape',
    test: (e) => !m(e) && !e.shiftKey && e.key.toLowerCase() === 'f',
    run: ok(() => useEditor.getState().setActiveTool('f')),
  },
  {
    id: 'tool-table',
    label: 'Table tool',
    test: (e) => !m(e) && (e.key === 't' || e.key === 'T'),
    run: ok(() => useEditor.getState().setActiveTool('t' as ToolKey)),
  },
  // N is layer-gated: only fires when Notes layer is in scope, matching
  // the FloatingToolbar button's visibility rule so users don't get a
  // phantom tool while working in Blueprint-only mode.
  {
    id: 'tool-note',
    label: 'Sticky-note tool',
    test: (e) => !m(e) && (e.key === 'n' || e.key === 'N'),
    run: () => {
      const lm = useEditor.getState().layerMode;
      if (lm !== 'notes' && lm !== 'both') return false;
      useEditor.getState().setActiveTool('n' as ToolKey);
      return true;
    },
  },
  {
    id: 'toggle-snap',
    label: 'Toggle workspace snap',
    test: (e) => !m(e) && !e.shiftKey && (e.key === 'x' || e.key === 'X'),
    run: ok(() => useEditor.getState().toggleSnapEnabled()),
  },
  {
    id: 'toggle-measurements',
    label: 'Toggle measurements',
    test: (e) => !m(e) && !e.shiftKey && (e.key === 'm' || e.key === 'M'),
    run: ok(() => {
      const st = useEditor.getState();
      st.setShowMeasurements(!st.showMeasurements);
    }),
  },
  {
    id: 'toggle-smart-anchors',
    label: 'Toggle workspace smart anchors',
    test: (e) => !m(e) && !e.shiftKey && (e.key === 'a' || e.key === 'A'),
    run: ok(() => {
      const st = useEditor.getState();
      st.setSmartAnchorsGlobal(!st.smartAnchorsGlobal);
    }),
  },
];

/** Default per-binding policy for "fire inside dialog/menu". Modifier
 *  shortcuts (Cmd/Ctrl present, OR shift-modifier when the bare key has
 *  no meaning on its own) are allowed by default; bare letter/digit
 *  shortcuts are blocked. Individual bindings can override via the
 *  `allowInDialog` field. */
function defaultAllowInDialog(b: KeybindingDef, e: KeyboardEvent): boolean {
  if (b.allowInDialog !== undefined) return b.allowInDialog;
  // Treat any chord with a modifier as dialog-safe by default - those are
  // the OS-level "save / undo / paste" muscle memory the user expects to
  // work everywhere.
  return e.metaKey || e.ctrlKey || e.altKey;
}

/** The dispatcher closes over the current event when calling each
 *  binding's `run`. The run callbacks read this rather than threading the
 *  event through every signature. Reset to the latest event at the top
 *  of every keydown. */
let lastEvent: KeyboardEvent = new KeyboardEvent('keydown');
function e_key_isUp(e: KeyboardEvent): boolean {
  return e.key === '>' || e.key === '.';
}

export function useKeybindings() {
  useEffect(() => {
    // Dev-only: detect chord conflicts at mount. Two bindings whose
    // tests are total-overlap aren't statically detectable (predicates
    // are arbitrary functions), but we can scan at dispatch time and warn
    // when more than one matches the live event. Kept behind import.meta
    // so the check shakes out of production builds.
    if (import.meta.env?.DEV) {
      const ids = new Set<string>();
      for (const b of BINDINGS) {
        if (ids.has(b.id)) {
          // eslint-disable-next-line no-console
          console.warn(`[keybindings] duplicate id "${b.id}"`);
        }
        ids.add(b.id);
      }
    }

    const onKey = (e: KeyboardEvent) => {
      lastEvent = e;
      const target = e.target;
      const inForm = isInForm(target);
      const inDialog = !inForm && isInDialog(target);

      // Escape is special: always closes overlays. In a form it ALSO
      // blurs the input; out of a form it clears the selection.
      if (e.key === 'Escape') {
        useEditor.getState().closeAllOverlays();
        if (inForm) {
          (target as HTMLElement).blur();
        } else {
          useEditor.getState().setSelected(null);
        }
        return;
      }

      // Dev-mode conflict scan: warn when 2+ bindings match the same
      // event. Predicate-based bindings can't be checked statically.
      if (import.meta.env?.DEV) {
        const hits = BINDINGS.filter((b) => b.test(e));
        if (hits.length > 1) {
          // eslint-disable-next-line no-console
          console.warn(
            `[keybindings] conflict: ${hits.map((h) => h.id).join(' vs ')}`,
            {
              key: e.key,
              code: e.code,
              meta: e.metaKey,
              ctrl: e.ctrlKey,
              shift: e.shiftKey,
              alt: e.altKey,
            },
          );
        }
      }

      for (const binding of BINDINGS) {
        if (!binding.test(e)) continue;
        if (inForm && !binding.allowInForm) continue;
        if (inDialog && !defaultAllowInDialog(binding, e)) continue;
        // First match wins, regardless of whether `run` actually fires:
        // matching the chord consumes the event from the dispatcher's
        // perspective. Only preventDefault if run returned true - that
        // lets state-guarded bindings (arrow keys with no selection,
        // R with no connector) fall through to the browser default.
        const fired = binding.run();
        if (fired) e.preventDefault();
        return;
      }

      // Don't swallow plain Space - Canvas needs it for pan/connector.
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Form-input detection. INPUT/TEXTAREA/SELECT/contentEditable is the
 *  classic text-entry surface; anything else (a button, a div, the body)
 *  is not. */
function isInForm(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    t.isContentEditable
  );
}

/** Keep bare-key shortcuts from changing the canvas while a dialog has focus.
 *  Anything inside a Radix dialog/menu (or any
 *  element tagged with `data-keybinding-scope="dialog"`) as "inside an
 *  overlay" and block bare-key shortcuts there. Modifier shortcuts
 *  (Cmd+S, Cmd+Z, …) still fire so users can save/undo from a dialog. */
function isInDialog(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return !!t.closest(
    '[role="dialog"], [role="menu"], [role="menuitem"], [data-keybinding-scope="dialog"]',
  );
}
