import { useEffect, useRef } from 'react';
import { useEditor } from '@/store/editor';
import { resolveSwatchColor } from '@/editor/swatches';
import { collapseAnchorForCell, anchorToFlex, tableLayout } from '../canvas/Shape';
import {
  domToMd,
  insertLineBreakAtCaret,
  mdToHtml,
} from '@/lib/inline-marks';
import type { LabelAnchor } from '@/store/types';
import { FloatingTextToolbar } from './InlineLabelEditor';

/** Cell-level inline editor for `kind: 'table'` shapes.
 *
 *  Pops a `contenteditable` div over the editing cell's bbox and routes
 *  keystrokes:
 *    - Enter (no shift) → commit, move down a row (creates a row below if
 *      we were on the last). Wraps to col=0 when going past last col-edit
 *      Tab fallback.
 *    - Tab → commit, move to next cell (right; wraps to next row's col 0).
 *    - Shift+Tab → commit, move to previous cell.
 *    - Esc / blur → commit, exit.
 *
 *  The component is parallel to InlineLabelEditor - separate because the
 *  navigation semantics (Tab walks the grid, not the next focusable element)
 *  differ enough that conditioning the existing editor would have made it
 *  harder to follow. */
export function InlineCellEditor() {
  const editingCell = useEditor((s) => s.editingCell);
  const setEditingCell = useEditor((s) => s.setEditingCell);
  const setCellText = useEditor((s) => s.setCellText);
  const insertTableRow = useEditor((s) => s.insertTableRow);
  const insertTableCol = useEditor((s) => s.insertTableCol);
  const shape = useEditor((s) =>
    editingCell
      ? s.diagram.shapes.find((sh) => sh.id === editingCell.shapeId) ?? null
      : null,
  );
  const pan = useEditor((s) => s.pan);
  const zoom = useEditor((s) => s.zoom);

  const editorRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const setCellPatch = useEditor((s) => s.setCellPatch);

  // Seed the editor with the cell's current text + select-all on each
  // (shapeId, row, col) change so cell-to-cell navigation reads naturally.
  useEffect(() => {
    if (!editingCell || !editorRef.current || !shape || shape.kind !== 'table') return;
    const el = editorRef.current;
    const cell = shape.cells?.[editingCell.row]?.[editingCell.col] ?? null;
    const initial = cell?.text ?? '';
    if (initial === '') {
      // Zero-width space anchors the caret without showing visible glyph.
      el.textContent = '​';
    } else {
      // Stored markers (**bold**, *italic*, __underline__) back to inline
      // HTML so a re-edit shows the formatting instead of the raw syntax.
      // mdToHtml only ever emits b/i/u/br + escaped text, so this is not a
      // sanitisation hole. Mirrors InlineLabelEditor's seed.
      el.innerHTML = mdToHtml(initial);
    }
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingCell?.shapeId, editingCell?.row, editingCell?.col]);

  // Self-heal a stranded cell-edit pointer. If the table leaves the diagram
  // mid-edit (tab switch, file open, undo, delete) the render below bails but
  // `editingCell` stays latched - and the Delete/Backspace keybinding refuses
  // to fire while any editing pointer is set, so the user silently loses the
  // ability to delete anything.
  useEffect(() => {
    if (editingCell && (!shape || shape.kind !== 'table')) setEditingCell(null);
  }, [editingCell, shape, setEditingCell]);

  if (!editingCell || !shape || shape.kind !== 'table') return null;

  // tableLayout is the single source of truth for cell positions across
  // renderer, hit-test, and editor. Reading it here means resized rows /
  // cols position the editor on the visible cell, not a phantom equal-
  // division rectangle.
  const layout = tableLayout(shape);
  const { rows, cols, rowEdges, colEdges, rowSizes, colSizes } = layout;
  const { row, col } = editingCell;
  if (row < 0 || row >= rows || col < 0 || col >= cols) return null;

  const worldX = colEdges[col];
  const worldY = rowEdges[row];
  const cellW = colSizes[col];
  const cellH = rowSizes[row];
  const screenX = worldX * zoom + pan.x;
  const screenY = worldY * zoom + pan.y;
  const screenW = cellW * zoom;
  const screenH = cellH * zoom;

  const cell = shape.cells?.[row]?.[col] ?? null;
  const tableCellAnchor: LabelAnchor = shape.cellAnchor ?? 'center';
  const anchor = collapseAnchorForCell(cell?.anchor ?? tableCellAnchor);
  const flex = anchorToFlex(anchor);

  // Match the rendered cell's typography so commit doesn't visibly jump.
  const onNotesLayer = shape.layer === 'notes';
  const tableFontFamily =
    shape.fontFamily ?? (onNotesLayer ? 'var(--font-sketch)' : 'var(--font-body)');
  const tableFontSize = shape.fontSize ?? 13;
  const cellFontFamily = cell?.fontFamily ?? tableFontFamily;
  const cellFontSize = (cell?.fontSize ?? tableFontSize) * zoom;
  const isHeader =
    (shape.headerRow && row === 0) || (shape.headerCol && col === 0);
  const cellFontWeight = isHeader ? 600 : 400;
  const cellTextColor =
    cell?.textColor ??
    shape.textColor ??
    // Match the renderer (Shape.tsx): legacy-hex strokes resolve to their
    // theme-aware var so the typing colour and the painted colour line up.
    resolveSwatchColor(shape.stroke, 'stroke') ??
    (onNotesLayer ? 'var(--notes-ink)' : 'var(--ink)');

  /** DOM -> inline markdown, so bold / italic / underline applied from the
   *  floating toolbar survive the commit. `innerText` (what this used to
   *  read) flattens the <b>/<i>/<u> execCommand produced, which is why
   *  Bold looked like it did nothing in a table cell: the mark rendered
   *  while typing and was thrown away the moment the cell committed.
   *  domToMd strips the ZWSP caret seed itself. */
  const readText = (): string => domToMd(editorRef.current);

  const commitCurrent = () => {
    const text = readText();
    const cur = (cell?.text ?? '');
    if (text !== cur) {
      setCellText(shape.id, row, col, text);
    }
  };

  const exit = () => {
    commitCurrent();
    setEditingCell(null);
  };

  /** Move to (r, c). If r === rows we add a row first; if c === cols we add
   *  a column first. Both intent-driven - Tab past the last col should
   *  expand the table, matching what users expect from spreadsheets. */
  const moveTo = (r: number, c: number) => {
    commitCurrent();
    let nextR = r;
    let nextC = c;
    let shapeRows = rows;
    let shapeCols = cols;
    // Wrap col past the right edge → new column at end.
    if (c >= cols) {
      insertTableCol(shape.id, cols);
      shapeCols = cols + 1;
      nextC = cols; // newly inserted column
    } else if (c < 0) {
      // Backwards wrap from col 0: previous row, last col.
      if (r > 0) {
        nextR = r - 1;
        nextC = shapeCols - 1;
      } else {
        // At (0,0) going back - clamp to (0,0).
        nextR = 0;
        nextC = 0;
      }
    }
    if (r >= shapeRows) {
      insertTableRow(shape.id, shapeRows);
      nextR = shapeRows; // newly inserted row
    } else if (r < 0) {
      nextR = 0;
    }
    setEditingCell({ shapeId: shape.id, row: nextR, col: nextC });
  };

  return (
    <>
      <FloatingTextToolbar
        editorRef={editorRef}
        toolbarRef={toolbarRef}
        screenX={screenX}
        screenY={screenY}
        screenW={screenW}
        currentFontFamily={cell?.fontFamily ?? shape.fontFamily}
        currentFontSize={cell?.fontSize ?? tableFontSize}
        currentTextColor={cell?.textColor ?? shape.textColor}
        // Per-cell typography writes go through setCellPatch so they live
        // in the cell, not on the shape. That way changing one cell's
        // font / size / colour doesn't bleed into the rest of the table.
        onFontFamily={(v) =>
          setCellPatch(shape.id, row, col, { fontFamily: v })
        }
        onFontSize={(v) =>
          setCellPatch(shape.id, row, col, { fontSize: v })
        }
        onTextColor={(v) =>
          setCellPatch(shape.id, row, col, { textColor: v })
        }
      />
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onPaste={(e) => {
          // Paste as plain text - cells are plain text, so strip any pasted
          // HTML/styling rather than letting the browser inject it.
          e.preventDefault();
          const text = e.clipboardData.getData('text/plain');
          if (text) document.execCommand('insertText', false, text);
        }}
        onContextMenu={(e) => {
          // The cell editor sits in an absolutely-positioned div that's a
          // sibling of the canvas SVG, NOT a descendant. So a right-click
          // here doesn't bubble to the SVG's onContextMenu - the user
          // ends up with the browser's native menu (or nothing visible)
          // instead of Vellum's table cell menu. Reported as "right-click
          // sometimes doesn't work on tables".
          // Fix: commit + close the editor, then re-fire a contextmenu
          // event at the same client coords on the SVG so the canvas
          // handler runs and shows the cell menu.
          e.preventDefault();
          const cx = e.clientX;
          const cy = e.clientY;
          exit();
          const svg = document.querySelector(
            '[data-vellum-canvas]',
          ) as SVGSVGElement | null;
          if (svg) {
            svg.dispatchEvent(
              new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                clientX: cx,
                clientY: cy,
                button: 2,
              }),
            );
          }
        }}
        onBlur={(e) => {
          // Don't commit when focus is jumping to the floating toolbar -
          // same pattern as InlineLabelEditor. The toolbar root carries
          // toolbarRef; clicks on its font picker / size input / swatches
          // shift focus there and we don't want that to end the edit.
          const next = e.relatedTarget as Node | null;
          if (next && toolbarRef.current?.contains(next)) return;
          exit();
        }}
        onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          // Esc → commit current cell and exit. (Symmetric with the label
          // editor; "abandon edit without saving" is rarely what the user
          // wants for cell text.)
          exit();
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          // Enter → next row, same column. If past last row, the next
          // moveTo() will insert one for us.
          moveTo(row + 1, col);
          return;
        }
        if (e.key === 'Enter' && e.shiftKey) {
          e.preventDefault();
          // ⇧Enter → line break inside the cell (Enter is taken by "next
          // row"). Left to the browser's default this did nothing at all:
          // Chrome declines to insert a break in a `display: flex`
          // contenteditable, so every ⇧Enter here was silently swallowed.
          insertLineBreakAtCaret(editorRef.current);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          if (e.shiftKey) {
            // Shift+Tab → previous cell. col-1 wraps to (row-1, lastCol).
            moveTo(col === 0 ? row : row, col - 1);
          } else {
            // Tab → next cell. col+1 wraps to (row, cols) which expands.
            // To match spreadsheet flow we go right; if past last col,
            // moveTo expands the table by one column. (Auto-wrapping to
            // next-row-col-0 is also reasonable; we picked "expand" so
            // Tab through a row produces a wider table, while Enter is
            // the explicit "go down" key.)
            moveTo(row, col + 1);
          }
          return;
        }
      }}
      style={{
        position: 'absolute',
        left: screenX,
        top: screenY,
        width: screenW,
        height: screenH,
        display: 'flex',
        flexDirection: 'column',
        alignItems: flex.alignItems,
        justifyContent: flex.justifyContent,
        textAlign: flex.textAlign,
        padding: '4px 6px',
        // Faint accent ring so the user sees which cell they're editing.
        // No opaque fill - the underlying header tint / per-cell fill
        // shows through, which matches what'll paint on commit.
        border: '1px solid var(--accent)',
        background: 'transparent',
        color: cellTextColor,
        fontFamily: cellFontFamily,
        fontSize: cellFontSize,
        fontWeight: cellFontWeight,
        lineHeight: 1.2,
        outline: 'none',
        whiteSpace: 'pre-wrap',
        overflow: 'hidden',
        zIndex: 30,
        boxShadow: '0 0 0 3px rgba(31,111,235,0.18)',
        cursor: 'text',
        boxSizing: 'border-box',
      }}
      />
    </>
  );
}
