import { captureFragment, fragmentBounds, remapFragment, type DiagramFragment } from './fragments';
import { syncRacks, clearRackUnit, swapRackUnitPositions, assignRackUnitIcon } from '@/editor/rack/model';
import { syncBoundaryEvents, isBpmnActivity, hiddenByCollapsedAncestor } from '@/editor/notation/model';
import { create } from 'zustand';
import { persist, type PersistStorage } from 'zustand/middleware';
import { recoveryStorage, reportRecoveryError } from './recovery-storage';

import type {
  Anchor,
  Connector,
  ConnectorEndpoint,
  DiagramAssetEntry,
  DiagramState,
  HotkeyBindings,
  Layer,
  LayerMode,
  Shape,
  ShapeKind,
  StrokeGradient,
  TableCell,
  Theme,
  ToolKey,
} from './types';
import { assetHashFromSrc, isAssetSrc } from '../lib/doc-assets';
import { parseDiagram, parseClipboardEnvelope, type WorkspacePayload } from './schema';
import { renderPipeline } from '@/fixtures/render-pipeline';
import {
  isVerticalDir,
  measureText,
  SHRINK_WRAP_SLACK,
  TEXT_BOX_PAD_X,
  TEXT_DEFAULT_FONT_FAMILY,
  TEXT_DEFAULT_FONT_SIZE,
  TEXT_DEFAULT_FONT_WEIGHT,
} from '@/editor/canvas/measure-text';
import {
  resolveConnectorPath,
  resolvedAnchorOrCentre,
} from '@/editor/canvas/routing';
// Pure geometry planner for typed bbox edits - see planBoxEdit. Is with
// the other bbox math in projection.ts (React-free, node-testable) so the
// group/container/text special cases are stated once and can be unit-tested
// without booting the store.
import {
  GROUP_FRAME_PAD,
  mirrorFreehandPoints,
  planBoxEdit,
  shapeSupportsMirror,
  type BoxEdit,
} from '@/editor/canvas/projection';
// prism.ts is React-free and imports only types from ./types, so this is a
// safe one-way dependency - the renderer's "can this kind paint an outline?"
// gate stays the single source of truth for the sticky-style stamp too.
import { shapeKindSupportsPrismStroke } from '@/editor/canvas/prism';
// Pure tree / layer / z-order helpers. hierarchy.ts + layers.ts live next
// to this store; z-order.ts sits with the canvas because the renderer is
// its primary consumer, but it is React-free and imports nothing from here.
import {
  expandAllDescendants,
  expandGroupDescendants,
  isDescendantOf,
  shapeIndex,
} from './hierarchy';
import {
  connectorLayer,
  shapeVisibleInMode,
  visibleItemIds,
} from './layers';
import {
  effectiveZMap,
  nextZ as nextZOf,
  reorderZ,
  type ZOrderOp,
} from '@/editor/canvas/z-order';
// Pure (DOM-free) export option helpers - see editor/export/options.ts.
import {
  DEFAULT_EXPORT_PREFS,
  sanitizeExportPrefs,
  type ExportFormat,
  type ExportPrefs,
} from '@/editor/export/options';
import {
  DEFAULT_TEXT_SCALE,
  sanitizeTextScale,
  type TextScale,
} from '@/editor/text-scale';
// renderPipeline is exposed through the file menu rather than booted by default.
void renderPipeline;

/** Auto-fit for kind:'text' shapes.
 *
 *  Returns `s` unchanged when:
 *    - kind isn't 'text' (other shapes' bbox is user-driven, not text-driven)
 *    - we're not in a browser (SSR / test environments without DOM)
 *
 *  Otherwise re-measures the text and writes back w/h:
 *    - autoSize !== false → both axes follow content (longest line, line count)
 *    - autoSize === false → width pinned to current s.w; height auto-grows
 *      with wrapping
 *
 *  Called from every mutation path that can change a text shape's geometry
 *  or content: addShape, addShapes, updateShape, updateShapeLive,
 *  updateShapesLive, plus the resize handler in Canvas.tsx (indirectly,
 *  via the same paths). The cost is one offscreen DOM read per text shape
 *  per mutation - cheap and bounded. */
function applyTextAutoFit(s: Shape): Shape {
  if (s.kind !== 'text') return s;
  // One-field invariant: a text shape's string is in `label`. Producers
  // that construct shapes in TS and hand them straight to addShape /
  // addFragment (importers, Blueprintr's AI transcription) bypass
  // ShapeSchema's identical fold, so re-apply it here - otherwise the shape
  // renders `body` but InlineLabelEditor edits `label`, and the two strings
  // end up stacked on top of each other. See Shape.body.
  if (s.body !== undefined) {
    const { body, ...rest } = s;
    s = { ...rest, label: s.label || body } as Shape;
  }
  // Backward compat: legacy text shapes saved before autoSize existed
  // have user-set w/h that we mustn't overwrite. Skip autoFit when the
  // mode marker is missing.
  if (s.autoSize === undefined) return s;
  if (typeof document === 'undefined') return s;
  const fontFamily = s.fontFamily ?? TEXT_DEFAULT_FONT_FAMILY;
  const fontSize = s.fontSize ?? TEXT_DEFAULT_FONT_SIZE;
  const fontWeight = TEXT_DEFAULT_FONT_WEIGHT;
  // `label` is the only text field a text shape has (the fold above
  // guarantees it). Empty → measure ZWSP so the bbox still has a one-line
  // height for the editor caret to sit in.
  const text = s.label ?? '';
  // Every branch below derives `h` from the rendered text. `minH` is the
  // user's n/s edge drag talking: honour it as a FLOOR so a deliberately
  // roomy caption box keeps the height it was dragged to, while text that
  // outgrows that height still pushes the box taller instead of clipping.
  const floorH = (h: number) => (s.minH !== undefined ? Math.max(h, s.minH) : h);

  // Vertical text always shrink-wraps BOTH axes - there's no "wrap the
  // column to a width" gesture, so the wrap / fit branches below don't
  // apply. The long axis is now the height (the column), the cross axis
  // (width) grows as lines stack right-to-left. measureText returns the
  // actual rotated pixel box, so we just pad it. Padding lands on the
  // cross axis (width) - the gap that keeps a stroke off the glyphs - to
  // mirror the horizontal case where TEXT_BOX_PAD_X pads the writing-mode
  // cross axis too.
  if (isVerticalDir(s.textDirection)) {
    const { w, h } = measureText({
      text,
      fontFamily,
      fontSize,
      fontWeight,
      direction: s.textDirection,
    });
    return {
      ...s,
      w: w + 2 * TEXT_BOX_PAD_X,
      h: floorH(h),
    };
  }

  if (s.autoSize === true) {
    // Shrink-wrap: bbox = rendered text size + horizontal padding so a
    // stroke applied to the shape doesn't paint flush against the
    // glyphs. Vertical pad is 0 (line-height already gives headroom).
    // Plus SHRINK_WRAP_SLACK so a horizontal-edge drag can nudge inward
    // a touch without immediately cutting into the text and engaging
    // wrap mode - without this slack, any inward HEdge drag wraps
    // instantly, which read as "resize always wraps".
    const { w, h } = measureText({ text, fontFamily, fontSize, fontWeight });
    const bboxW = w + 2 * TEXT_BOX_PAD_X + SHRINK_WRAP_SLACK;
    // No caps on either axis: the bbox tracks content indefinitely
    // Growth past the viewport edge is handled by
    // InlineLabelEditor's auto-pan, which follows the bbox while typing -
    // capping here used to flip the shape into wrap mode and eventually
    // an internal scrollbar, which was dead UX in view mode (the shape's
    // foreignObject is pointer-events:none, so the scrollbar couldn't be
    // dragged). Wrap mode is now only ever entered by an explicit e/w
    // edge drag.
    return { ...s, w: bboxW, h: floorH(h) };
  }

  if (s.autoSize === 'fit') {
    // Fit mode (legacy - new corner-drags now write autoSize:false +
    // explicit fontSize instead, see Canvas.tsx). fontSize is preserved
    // as-is; bbox height TRACKS the wrapped content. Typing a newline
    // doesn't shrink the font (which used to surprise people - adding
    // text shouldn't make the existing text smaller); deleting lines
    // shrinks the box back down. Width still drives wrap.
    const wrap = Math.max(s.w - 2 * TEXT_BOX_PAD_X, fontSize * 2);
    const { h: measured } = measureText({
      text,
      fontFamily,
      fontSize,
      fontWeight,
      maxWidth: wrap,
    });
    return { ...s, h: floorH(measured) };
  }

  // autoSize === false → wrap mode. Width is PINNED (set by drag-create
  // or edge-resize); height TRACKS the wrapped content - adding lines
  // grows it, deleting lines shrinks it back. We deliberately don't
  // preserve a high-water "user dragged this tall once" minimum: the
  // dragged height was used at create time to pick fontSize (so a tall
  // drag = big text), and from then on the height should reflect what's
  // actually being rendered. Otherwise pasting + deleting a paragraph
  // leaves a giant empty box behind. No height cap - the bbox grows with
  // the content and InlineLabelEditor's auto-pan keeps the growing edge
  // on screen while typing.
  const wrap = Math.max(s.w - 2 * TEXT_BOX_PAD_X, fontSize * 2);
  const { h: measured } = measureText({
    text,
    fontFamily,
    fontSize,
    fontWeight,
    maxWidth: wrap,
  });
  return { ...s, h: floorH(measured) };
}

/** Manual-fontSize-on-fit-shape handler.
 *
 *  In `'fit'` mode, fontSize is normally DERIVED from the bbox by
 *  applyTextAutoFit. But the user can also manually pick a fontSize
 *  (inspector field, +/- buttons, preset dropdown). Without a hook,
 *  applyTextAutoFit re-derives fontSize from the unchanged bbox and
 *  overwrites the user's choice.
 *
 *  This helper detects "patch is JUST a fontSize change on a fit
 *  shape" and resizes the bbox to match the new fontSize. Then
 *  applyTextAutoFit converges with scale=1 (bbox already fits text at
 *  fontSize=v) and the user's pick survives. */
function applyManualFontSizeOnFit(
  merged: Shape,
  patch: Partial<Shape>,
): Shape {
  if (
    merged.kind !== 'text' ||
    merged.autoSize !== 'fit' ||
    patch.fontSize === undefined ||
    patch.w !== undefined ||
    patch.h !== undefined
  ) {
    return merged;
  }
  if (typeof document === 'undefined') return merged;
  const text = merged.label ?? '';
  const ref = measureText({
    text,
    fontFamily: merged.fontFamily ?? TEXT_DEFAULT_FONT_FAMILY,
    fontSize: merged.fontSize ?? TEXT_DEFAULT_FONT_SIZE,
    fontWeight: TEXT_DEFAULT_FONT_WEIGHT,
  });
  return { ...merged, w: ref.w + 2 * TEXT_BOX_PAD_X, h: ref.h };
}

/** Default hotkey bindings - fixed mapping. The user can no longer rebind
 *  these slots (the rebind affordance was removed once the slot count grew
 *  to cover everything we surface in the toolbar). */
export const DEFAULT_BINDINGS: HotkeyBindings = {
  '1': { tool: 'select', label: 'Select', icon: 'cursor' },
  '2': { tool: 'rect', label: 'Rectangle', icon: 'rect' },
  '3': { tool: 'ellipse', label: 'Ellipse', icon: 'ellipse' },
  '4': { tool: 'diamond', label: 'Diamond', icon: 'diamond' },
  '5': { tool: 'arrow', label: 'Arrow', icon: 'arrow' },
  '6': { tool: 'line', label: 'Line', icon: 'line' },
  '7': { tool: 'text', label: 'Text', icon: 'text' },
  // 8 = container frame, 9 = freehand pen.
  '8': { tool: 'container', label: 'Container', icon: 'container' },
  '9': { tool: 'pen', label: 'Freehand pen', icon: 'pen' },
  'f': { tool: 'freeform', label: 'Freeform shape', icon: 'pen' },
  // L = laser pointer (was K). The 'k' slot retained for back-compat -
  // useKeybindings still routes it to the laser tool, but the chrome
  // surfaces the L key instead.
  'l': { tool: 'laser', label: 'Laser pointer', icon: 'laser' },
  // T = basic table. Is outside the fixed 1–9 row alongside L (laser) -
  // tables are a niche-but-handy shape kind that didn't earn a digit slot.
  't': { tool: 'table', label: 'Table', icon: 'table' },
  // 'n' surfaces only on the Notes layer - see FloatingToolbar's conditional
  // render. The tool itself is the existing 'note' (sticky-note) shape.
  'n': { tool: 'note', label: 'Sticky note', icon: 'note' },
};

/** Maximum number of undo states retained. Past 100, drops the oldest. */
const HISTORY_LIMIT = 100;

/** Discriminated key for the contextual tip-toast (TipToast.tsx). The set is
 *  closed: TipToast.tsx owns the user-facing copy + the ⌘/Ctrl substitution,
 *  and the canvas just publishes whichever key matches the gesture in flight.
 *
 *  When you add a tip:
 *    1. Add a TipKey here.
 *    2. Add the body string to TIP_BODIES in TipToast.tsx (use {{mod}},
 *       {{alt}}, {{shift}} for the modifier-key placeholders - TipToast
 *       renders the OS-appropriate label: ⌘/Ctrl, ⌥opt/Alt, ⇧shift/Shift).
 *    3. Publish the key from wherever the gesture is - usually
 *       `setActiveTipKey(...)` from Canvas.tsx's setInteraction. */
export type TipKey =
  /** Shape-creation aspect lock (rect → square, ellipse → circle, etc). */
  | 'shift-perfect-square'
  | 'shift-perfect-circle'
  | 'shift-perfect-diamond'
  /** Shape drag: ⌘ duplicate, ⌥ free-place, ⇧ axis-lock. */
  | 'drag-shape'
  /** Connector draw / endpoint / whole-line move: ⌥ free-place, ⇧ axis-lock. */
  | 'drag-connector'
  /** Corner resize: ⌘ from-centre, ⌥ free-resize, ⇧ lock-ratio. */
  | 'resize-corner'
  /** Edge/middle resize: ⌘ both-sides, ⌥ free-resize, ⇧ lock-ratio. */
  | 'resize-edge'
  /** Rotation: ⌥ frees the angle (default snaps to 15°). */
  | 'rotate-free'
  | 'right-click-delete-bend'
  | 'dblclick-group-select'
  /** Inline label / body edit: how to add a line break vs finish the edit.
   *  Published while the editor is open - the one gesture in the app whose
   *  Enter key does NOT do the obvious thing. */
  | 'label-edit-newline';

/** Internal clipboard payload - independent of the OS clipboard. Shapes cloned
 *  with new ids on paste, plus any connectors whose endpoints both land in the
 *  pasted set. `assets` carries the content-addressed registry entries the
 *  copied shapes reference (doc-assets) - without them, pasting an image
 *  shape into ANOTHER tab would leave its `asset:` src dangling, since the
 *  registry is per-diagram. */
type ClipboardPayload = DiagramFragment;

/** A snapshot of one tab's diagram + file state. Stored only for BACKGROUND
 *  tabs - the active tab's content is directly in `s.diagram` /
 *  `s.filePath` / `s.dirty` so the rest of the editor reads it the same
 *  way it always has. Switch-tab swaps the active tab's slot in / out of
 *  these locations. */
export type DiagramTabSnapshot = {
  diagram: DiagramState;
  filePath: string | null;
  dirty: boolean;
};

/** Per-tab undo/redo stacks. The active tab's stacks live in root
 *  `s.past` / `s.future` - same shape as before. When a tab goes
 *  inactive its stacks move into `tabHistories[id]`; switching back
 *  pulls them out so Cmd+Z continues from where the user left off in
 *  that tab. Session-only - not in the persisted slice (history can
 *  hold up to 100 full-diagram snapshots per tab, which would blow
 *  past the 5–10 MB localStorage cap on a moderately busy workspace).
 *  History reset semantics (loadDiagram, newDiagram, etc.) wipe both
 *  the active stacks and tabHistories together. */
export type TabHistory = {
  past: HistoryEntry[];
  future: HistoryEntry[];
};

/** Discriminated history entry. `kind: 'diagram'` is the bread-and-butter
 *  form pushed by every shape mutation - cheap (one DiagramState pointer).
 *  `kind: 'tabs'` captures the tab structure plus the active tab's
 *  state, used by tab-level operations (close-tab, soon: drag-reorder if
 *  we want it undoable). One unified stack keeps Cmd+Z's mental model
 *  intact: it always undoes the most recent action regardless of category.
 *
 *  The `past` / `future` / `tabHistories` fields on a `'tabs'` entry are
 *  the per-tab undo stacks AT THE TIME of the event - without them an
 *  active-tab close + undo would land back on the closed tab but with
 *  whatever history happened to be on the active stacks, losing the
 *  closed tab's prior diagram-edit chain. */
export type HistoryEntry =
  | {
      kind: 'diagram';
      diagram: DiagramState;
      /** Selection at the moment the entry was captured, i.e. what was
       *  selected BEFORE the edit it undoes. Undo puts it back (pruned to
       *  ids that still exist and are visible) so the inspector doesn't
       *  vanish the instant the user reverts a property change, and an
       *  undone delete hands the shapes back selected. Optional so an
       *  entry built without it (older code paths, fixtures) still
       *  undoes - it just lands unselected. */
      selectedIds?: readonly string[];
    }
  | {
      kind: 'tabs';
      diagram: DiagramState;
      filePath: string | null;
      dirty: boolean;
      diagramTabs: { id: string }[];
      activeTabId: string;
      tabSnapshots: Record<string, DiagramTabSnapshot>;
      past: HistoryEntry[];
      future: HistoryEntry[];
      tabHistories: Record<string, TabHistory>;
    };

/** Default + bounds for the resizable bottom tabs bar. Default leaves tabs
 *  legible without a resize; min keeps the close-tab × clickable; max
 *  caps the bar at ~30% of a typical viewport so a runaway drag (or stale
 *  persisted value) can't swallow the canvas. */
export const TABS_BAR_DEFAULT_PX = 22;
export const TABS_BAR_MIN_PX = 16;
export const TABS_BAR_MAX_PX = 240;

/** The tabs bar's on-screen height. `tabsBarHeight` is stored at 100% text
 *  size; Settings ▸ Text size grows the bar by the same factor as its
 *  labels. Anything positioned against the bar should use this (or the
 *  `--vellum-tabs-h` variable the editor root sets), not the raw value. */
export function renderedTabsBarHeight(height: number, textScale: number): number {
  return Math.round(height * textScale);
}

/** Default + bounds for the resizable right dock - the full-height panel
 *  column that CONTRACTS the editor rather than floating over it (see the
 *  `rightDock` plugin slot). Min keeps a panel's controls usable; max caps
 *  it so a runaway drag or a stale persisted value can't squeeze the canvas
 *  to nothing on a small viewport. The effective width is additionally
 *  clamped against the live viewport at render time. */
export const RIGHT_DOCK_DEFAULT_PX = 380;
export const RIGHT_DOCK_MIN_PX = 280;
export const RIGHT_DOCK_MAX_PX = 720;

export type EditorState = {
  // file
  diagram: DiagramState;
  filePath: string | null;
  dirty: boolean;
  workspaceId: string;
  workspaceRevision: number;
  savedRevision: number;
  /** Original view while a multi-tab export temporarily renders other tabs. */
  exportReturnTabId: string | null;
  /** Wall-clock time of the last successful save (`Date.now()`); null if never
   *  saved this session. Drives the brand pill's "autosaved Ns ago" copy. */
  lastSavedAt: number | null;

  /** Multi-diagram tabs (top-right `diagramTabs` plugin slot). Always
   *  contains at least one entry - the active one. Background tabs'
   *  diagram + filePath + dirty flag live in `tabSnapshots`; the active
   *  tab's state remains in the canonical `s.diagram` / `s.filePath` /
   *  `s.dirty` slots so existing readers don't have to thread an active-
   *  tab indirection. Switching a tab snapshots the current slots into
   *  `tabSnapshots[old]` and pulls `tabSnapshots[new]` back out.
   *
   *  The workspace file handle is session-only and shared by its tabs.
   *  Switching tabs keeps that destination for Save and autosave. */
  diagramTabs: { id: string }[];
  activeTabId: string;
  tabSnapshots: Record<string, DiagramTabSnapshot>;
  /** Per-tab undo/redo stacks for inactive tabs. The active tab's
   *  history continues to live in root `past` / `future`; switch swaps
   *  the active tab's stacks in/out of this map. See TabHistory's docs
   *  for why this is session-only. */
  tabHistories: Record<string, TabHistory>;
  openNewDiagramTab: () => void;
  switchDiagramTab: (id: string, temporary?: boolean) => void;
  closeDiagramTab: (id: string) => void;
  /** Clone a tab into a new sibling. The clone gets a deep copy of the
   *  source diagram (so edits don't bleed across), is inserted directly
   *  after the source in tab order, and becomes the active tab. The clone
   *  belongs to the same workspace file as its source. */
  duplicateDiagramTab: (id: string) => void;

  /** User-resizable height of the diagram-tabs bar (the slim bottom
   *  strip). Defaults to TABS_BAR_DEFAULT_PX; user can drag the top edge
   *  to taste. Persisted across sessions. Clamped to [TABS_BAR_MIN_PX,
   *  TABS_BAR_MAX_PX] at write time so a stale localStorage value can't
   *  produce a 5px slice or a half-screen bar. */
  tabsBarHeight: number;
  setTabsBarHeight: (h: number) => void;

  /** Right dock - a full-height panel column on the trailing edge that
   *  CONTRACTS the editor instead of overlaying it: the canvas and every
   *  piece of floating chrome are inset by `rightDockWidth` while it's
   *  open, so nothing is ever hidden underneath a panel. Content comes
   *  from the `rightDock` plugin slot; core owns only the geometry.
   *
   *  Open state and width are persisted separately so closing the dock
   *  remembers the width the user dragged it to. Width is clamped to
   *  [RIGHT_DOCK_MIN_PX, RIGHT_DOCK_MAX_PX] at write time. */
  rightDockOpen: boolean;
  setRightDockOpen: (open: boolean) => void;
  rightDockWidth: number;
  setRightDockWidth: (w: number) => void;

  /** Collapse state for the diagram-tabs bar. When true, the bar is
   *  replaced by a small floating chevron in the bottom-right that
   *  expands it again. Persisted so the user's preferred reading mode
   *  survives reloads. Distinct from "no plugin contributes the slot"
   *  (embedded build) - collapse is a per-user preference, slot
   *  presence is a per-deployment knob. */
  tabsBarCollapsed: boolean;
  toggleTabsBarCollapsed: () => void;

  // viewport
  zoom: number;
  pan: { x: number; y: number };

  // selection
  selectedIds: string[];
  /** A group the user has "entered" via double-click. While set, hit-testing
   *  inside this group resolves to the group's members instead of the group
   *  itself ("enter group"). Cleared by
   *  Escape, by clicking outside the group's subtree, by ungroup/delete of
   *  the group, and by file open / undo. */
  focusedGroupId: string | null;

  // tooling
  activeTool: ToolKey;
  toolLock: boolean;
  hotkeyBindings: HotkeyBindings;

  // view
  layerMode: LayerMode;
  /** Which layer new shapes / connectors / strokes land on. Separate axis
   *  from `layerMode`: that one is "what can I see", this one is "what am I
   *  drawing on". They were the same field once, which meant the only way to
   *  add a note was to hide the blueprint you were annotating. The two are
   *  kept consistent - `setActiveLayer` widens `layerMode` when it would
   *  otherwise draw onto a hidden layer, and picking a single-layer view from
   *  the LayerPills re-points the draw target at it. */
  activeLayer: Layer;
  theme: Theme;
  /** Settings ▸ Text size: multiplier for every font size in the editor's
   *  own interface (menus, panels, dialogs). Diagram text is unaffected.
   *  Always one of TEXT_SCALE_OPTIONS - the setter and the persist merge
   *  snap anything else to the nearest step. Persisted. */
  uiTextScale: TextScale;

  // overlays
  morePopoverOpen: boolean;
  cmdkOpen: boolean;
  saveDialogOpen: boolean;
  /** Format the Save/Export dialog opens on. `null` = the dialog's own
   *  default (.vellum); `'image'` = the last image format the user picked
   *  (`exportPrefs.format`) - what "Export image…" entries pass. */
  saveDialogFormat: ExportFormat | 'image' | null;
  /** Open the dialog with "Selection" as the export area (context menu →
   *  "Export selection…"). Reset when the dialog closes. */
  saveDialogSelectionOnly: boolean;
  /** Persistent left-side library card. Toggled from the Brand expand button.
   *  Independent of `morePopoverOpen` (which is the floating quick-pick) so the
   *  user can have both surfaces open if they want - different muscle memory.
   *  Searches the local icon manifest when the user types a query. */
  libraryPanelOpen: boolean;
  /** TRADEMARK-COMPLIANCE: hamburger → "Legal" dialog state. The library
   *  picker also opens it via "Report an issue" / "About" links, so it
   *  needs to be store-scoped, not local to the menu. */
  legalDialogOpen: boolean;
  legalDialogTab: 'ip-complaints' | 'credits' | 'terms';
  /** Find/Replace panel visibility. Toggled with Cmd/Ctrl+F. The panel itself
   *  owns its query/replacement local state - only the visibility is on
   *  the store so the keybinding can flip it from the global handler. */
  findOpen: boolean;
  /** Visibility of the SVG, ZIP and VSSX library importer. */
  importDialogOpen: boolean;
  /** Right-side inspector visibility when nothing is selected. The inspector
   *  always renders for an active selection; this flag lets the user pin it
   *  open with an empty selection so they can pre-configure the default
   *  styles (`lastStyles` / `lastConnectorStyle`) before drawing. */
  inspectorOpen: boolean;
  /** Which inspector sections the user has folded shut, keyed by the
   *  namespaced section id the panels pass to `Section` (`shape:BODY`,
   *  `connector:ROUTING`). Persisted so a folded LAYER section stays folded
   *  across reloads - the same "remember my layout" contract as
   *  `libraryPanelOpen`. Absent key = open. */
  collapsedInspectorSections: Record<string, boolean>;

  // history (kept on the same store so all atomic mutations route through it)
  past: HistoryEntry[];
  future: HistoryEntry[];

  // clipboard (in-memory, session only - OS clipboard is a v2 concern)
  clipboard: ClipboardPayload | null;

  // -  - actions -  -

  // tool / overlay
  setActiveTool: (k: ToolKey) => void;
  toggleLock: () => void;
  setLayerMode: (m: LayerMode) => void;
  setActiveLayer: (l: Layer) => void;
  toggleActiveLayer: () => void;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  setUiTextScale: (scale: number) => void;
  toggleMorePopover: () => void;
  setMorePopoverOpen: (open: boolean) => void;
  toggleCmdk: () => void;
  setCmdkOpen: (open: boolean) => void;
  setSaveDialogOpen: (
    open: boolean,
    format?: ExportFormat | 'image',
    opts?: { selectionOnly?: boolean },
  ) => void;
  setFindOpen: (open: boolean) => void;
  toggleFind: () => void;
  /** Replace every occurrence of `find` in shape labels/body/sublabels,
   *  table cell text, and connector labels with `replacement`. Snapshots
   *  history once for the batch. Returns the number of replaced
   *  occurrences. Empty `find` is a no-op (returns 0). */
  replaceTextAll: (find: string, replacement: string, matchCase: boolean) => number;
  toggleLibraryPanel: () => void;
  setLibraryPanelOpen: (open: boolean) => void;
  /** TRADEMARK-COMPLIANCE - open Legal dialog on a specific tab. */
  openLegalDialog: (tab?: 'ip-complaints' | 'credits' | 'terms') => void;
  closeLegalDialog: () => void;
  /** TRADEMARK-COMPLIANCE - open/close Tier 2 import-library dialog. */
  setImportDialogOpen: (open: boolean) => void;
  toggleInspector: () => void;
  setInspectorOpen: (open: boolean) => void;
  /** Fold / unfold one inspector section (see `collapsedInspectorSections`). */
  toggleInspectorSection: (key: string) => void;
  /** Currently-editing shape id (the one whose label/body the inline editor
   *  is showing). Is on the store rather than as InlineLabelEditor's
   *  local state so Shape.tsx can read it and suppress its own label/body
   *  during edit - the inline editor renders transparently over the shape,
   *  so leaving the underlying text painted produced a ghosted-double of
   *  the typing position. */
  editingShapeId: string | null;
  setEditingShapeId: (id: string | null) => void;
  /** Connector currently being label-edited inline. Mirrors editingShapeId
   *  but for connectors - Connector.tsx reads it to suppress the rendered
   *  label while ConnectorLabelEditor overlays its contenteditable. Mutually
   *  exclusive with editingShapeId / editingCell. */
  editingConnectorId: string | null;
  setEditingConnectorId: (id: string | null) => void;
  /** Cell-edit pointer for table shapes. When set, InlineCellEditor opens
   *  a contenteditable over `cells[row][col]` of the named shape. Distinct
   *  from `editingShapeId` because cell-editing has its own navigation
   *  semantics (Tab/Enter walk the grid) and the renderer needs to suppress
   *  exactly one cell, not the shape. */
  editingCell: { shapeId: string; row: number; col: number } | null;
  setEditingCell: (loc: { shapeId: string; row: number; col: number } | null) => void;
  /** Cell-select pointer - set on a single click of a cell within an
   *  already-selected table. The inspector reads it to surface per-cell
   *  options without forcing the user to enter edit mode. Cleared when
   *  the table is no longer selected. */
  selectedCell: { shapeId: string; row: number; col: number } | null;
  setSelectedCell: (loc: { shapeId: string; row: number; col: number } | null) => void;
  /** Atomic per-cell mutations - each snapshots history once. */
  setCellText: (shapeId: string, row: number, col: number, text: string) => void;
  setCellPatch: (shapeId: string, row: number, col: number, patch: Partial<TableCell>) => void;
  /** Insert a row at `index` (0..rows). Cells are shifted down; new row is
   *  blank. Snapshots history. */
  insertTableRow: (shapeId: string, index: number) => void;
  /** Insert a column at `index` (0..cols). Cells are shifted right; new
   *  column is blank. */
  insertTableCol: (shapeId: string, index: number) => void;
  /** Delete the row at `index`. No-op if rows would drop below 1. */
  deleteTableRow: (shapeId: string, index: number) => void;
  /** Delete the column at `index`. No-op if cols would drop below 1. */
  deleteTableCol: (shapeId: string, index: number) => void;
  closeAllOverlays: () => void;

  // selection
  setSelected: (ids: string[] | string | null) => void;
  toggleSelected: (id: string) => void;
  addToSelection: (ids: string[]) => void;
  /** Enter / exit a focused group. Pass `null` to exit. The caller is
   *  responsible for selection - this action only flips the focus pointer. */
  setFocusedGroup: (id: string | null) => void;

  // viewport
  setZoom: (v: number) => void;
  zoomBy: (factor: number, around?: { x: number; y: number }) => void;
  setPan: (p: { x: number; y: number }) => void;
  panBy: (dx: number, dy: number) => void;
  fitToContent: (viewportWidth: number, viewportHeight: number) => void;
  resetView: () => void;

  // diagram mutation (each calls _snapshot() first; live drags skip history
  //                  by calling the *Live variants and committing once on up)
  addShape: (sh: Shape) => void;
  /** Merge entries into the diagram's content-addressed asset registry
   *  (lib/doc-assets.ts). Deliberately NOT a history snapshot: callers
   *  pair it with addShape (which snapshots), and undoing the shape can
   *  safely strand the entry - serialize-time pruning collects orphans.
   *  Idempotent per hash, so re-registering a pasted duplicate is free. */
  registerAssets: (entries: Record<string, DiagramAssetEntry>) => void;
  addShapes: (shs: Shape[]) => void;
  addConnector: (c: Connector) => void;
  /** Batch-add a fragment (shapes + connectors) into the active diagram in
   *  a SINGLE history step. Used by importers (Mermaid today, possibly
   *  drawio later) so a "discard import" undo restores the prior state in
   *  one ⌘Z rather than peeling shapes one by one. Selects the imported
   *  shapes after committing so the user can immediately reposition them. */
  addFragment: (shs: Shape[], conns: Connector[], assets?: Record<string, DiagramAssetEntry>) => void;
  /** Atomically remove a subset of shapes (and their descendants, if any are
   *  containers/groups) plus the connectors touching them, then append a new
   *  fragment - all wrapped in ONE history snapshot so undo wipes the whole
   *  replace in a single ⌘Z. Used by "Edit with AI" / "regenerate this
   *  region" consumers that swap out a subtree as one user-visible action.
   *
   *  Same descendant-expansion semantics as `deleteSelection`: a removed
   *  container/group takes its (recursive) children with it. Connectors
   *  whose endpoint references any removed shape (or whose own id appears
   *  in `removeIds`) are dropped to keep the diagram referentially
   *  consistent. The new fragment is z-stamped + text-autofitted exactly
   *  as `addFragment` does, and `selectedIds` is set to the new shape ids.
   *
   *  Empty `removeIds` makes this equivalent to `addFragment`; empty
   *  `shapes`/`connectors` makes it equivalent to a `deleteSelection`
   *  driven by `removeIds`. Both are valid one-snapshot operations. */
  replaceFragment: (
    removeIds: string[],
    shapes: Shape[],
    connectors: Connector[],
  ) => void;
  updateShape: (id: string, patch: Partial<Shape>) => void;
  /** Swap two rack U positions, retaining each unit's identity and links. */
  swapRackUnits: (sourceId: string, targetId: string) => void;
  /** Fill a U from a canvas icon. `live` folds the assignment into an active
   * drag; its caller must commitHistory at gesture end. */
  assignIconToRackUnit: (sourceId: string, targetId: string, live?: boolean) => boolean;
  /** Set a shape's bounding box from typed numbers (the inspector's ADVANCED
   *  `.x .y .w .h` fields) with the same semantics the on-canvas handles
   *  have. NOT the same as `updateShape(id, { w })`: a group's box is
   *  derived from its members, a container carries its children when moved
   *  but not when resized, and a text box's w/h are auto-fit outputs. The
   *  geometry is planned by the pure `planBoxEdit`; this action applies the
   *  patches, carries connector waypoints along a rigid move exactly as a
   *  nudge does, and commits ONE history step for the edit. Omitted
   *  keys are left alone, so each field commits independently. */
  setShapeBox: (id: string, box: BoxEdit) => void;
  updateShapeLive: (id: string, patch: Partial<Shape>) => void;
  updateShapesLive: (patches: { id: string; patch: Partial<Shape> }[]) => void;
  /** Like updateShapeLive but BYPASSES the text-shape autoFit. Used during
   *  a corner-resize drag on kind:'text' so the bbox tracks the cursor
   *  exactly instead of snapping to the measured text
   *  size on every frame. The resize commit (pointer-up) calls
   *  updateShape with the final patch, which DOES re-fit and snaps the
   *  bbox to the rendered text. */
  updateShapeLiveRaw: (id: string, patch: Partial<Shape>) => void;
  /** Apply a style/content patch to every currently-selected shape AND
   *  connector, with cross-type translation. The inspector previously only
   *  acted on `selectedIds[0]` - picking 5 shapes and changing fill only
   *  changed the first. This routes the full selection.
   *
   *  Cross-type translation rules (so "user intent" survives mixed selection):
   *    - For a recolorable monochrome icon shape, `fill` and `stroke` both
   *      map to the icon's tint (which is in `shape.stroke`). Changing
   *      "fill to red" with an icon + a rectangle selected paints the icon
   *      red AND fills the rectangle red.
   *    - For an icon that isn't recolorable (vendor or multi-colour iconify),
   *      colour patches are dropped - the asset's licence forbids tinting,
   *      and silently noop'ing is right.
   *    - For images, only `opacity` + `imageFilter` apply.
   *    - For connectors, `stroke`, `strokeWidth`, `opacity` apply directly;
   *      `strokeStyle` (the shape field) maps to connector `style`. Other
   *      fields are dropped - connectors don't have fill or fonts.
   *
   *  Snapshots once for the batch so undo restores everything in a
   *  single step. Mirrors lastStyles + lastConnectorStyle so the next-drawn
   *  shape inherits the choice. */
  updateSelection: (patch: Partial<Shape> & Partial<Connector>) => void;
  updateConnector: (id: string, patch: Partial<Connector>) => void;
  /** Mutate a connector without snapshotting - for waypoint dragging. The
   *  caller commits a single history step at gesture end via `commitHistory`. */
  updateConnectorLive: (id: string, patch: Partial<Connector>) => void;
  setShapeLayer: (id: string, layer: Layer) => void;
  /** Move every selected shape to `layer`. Multi-select friendly - the
   *  per-shape `setShapeLayer` only operates on the one id passed in, which
   *  surprises users when the inspector pretends to act on the whole
   *  selection. This action snapshots once and mutates the lot. */
  setSelectionLayer: (layer: Layer) => void;
  promoteSelection: () => void;
  demoteSelection: () => void;
  deleteSelection: () => void;
  bringForward: () => void;
  sendBackward: () => void;
  bringToFront: () => void;
  sendToBack: () => void;
  flipSelection: (axis: 'horizontal' | 'vertical') => void;
  /** Translate the current selection by `(dx, dy)` in world units. Mirrors the
   *  drag flow: expands selected groups/containers to their descendants, moves
   *  every shape's `x`/`y`, and carries connector waypoints + free-floating
   *  endpoints by the same delta (bound endpoints follow shapes naturally).
   *
   *  When `mode === 'estimate'`, `dx`/`dy` are interpreted as a *direction*
   *  (sign matters, magnitude doesn't) and the actual translation distance is
   *  derived from the gap to the nearest neighbour shape in that direction -
 * or the median gap between non-selected shapes when there's no neighbour
   *  to dock onto. Lets Cmd+Arrow reflow a card into evenly-spaced rows.
   *
   *  Snapshots once per call, so each keypress is a single undo step. Holding
   *  the arrow key down emits autorepeat events; users will undo a sustained
   *  nudge one tap at a time. Acceptable trade-off - collapsing repeats into
   *  one history entry across an unbounded time window is a separate feature. */
  nudgeSelection: (
    dx: number,
    dy: number,
    mode?: 'fixed' | 'estimate',
  ) => void;
  /** Wrap the current multi-selection in a `group` shape that bounds them all,
   *  then select the group. No-op for single-selections. */
  groupSelection: () => void;
  /** If a group is selected, ungroup it (remove the group, keep its children). */
  ungroupSelection: () => void;

  // history seam - public so live-drag handlers can commit a single history
  // step at the end of a gesture
  commitHistory: () => void;
  /** Abandon an in-flight live gesture: put the diagram back to the state
   *  captured before its first live mutation and forget it. No history
   *  entry either way. The Escape path of the inline text editor. */
  cancelHistory: () => void;
  /** Bracket a burst of ATOMIC edits so they seal as one undo step -
 * an inspector slider scrub or a colour-picker drag fires updateShape
   *  on every pointer frame, and without the bracket each frame was its
   *  own entry (Cmd+Z stepped the radius back 1px at a time). Inside the
   *  bracket every snapshot is deferred; endHistoryBatch pushes exactly
   *  one entry (none if nothing changed). Nestable; undo/redo and a
   *  document load reset the depth so a bracket that never closes can't
   *  wedge history. */
  beginHistoryBatch: () => void;
  endHistoryBatch: () => void;
  /** Remove a text shape whose editing session ended with no text. When
   *  the shape's creation is the most recent history entry (a text-tool
   *  click the user then abandoned) the creation is unwound instead of a
   *  delete being stacked on top of it - otherwise Cmd+Z would first
   *  resurrect an invisible, still hit-testable empty box and only the
   *  second press would do anything the user can see. Any live edits
   *  from the session are dropped first so the entry that IS recorded
   *  (for a pre-existing text the user emptied) restores the text as it
   *  was before the session. */
  discardEmptyTextShape: (id: string) => void;
  undo: () => void;
  redo: () => void;

  // clipboard
  copySelection: () => void;
  cutSelection: () => void;
  /** Paste from internal clipboard. If `at` is provided (world coords), the
   *  pasted bundle is centred there instead of offset from the originals. */
  paste: (at?: { x: number; y: number }) => void;
  duplicateSelection: () => void;
  /** Clone the given shapes (and any connector whose BOTH endpoints are in
   *  the set) in place - no offset - via the live-drag mutation path so the
   *  clones fold into the in-flight gesture's single undo step. Used by
   *  ⌘/Ctrl duplicate-on-drag in the canvas: the caller resets the originals
   *  to their start positions and drags the returned clones instead. Returns
   *  the original→clone id maps for shapes and connectors so the caller can
   *  repoint its drag bookkeeping at the copies. Does NOT touch selection -
 * the caller owns that. */
  duplicateShapesLive: (
    ids: string[],
  ) => { shapeIdMap: Map<string, string>; connIdMap: Map<string, string> };

  // file
  setFilePath: (path: string | null) => void;
  setDirty: (d: boolean) => void;
  markSaved: (receipt?: { workspaceId: string; revision: number; workspace: WorkspacePayload }) => void;
  applyDiagram: (diagram: DiagramState) => void;
  applyWorkspace: (workspace: WorkspacePayload) => void;
  loadDiagram: (d: DiagramState, path: string | null) => void;
  /** Replace the tab set with a workspace loaded from disk. The
   *  active tab's diagram lands in `s.diagram`; the rest go into
   *  `tabSnapshots`. The same `path` is set on every tab - they all
   *  belong to one .vellum file, even though only the active one's
   *  filePath was previously round-tripped. Optional per-tab title is
   *  read off each diagram's `meta.title`. */
  loadWorkspace: (
    payload: {
      activeTabId: string;
      tabs: { id: string; diagram: DiagramState }[];
    },
    path: string | null,
  ) => void;
  /** Set the title of a specific tab (background or active). For the
   *  active tab this snapshots history (matches setTitle). For background
   *  tabs we update the snapshot in place; no history step is recorded
   *  because the user isn't viewing that diagram. */
  renameDiagramTab: (id: string, title: string) => void;
  /** Move a tab to a new position in the order. Used by drag-reorder.
   *  No-op when from === to or when either index is out of range. */
  reorderDiagramTab: (fromIndex: number, toIndex: number) => void;
  newDiagram: () => void;
  setTitle: (t: string) => void;

  // tool bindings (Checkpoint D - drop on 1–9)
  bindHotkey: (key: ToolKey, def: HotkeyBindings[ToolKey]) => void;
  resetBindings: () => void;

  // canvas appearance (persisted with theme)
  canvasPaper?: string;     // CSS colour override for the canvas paper
  showDots: boolean;
  showGrid: boolean;        // major gridlines instead of dots
  /** Draw zoom-stable pixel dimensions beside every visible shape and the
   *  routed length beside every visible connector. This is editor chrome,
   *  not diagram content, so exports and saved .vellum files omit it. */
  showMeasurements: boolean;
  setCanvasPaper: (c: string | undefined) => void;
  setShowDots: (v: boolean) => void;
  setShowGrid: (v: boolean) => void;
  setShowMeasurements: (v: boolean) => void;
  /** Image-export settings (scale / padding / background / fonts).
   *  Persisted so the export dialog and the one-click Copy PNG button
   *  remember the last choice. Values are clamped on write - see
   *  `sanitizeExportPrefs`. */
  exportPrefs: ExportPrefs;
  setExportPrefs: (p: Partial<ExportPrefs>) => void;

  // contextual tip-toast (TipToast.tsx). `tipsEnabled` is the user-facing
  // master switch (Settings ▸ Editing ▸ Tips); persisted so the choice survives
  // reloads. `activeTipKey` is the *currently-displayed* tip - session-only,
  // pushed by gesture handlers (Canvas.tsx) and cleared on idle.
  tipsEnabled: boolean;
  setTipsEnabled: (v: boolean) => void;
  activeTipKey: TipKey | null;
  setActiveTipKey: (k: TipKey | null) => void;

  /** Workspace-level default for the per-shape `smartAnchor` field. When ON,
   *  every shape that hasn't explicitly opted out exposes the 8-point fixed
   *  anchor grid; when OFF (the default), only shapes with `smartAnchor:
   *  true` show them. The inspector header toggle still wins per shape, so
   *  flipping this on doesn't take the per-shape control away - it just
   *  changes which side of the gate is the default. Persisted across
   *  sessions alongside the other UI prefs. */
  smartAnchorsGlobal: boolean;
  setSmartAnchorsGlobal: (v: boolean) => void;

  /** Workspace default for the per-shape `smartAnchorCount`. Is alongside
   *  `smartAnchorsGlobal` and is what the canvas falls back to when a shape
   *  hasn't explicitly set its own count. Editable from the Defaults
   *  inspector header (matching the per-shape ± steppers). Persisted. */
  smartAnchorCountGlobal: number;
  setSmartAnchorCountGlobal: (n: number) => void;

  /** Snapping, split in two (Settings ▸ Editing ▸ Snapping):
   *   - shape snapping: drags and resizes align to nearby shapes' edges,
   *     centres, sizes and spacing, and connector ends attach anywhere along
   *     a shape's outline - off, they're left where dropped;
   *   - grid snapping: drags, resizes and connector points land on the
   *     visible grid - every 24 units, or the finer subdivisions that show
   *     as you zoom in - which forces gridlines on while it's enabled, and
   *     connector ends snap to connection points they come near.
   *  Without grid snapping an end only reaches a connection point by resting
   *  right on it (a quarter of a second with shape snapping on, half a second
   *  off). Both OFF is the Whiteboard setting: nothing snaps. ⌥/Alt held
   *  frees a single gesture from both. Persisted across sessions. */
  shapeSnapEnabled: boolean;
  gridSnapEnabled: boolean;
  setShapeSnapEnabled: (v: boolean) => void;
  setGridSnapEnabled: (v: boolean) => void;

  /** Snap master switch (Settings, the ⋮ menu, X, the Defaults magnet). ON
   *  while either half is on - always `shapeSnapEnabled || gridSnapEnabled`,
   *  kept in step by every snap setter, so read it but never write it
   *  directly (embedders read it too). Setting or toggling the master
   *  writes both halves. */
  snapEnabled: boolean;
  setSnapEnabled: (v: boolean) => void;
  toggleSnapEnabled: () => void;

  /** First-run welcome (OnboardingDialog). Defaults to `false`; the modal
   *  mounts whenever this is false and `readOnly` is off, and finishing it -
   *  "Get started", Enter or Escape - flips it true. Embed/readOnly contexts
   *  mark it true silently in an effect so the host page never sees the
   *  modal. Hosts watch the false → true flip to record completion. */
  hasCompletedOnboarding: boolean;
  setHasCompletedOnboarding: (v: boolean) => void;

  // pen tool settings (session-scoped)
  penColor: string;
  penWidth: number;
  setPenColor: (c: string) => void;
  setPenWidth: (w: number) => void;

  // last-used style defaults - captured automatically whenever the user edits
  // a style on any shape (stroke, fill, font, line width, text colour). Newly
  // created shapes inherit these so the user doesn't have to re-pick the same
  // styles repeatedly. Persisted across sessions.
  lastStyles: LastStyles;
  setLastStyles: (patch: Partial<LastStyles>) => void;

  // Same idea, parallel slot for connectors. Mirrored from updateConnector
  // whenever the user touches stroke / strokeWidth / dash style; the canvas's
  // connector-creation path reads this so the next arrow or line they draw
  // inherits whatever they last picked. Routing + endpoint markers stay
  // tool-driven (arrow vs line) - those carry semantic meaning, where stroke
  // colour / width / dash are pure appearance.
  lastConnectorStyle: LastConnectorStyle;
  setLastConnectorStyle: (patch: Partial<LastConnectorStyle>) => void;

  // Wipe both sticky-style slots back to empty. Powers the "Reset to stock
  // defaults" affordance in the Defaults inspector - empty objects mean each
  // shape kind falls back to its built-in defaults at creation time.
  resetStyleDefaults: () => void;

  // container actions - wrap a selected non-basic shape in a container frame
  // so the user can group related items below/around it.
  makeContainer: (id: string) => void;
  /** Encapsulate EVERY selected icon shape inside its own circle/square that
   *  becomes that shape's own outline (NOT a group/container - same ids, no
   *  parent; each icon is framed independently around its own centre). Pass
   *  `null` to strip the frame back to bare icons. Squares each bbox so the
   *  frames stay regular and connectors anchor to clean circles/boxes. Acts
   *  on the current selection (mirrors `updateSelection`), so it works for
   *  one or many icons in a single history step. */
  encapsulateSelection: (frame: 'circle' | 'square' | null) => void;
  /** Auto-adopt a freshly-dropped shape into the topmost container its centre
   *  lands inside. No-op if the shape is already a child or no container is
   *  under the centre. */
  adoptIntoContainer: (id: string) => void;

  // personal shape library (persisted per-workspace via localStorage)
  personalLibrary: PersonalLibraryEntry[];
  addToLibrary: (label: string, ids: string[]) => void;
  removeFromLibrary: (index: number) => void;

  // Recent-tab feed - the user-activity log surfaced in MoreShapesPopover and
  // LibraryPanel. Populated whenever a library shape, vendor icon, or iconify
  // icon is dropped onto the canvas. Persisted so the list survives reloads -
  // "recent" is meaningless if it resets every session.
  recentShapes: RecentEntry[];
  recordRecent: (entry: RecentEntry) => void;
  clearRecent: () => void;

  // Pinned vendor icon packs - surfaced at the top of the Icon Packs browser
  // tab. Stored as ordered manifest vendor keys ("aws-service", "azure", …);
  // first entry is rendered first. Right-click on a pack tile toggles. Persisted
  // so favourites survive reloads - pinning is muscle memory, it would feel
  // broken if it reset every session.
  pinnedIconPacks: string[];
  togglePinnedIconPack: (vendorKey: string) => void;

  // -  - embed (Blueprintr overlay) -  -
  // Driven from outside via embedBridge; consumed by EmbedView's SVG
  // attribute toggling and reveal animation. Pure store slots - Vellum
  // core itself doesn't read these, only the overlay does.
  readOnly: boolean;
  setReadOnly: (v: boolean) => void;
  highlightedShapeIds: string[];
  setHighlightedShapeIds: (ids: string[]) => void;
  activeHighlightedShapeId: string | null;
  setActiveHighlightedShapeId: (id: string | null) => void;
  /** Monotonic counter; bump to fire a one-shot reveal animation in the
   *  embed viewer. Subscribers diff old vs new tick to detect a fire. */
  revealTick: number;
  triggerReveal: () => void;
};

/** Recovery state for diagrams, tab order, preferences and personal libraries.
 * Documents and assets use IndexedDB; small preferences use localStorage.
 * File handles are session-only, so a restored session must reopen its file
 * or use Save As before autosave can write to disk. */
type PersistedSlice = Pick<
  EditorState,
  | 'hotkeyBindings'
  | 'theme'
  | 'uiTextScale'
  | 'personalLibrary'
  | 'canvasPaper'
  | 'showDots'
  | 'showGrid'
  | 'showMeasurements'
  | 'exportPrefs'
  | 'libraryPanelOpen'
  | 'rightDockOpen'
  | 'rightDockWidth'
  | 'lastStyles'
  | 'lastConnectorStyle'
  | 'recentShapes'
  | 'diagram'
  | 'dirty'
  | 'workspaceRevision'
  | 'savedRevision'
  | 'filePath'
  | 'inspectorOpen'
  | 'collapsedInspectorSections'
  | 'tipsEnabled'
  | 'smartAnchorsGlobal'
  | 'smartAnchorCountGlobal'
  | 'shapeSnapEnabled'
  | 'gridSnapEnabled'
  | 'snapEnabled'
  | 'hasCompletedOnboarding'
  | 'pinnedIconPacks'
  | 'diagramTabs'
  | 'activeTabId'
  | 'tabSnapshots'
  | 'tabsBarHeight'
  | 'tabsBarCollapsed'
>;

/** A user-saved shape (or group) ready to drop back onto a future canvas. */
export type PersonalLibraryEntry = DiagramFragment & {
  /** Display label in the library popover. */
  label: string;
  /** Glyph shown on the tile (3-char fallback if user doesn't pick one). */
  glyph: string;
  /** A self-contained bundle: shapes + connectors. Coordinates are normalised
   *  so the bundle's bbox sits at (0,0) - drop-in adds the cursor offset. */
  shapes: Shape[];
  connectors: Connector[];
};

/** The "last touched" style values. defaultShapeFromTool reads these so newly
 *  drawn shapes inherit whatever the user most recently chose. Each field is
 *  optional - undefined just means "no override, use the kind's default." */
export type LastStyles = {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  fontFamily?: string;
  fontSize?: number;
  textColor?: string;
  /** Sticky horizontal text alignment. Mirrored from the floating text
   *  toolbar so the next shape's label inherits the user's last pick. */
  textAlign?: 'left' | 'center' | 'right';
  /** Corner radius (rects only at render time). Persisted across sessions
   *  alongside the other sticky styles, AND surfaced in the Defaults flyout
   *  as the global default that newly-drawn rectangles inherit. */
  cornerRadius?: number;
  /** Sticky prism stroke - carries to the next drawn shape the way stroke /
   *  fill do. Stamped only onto kinds that can actually paint it, and
   *  containers opt out (their dashed-frame identity should win over a
   *  leftover pick - same reasoning as the other container carve-outs in
   *  defaultShapeFromTool). */
  strokeGradient?: StrokeGradient;
};

/** Connector equivalent of LastStyles - the appearance bits the user picks in
 *  ConnectorInspector. Routing / markers are intentionally NOT here: those
 *  carry semantic intent (arrow vs line, elbow vs straight) tied to the tool
 *  they came from. Mirroring them would have a "wait why is my arrow tool
 *  drawing dotted-curve lines now" surprise factor. */
export type LastConnectorStyle = {
  stroke?: string;
  strokeWidth?: number;
  style?: 'solid' | 'dashed' | 'dotted';
  /** Per-end marker size carries forward like strokeWidth so the next arrow
   *  the user draws after sizing one inherits the choice. Asymmetric on
   *  purpose - the user might want big arrowheads on the to-end without
   *  inflating the from-end markers. */
  fromMarkerSize?: number;
  toMarkerSize?: number;
  animated?: boolean;
  bidirectional?: boolean;
  /** Line jumps carry forward so every line drawn after turning `.hop` on
   *  bridges over the lines it crosses too. */
  hop?: boolean;
};

/** Connector style fields we mirror onto `lastConnectorStyle` after every
 *  updateConnector - same pattern as STYLE_FIELDS for shapes. */
const CONNECTOR_STYLE_FIELDS: readonly (keyof LastConnectorStyle)[] = [
  'stroke',
  'strokeWidth',
  'style',
  'fromMarkerSize',
  'toMarkerSize',
  'animated',
  'bidirectional',
  'hop',
];

function extractLastConnectorStyle(
  patch: Partial<Connector>,
): Partial<LastConnectorStyle> | null {
  let out: Partial<LastConnectorStyle> | null = null;
  for (const k of CONNECTOR_STYLE_FIELDS) {
    if (k in patch) {
      if (!out) out = {};
      (out as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k];
    }
  }
  return out;
}

/** Recent-tab entries - items the user has actually placed on the canvas.
 *  Discriminated by `source` so the panel knows which dataTransfer MIME to
 *  emit when the user drags one back to canvas:
 *    - 'library' → application/x-vellum-library (existing service-tile path)
 *    - 'vendor'  → application/x-vellum-icon, vendor payload
 *    - 'iconify' → application/x-vellum-icon, iconify payload
 *  We dedup by `key`, prepend on each new use, and cap at RECENT_LIMIT. */
export type RecentEntry = {
  /** Stable dedup key. */
  key: string;
  label: string;
  /** 3-char glyph used as the tile fallback when no preview SVG is available. */
  glyph: string;
  source:
    | { kind: 'library'; libShapeId: string; libName: string }
    | { kind: 'vendor'; iconId: string; vendor: string }
    | { kind: 'iconify'; iconId: string; prefix: string };
};

const RECENT_LIMIT = 24;

/** Style fields we mirror onto `lastStyles` when an updateShape patch touches
 *  them. Centralised so the store and the UI share one definition. */
const STYLE_FIELDS: readonly (keyof LastStyles)[] = [
  'fill',
  'stroke',
  'strokeWidth',
  'fontFamily',
  'fontSize',
  'textColor',
  'textAlign',
  'cornerRadius',
  'strokeGradient',
];

/** Local helper - flag a colour value as a "actual" choice the user could
 *  reasonably want to splash onto an icon's tint. We treat undefined / 'none'
 *  / 'transparent' as semantically "no override" rather than colour intent.
 *  Used by the cross-type fill→tint mapping in updateSelection. */
function _isMeaningfulColor(v: string | undefined): v is string {
  if (v == null) return false;
  const t = v.toLowerCase();
  return t !== 'transparent' && t !== 'none';
}

/** Mirror the inspector's "show .tint row?" gate - which is now simply
 *  "is it an icon". The renderer rewrites the artwork's own paint (see
 *  `src/icons/recolor.ts`), so a tint reaches the painted pixels of ANY
 *  icon: multi-colour, gradient-filled, vendor-trademarked alike. The old
 *  monochrome + `lockColors` conditions are gone - they existed because
 *  the wrapper `color` couldn't reach hard-coded paint, and that's no
 *  longer true. */
function _isIconRecolorable(sh: Shape): boolean {
  return sh.kind === 'icon';
}

/** Fields only a connector has. The connector inspector sends them through
 *  `updateSelection` with the shared style fields, so on a selection that
 *  mixes shapes and connectors they must not land on the shapes. */
const CONNECTOR_ONLY_FIELDS: readonly (keyof Connector)[] = [
  'fromMarker',
  'toMarker',
  'fromMarkerSize',
  'toMarkerSize',
  'routing',
  'animated',
  'bidirectional',
  'hop',
];

/** Translate a Shape patch into the patch that should actually be applied
 *  to a specific shape, given that shape's kind. The shape inspector emits
 *  patches in "rectangle vocabulary" (fill / stroke / fontSize / …); icons
 *  and images need different fields, and we'd rather the user's intent
 *  ("paint everything red") survive mixed selection than have them open
 *  three inspectors in series. */
function _translateShapePatch(
  sh: Shape,
  patch: Partial<Shape>,
): Partial<Shape> {
  // Connector-only settings (e.g. `hop`, `animated`) are meaningless on a
  // shape; drop them so a mixed-selection edit doesn't leave them in the
  // file. Only the patch is filtered - fields a shape already carries from an
  // older file are left alone.
  if (CONNECTOR_ONLY_FIELDS.some((k) => k in patch)) {
    patch = { ...patch };
    for (const k of CONNECTOR_ONLY_FIELDS) {
      delete (patch as Record<string, unknown>)[k];
    }
  }
  if (sh.kind === 'icon') {
    // Forward every non-COLOUR field as-is - labelAnchor, textAlign, font*,
    // textColor, label, etc. all apply to an icon's painted label and must
    // survive cross-kind multi-select. Fill/stroke are special-cased below
    // because icons store their tint in `stroke` and translate inspector
    // fill writes onto it.
    const out: Partial<Shape> = { ...patch };
    delete out.fill;
    delete out.stroke;
    // A prism gradient paints the encapsulation FRAME - Vellum chrome drawn
    // AROUND the glyph, never the trademarked asset itself (the renderer only
    // threads strokePaint into frameEl). So the gate is "is there a frame",
    // NOT recolorability: a framed vendor icon may carry a prism ring without
    // touching its locked colours, exactly as it already accepts .fill and
    // .stroke on that frame. An UNframed icon has no outline at all - its
    // `stroke` is the glyph tint - so it gets dropped.
    //
    // This must stay in step with `shapeSupportsPrismStroke` (which the
    // renderer and the inspector row both use); gating on recolorability here
    // made a framed vendor icon accept a palette on single-select and
    // silently ignore it in a multi-selection.
    if (sh.frame === undefined) {
      delete out.strokeGradient;
    }
    if (!_isIconRecolorable(sh)) {
      // Not an icon path any more - kept as the single seam where a future
      // "don't touch this one" opt-out would live. Fields already forwarded.
      return out;
    }
    if (sh.frame !== undefined) {
      // Framed icon: .fill and .stroke are ACTUAL controls on the frame body
      // (the inspector shows both on single-select), so a multi-select
      // "paint everything red" should hit the same fields it would there.
      // The glyph's own tint is in `iconTint`, which has no equivalent
      // in the inspector's rectangle vocabulary - it stays untouched.
      if ('fill' in patch) out.fill = patch.fill;
      if ('stroke' in patch) out.stroke = patch.stroke;
      return out;
    }
    // Bare icon - fill OR stroke maps to the icon's tint (is in
    // shape.stroke). Stroke "wins" if both are set in the same patch -
    // same ordering as the inspector's .tint row.
    if ('stroke' in patch && _isMeaningfulColor(patch.stroke)) {
      out.stroke = patch.stroke;
    } else if ('fill' in patch && _isMeaningfulColor(patch.fill)) {
      out.stroke = patch.fill;
    } else if ('stroke' in patch && patch.stroke === undefined) {
      // Reset-to-default click in the .tint row should reset the icon's
      // tint too (don't leak the previous override).
      out.stroke = undefined;
    }
    return out;
  }
  if (sh.kind === 'image') {
    // Same shape as the icon branch - forward non-colour fields as-is so
    // multi-select label/anchor edits reach images, and drop fill/stroke
    // (images don't have a body fill/stroke axis the inspector writes to).
    // imageFilter / imageTint / cornerRadius pass through because they're
    // already in the patch shape.
    const out: Partial<Shape> = { ...patch };
    delete out.fill;
    delete out.stroke;
    // Images paint no outline, so a prism gradient would be stored but never
    // rendered - drop it rather than leave a dead field on the shape.
    delete out.strokeGradient;
    return out;
  }
  // Everything else uses the patch as-is.
  return patch;
}

/** Translate a shape-vocabulary style patch into the matching connector
 *  patch. Connector field names diverge in one place (`strokeStyle` →
 *  `style`); fill / fontFamily / fontSize / textColor have no connector
 *  equivalent and get dropped.
 *
 *  Connector-only fields (`fromMarker`, `toMarker`, `fromMarkerSize`,
 *  `toMarkerSize`) ride on the same patch object - the connector inspector
 *  passes them so a marker change with multiple connectors selected applies
 *  to the lot (the original "only the first connector got the new arrowhead"
 *  bug came from per-connector calls instead of routing through here). They
 *  pass straight through; pure-shape patches never set them so this is a
 *  no-op for shape-only callers. */
function _shapePatchToConnectorPatch(
  patch: Partial<Shape> & Partial<Connector>,
): Partial<Connector> {
  const out: Partial<Connector> = {};
  if ('stroke' in patch) out.stroke = patch.stroke;
  if ('strokeWidth' in patch) out.strokeWidth = patch.strokeWidth;
  if ('opacity' in patch) out.opacity = patch.opacity;
  if ('strokeStyle' in patch) out.style = patch.strokeStyle;
  // Connector-only fields below - only present when the caller is the
  // connector inspector. _translateShapePatch ignores them on the shape side.
  if ('fromMarker' in patch) out.fromMarker = patch.fromMarker;
  if ('toMarker' in patch) out.toMarker = patch.toMarker;
  if ('fromMarkerSize' in patch) out.fromMarkerSize = patch.fromMarkerSize;
  if ('toMarkerSize' in patch) out.toMarkerSize = patch.toMarkerSize;
  if ('routing' in patch) out.routing = patch.routing;
  if ('layer' in patch) out.layer = patch.layer;
  if ('animated' in patch) out.animated = patch.animated;
  if ('bidirectional' in patch) out.bidirectional = patch.bidirectional;
  if ('hop' in patch) out.hop = patch.hop;
  return out;
}

/** Pull the style fields from a shape patch. Returns null if the patch doesn't
 *  touch any style - saves a setState call on geometry-only edits. */
function extractLastStyles(patch: Partial<Shape>): Partial<LastStyles> | null {
  let out: Partial<LastStyles> | null = null;
  for (const k of STYLE_FIELDS) {
    if (k in patch) {
      if (!out) out = {};
      // Cast: each STYLE_FIELDS key is a Shape key, and the corresponding
      // value type matches LastStyles[k] (optional + same type).
      const v = (patch as Record<string, unknown>)[k];
      // `strokeGradient` is the one non-scalar in this set. Storing the
      // patch's object by reference would alias lastStyles to the very object
      // now living on the shape - safe today (every writer replaces rather
      // than mutates) but a silent trap for the first in-place edit. Copy it.
      (out as Record<string, unknown>)[k] =
        v && typeof v === 'object' ? { ...(v as object) } : v;
    }
  }
  return out;
}

/** Estimate a nudge distance for Cmd+Arrow.
 *
 *  Two-tier strategy, in priority order:
 *
 *    1. Dock to neighbour. If there's a shape on the side the user is moving
 *       toward, return the *gap* (axis-aligned distance, edge to edge) so the
 *       selection lands flush against it. This matches the user's intuition
 *       of "snap me to the next thing".
 *
 *    2. Match existing rhythm. Otherwise, return the median gap between
 *       neighbouring non-selected shapes along the same axis - useful when
 *       the user is laying out a new card next to a row of evenly-spaced
 *       siblings and there's no shape on the receiving side yet.
 *
 *  Returns `null` when no estimate is available; the caller falls back to the
 *  raw dx/dy. Magnitude only - sign is applied by the caller.
 *
 *  `sx`/`sy` are direction signs (`-1`/`0`/`+1`); exactly one is non-zero in
 *  practice (arrow-key driven). `ref` is the selection bbox. */
function _estimateNudgeDistance(
  ref: { minX: number; minY: number; maxX: number; maxY: number; cx: number; cy: number },
  others: readonly Shape[],
  sx: number,
  sy: number,
): number | null {
  const horizontal = sx !== 0;
  const axisRange = horizontal
    ? { lo: ref.minY, hi: ref.maxY }
    : { lo: ref.minX, hi: ref.maxX };

  // Tier 1: dock to nearest neighbour in the direction of travel whose
  // perpendicular projection overlaps the selection bbox. Without the overlap
  // gate, "right arrow" would dock onto a shape that's high above the
  // selection, which doesn't match what the user sees when they look at the
  // diagram.
  let bestGap = Infinity;
  for (const o of others) {
    const oLo = horizontal ? o.y : o.x;
    const oHi = horizontal ? o.y + o.h : o.x + o.w;
    if (oHi < axisRange.lo || oLo > axisRange.hi) continue;
    let gap: number | null = null;
    if (sx > 0) gap = o.x - ref.maxX;
    else if (sx < 0) gap = ref.minX - (o.x + o.w);
    else if (sy > 0) gap = o.y - ref.maxY;
    else if (sy < 0) gap = ref.minY - (o.y + o.h);
    if (gap == null || gap <= 0) continue;
    if (gap < bestGap) bestGap = gap;
  }
  if (isFinite(bestGap)) return bestGap;

  // Tier 2: median pairwise gap across non-selected shapes along the active
  // axis. Sort by leading edge and walk the list - captures the rhythm of an
  // existing column/row even when nothing sits in the user's path.
  if (others.length < 2) return null;
  const sorted = [...others].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const gap = horizontal
      ? b.x - (a.x + a.w)
      : b.y - (a.y + a.h);
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

/** Empty diagram skeleton - file format-shaped, no DTOs. */
const EMPTY_DIAGRAM: DiagramState = {
  version: '1.0',
  meta: { title: 'untitled', defaults: { fidelity: 1 } },
  shapes: [],
  connectors: [],
  annotations: [],
};

// `expandAllDescendants` / `expandGroupDescendants` moved to ./hierarchy.ts
// (pure, shared with the canvas + z-order module) - imported above.

/** Approximate world coords for a connector endpoint. Floating endpoints
 *  pass through; bound endpoints resolve their anchor against the shape.
 *  Used by the clipboard path so a connector copied without its endpoint
 *  shapes can be stored as a fully-detached free-floating line.
 *
 *  `'auto'` collapses to the shape's centre - we don't have the opposite
 *  endpoint in this purely-clipboard context, and a centre point is a
 *  reasonable starting position for the user to drag from after paste. */
function endpointToFloating(
  ep: ConnectorEndpoint,
  shapes: readonly Shape[],
): { x: number; y: number } | null {
  if (!('shape' in ep)) return { x: ep.x, y: ep.y };
  const sh = shapes.find((s) => s.id === ep.shape);
  if (!sh) return null;
  const w = Math.abs(sh.w);
  const h = Math.abs(sh.h);
  // Coerced through the same fallback the renderer uses. This helper feeds
  // the clipboard (copySelection, duplicate, the OS-clipboard envelope), so
  // a malformed stored anchor would otherwise become a NaN endpoint that
  // gets WRITTEN into the pasted document and refuses to re-open.
  const a: Anchor = resolvedAnchorOrCentre(ep.anchor);
  if (Array.isArray(a)) {
    return { x: sh.x + a[0] * w, y: sh.y + a[1] * h };
  }
  switch (a) {
    case 'top':
      return { x: sh.x + w / 2, y: sh.y };
    case 'bottom':
      return { x: sh.x + w / 2, y: sh.y + h };
    case 'left':
      return { x: sh.x, y: sh.y + h / 2 };
    case 'right':
      return { x: sh.x + w, y: sh.y + h / 2 };
    default:
      // `auto` and anything unreadable arrive here as the centre tuple from
      // resolvedAnchorOrCentre and are handled by the branch above, so this
      // is the compiler's exhaustiveness arm rather than a live path.
      return { x: sh.x + w / 2, y: sh.y + h / 2 };
  }
}

/** Walk connectors and convert any endpoint bound to a shape in `removedIds`
 *  into a floating endpoint at the LAST-KNOWN anchor position, flagged with
 *  `dangling: true` so the renderer paints a broken-link indicator.
 *
 *  Used by `deleteSelection` and `replaceFragment` instead of garbage-
 *  collecting connectors that reference removed shapes. The connector model
 *  stores shape-IDs, so re-attaching is cheap - danglifying lets the user
 *  spot the orphans and either drag the endpoint onto a new shape or delete
 *  the line, instead of having lines vanish silently when a shape goes away.
 *
 *  Position resolution uses `resolveConnectorPath` (the same pipeline the
 *  renderer uses) against the pre-mutation shape array, so the visible
 *  endpoint stays put across the danglify. When BOTH endpoints reference
 *  removed shapes and the path can't be resolved, the connector itself is
 *  dropped - a free-floating line with no path is just noise.
 *
 *  Connectors directly listed in `removedIds` (the user selected the line
 *  itself) are removed, not danglified. */
function danglifyConnectors(
  connectors: readonly Connector[],
  removedShapeIds: ReadonlySet<string>,
  removedConnectorIds: ReadonlySet<string>,
  shapesBeforeMutation: readonly Shape[],
): Connector[] {
  const out: Connector[] = [];
  for (const c of connectors) {
    if (removedConnectorIds.has(c.id)) continue;
    const fromShape = 'shape' in c.from ? c.from.shape : null;
    const toShape = 'shape' in c.to ? c.to.shape : null;
    const fromGone = fromShape != null && removedShapeIds.has(fromShape);
    const toGone = toShape != null && removedShapeIds.has(toShape);
    if (!fromGone && !toGone) {
      out.push(c);
      continue;
    }
    const path = resolveConnectorPath(c, shapesBeforeMutation as Shape[]);
    if (!path) continue;
    const next: Connector = { ...c };
    if (fromGone) next.from = { x: path.fx, y: path.fy, dangling: true };
    if (toGone) next.to = { x: path.tx, y: path.ty, dangling: true };
    out.push(next);
  }
  return out;
}

/** World-space AABB of a connector: both resolved endpoints plus every
 *  waypoint. Endpoints come from `resolveConnectorPath` so a shape-bound end
 *  contributes its live anchor point. Returns `null` for a line whose
 *  endpoints can't be resolved (a dangling reference mid-delete).
 *
 *  Deliberately the *control* geometry, not the rendered curve: a bezier can
 *  bow a few px outside the hull of its control points, and chasing that
 *  would mean re-measuring the path on every mutation. Group frames carry
 *  GROUP_FRAME_PAD of slack, which covers the difference. */
function connectorBox(
  conn: Connector,
  shapes: readonly Shape[],
): { x: number; y: number; w: number; h: number } | null {
  const path = resolveConnectorPath(conn, shapes as Shape[]);
  if (!path) return null;
  let minX = Math.min(path.fx, path.tx);
  let minY = Math.min(path.fy, path.ty);
  let maxX = Math.max(path.fx, path.tx);
  let maxY = Math.max(path.fy, path.ty);
  for (const w of conn.waypoints ?? []) {
    minX = Math.min(minX, w.x);
    minY = Math.min(minY, w.y);
    maxX = Math.max(maxX, w.x);
    maxY = Math.max(maxY, w.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Geometric containment rule for connector → container parenting: a line
 *  belongs to the front-most (highest EFFECTIVE z - see canvas/z-order.ts)
 *  container whose bbox contains BOTH resolved endpoint world points.
 *  Returns the container id, or undefined when no container qualifies.
 *
 *  Mirrors the shape adoption rule (`adoptIntoContainer`) but tests full
 *  containment of both endpoints rather than >50% area overlap - a line has
 *  no area of its own, so "is it inside the box" is the natural question.
 *  Endpoint positions come from `resolveConnectorPath` (the renderer's
 *  pipeline), so bound endpoints resolve to their shape's anchor and float-
 *  ing endpoints use their stored coords - both honoured uniformly.
 *
 *  Layer rule, shared with shape adoption: adoption only moves between
 *  containers the user can SEE under the active layer pill. A container on
 *  a hidden layer never captures a line (the user would get an invisible
 *  parent that later deletes / copies the line along with it), but a line
 *  already parented to a now-hidden container keeps that parent - you can
 *  stay where you are; you can only move into what you can see. */
function computeConnectorParent(
  conn: Connector,
  shapes: readonly Shape[],
  layerMode: LayerMode,
  eff: ReadonlyMap<string, number>,
): string | undefined {
  const path = resolveConnectorPath(conn, shapes as Shape[]);
  if (!path) return undefined;
  const within = (s: Shape, x: number, y: number) =>
    x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h;
  let best: Shape | undefined;
  for (const s of shapes) {
    if (s.kind !== 'container') continue;
    if (!shapeVisibleInMode(s, layerMode) && s.id !== conn.parent) continue;
    if (!within(s, path.fx, path.fy) || !within(s, path.tx, path.ty)) continue;
    if (!best || (eff.get(s.id) ?? 0) > (eff.get(best.id) ?? 0)) best = s;
  }
  return best?.id;
}

/** Recompute every connector's `parent` from current geometry and return a
 *  fresh array, or `null` when nothing changed (so callers can skip the
 *  `set`). CONTAINER parenting is a function of geometry plus the active
 *  layer pill (see `computeConnectorParent`), so a full reconcile at each
 *  commit boundary is both correct and idempotent - there is no user-intent
 *  (unlike shape drag-out) to preserve.
 *
 *  GROUP membership is the opposite: it IS user intent, stamped by
 *  `groupSelection` and cleared by `ungroupSelection`, exactly like a
 *  shape's group parent. Lines whose parent is a group are therefore left
 *  alone here - without the skip, the very next commit would strip the
 *  membership back off and a grouped connector would silently fall out of
 *  its group. A parent pointing at a shape that no longer exists still
 *  falls through to the geometric rule, so a deleted group self-heals. */
function reconcileConnectorParents(
  connectors: readonly Connector[],
  shapes: readonly Shape[],
  layerMode: LayerMode,
): Connector[] | null {
  const eff = effectiveZMap(shapes, connectors);
  const byId = shapeIndex(shapes);
  let changed = false;
  const next = connectors.map((c) => {
    if (c.parent && byId(c.parent)?.kind === 'group') return c;
    const parent = computeConnectorParent(c, shapes, layerMode, eff);
    if (parent === c.parent) return c;
    changed = true;
    if (parent === undefined) {
      const { parent: _drop, ...rest } = c;
      return rest;
    }
    return { ...c, parent };
  });
  return changed ? next : null;
}

/** Walk a connector's endpoints and rewrite any bound-to-unselected-shape
 *  endpoint as a floating world coord. Used at copy/duplicate time so a
 *  user who selected just a connector (not its endpoint shapes) gets a
 *  free-floating duplicate they can position, instead of one bound to
 *  the original shapes that paste invisibly on top of the source line.
 *
 *  Exported so Canvas's OS-clipboard `buildEnvelope` can apply the same
 *  rule - both routes (internal `copySelection` and the native `copy`
 *  event) MUST agree on what comes across, otherwise the OS-clipboard
 *  branch silently overwrites the internal clipboard on paste with a
 *  payload missing the user's lone-connector selection. */
export function detachUnselectedEndpoints(
  c: Connector,
  selectedShapeIds: ReadonlySet<string>,
  shapes: readonly Shape[],
): Connector {
  const fix = (ep: ConnectorEndpoint): ConnectorEndpoint => {
    if (!('shape' in ep)) return ep;
    if (selectedShapeIds.has(ep.shape)) return ep;
    const f = endpointToFloating(ep, shapes);
    return f ?? ep;
  };
  return { ...c, from: fix(c.from), to: fix(c.to) };
}

/** Compute the next z value for a freshly-added item - one above the top of
 *  the EFFECTIVE stack (members lifted above their container included), so
 *  the new item always paints on top. Delegates to canvas/z-order.ts. */
function nextZ(s: EditorState): number {
  return nextZOf(s.diagram.shapes, s.diagram.connectors);
}

/** Shared tail for bringForward / sendBackward / bringToFront / sendToBack.
 *  The ordering semantics (subtree expansion, one-visible-step, the
 *  can't-sink-below-your-own-container rule, compaction) live in
 *  canvas/z-order.ts → `reorderZ`, next to the renderer's paint order, so
 *  the commands can never disagree with what the canvas draws. This wrapper
 *  only adds the history snapshot and skips the write on a no-op. */
function _reorderZ(
  get: () => EditorState,
  snapshot: () => void,
  mutate: (next: Partial<DiagramState>) => void,
  op: ZOrderOp,
) {
  const state = get();
  const next = reorderZ(
    {
      shapes: state.diagram.shapes,
      connectors: state.diagram.connectors,
      selectedIds: state.selectedIds,
      layerMode: state.layerMode,
    },
    op,
  );
  if (!next) return;
  snapshot();
  mutate(next);
}

/** Prefix a random UUID fragment, or use a process-local counter when the
 *  environment does not provide crypto.randomUUID. */
let _idCounter = 0;
export function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${(++_idCounter).toString(36)}`;
}

let hydrationStart: Pick<EditorState, 'workspaceId' | 'workspaceRevision' | 'diagram' | 'diagramTabs' | 'tabSnapshots'> | undefined;
/** Persisted fields that belong to the open document rather than the user. */
const RECOVERED_DOCUMENT_FIELDS = new Set(['diagram', 'filePath', 'dirty', 'workspaceRevision', 'savedRevision', 'diagramTabs', 'activeTabId', 'tabSnapshots']);

export const useEditor = create<EditorState>()(
  persist(
    (baseSet, get) => {
      // Track persisted document changes independently of the active tab's UI.
      const set = (patch: Partial<EditorState> | ((state: EditorState) => Partial<EditorState>)) => baseSet((before) => {
        const next = { ...(typeof patch === 'function' ? patch(before) : patch) };
        if (before.exportReturnTabId && next.exportReturnTabId === undefined &&
          (next.activeTabId !== undefined || next.diagramTabs !== undefined)) next.exportReturnTabId = null;
        const after = { ...before, ...next } as EditorState;
        if (next.workspaceId && next.workspaceId !== before.workspaceId) {
          return { ...next, workspaceRevision: 0, savedRevision: 0, exportReturnTabId: null };
        }
        const changed = (before.exportReturnTabId ?? before.activeTabId) !== (after.exportReturnTabId ?? after.activeTabId) ||
          before.diagramTabs.length !== after.diagramTabs.length ||
          before.diagramTabs.some((tab, index) => tab.id !== after.diagramTabs[index]?.id ||
            (tab.id === before.activeTabId ? before.diagram : before.tabSnapshots[tab.id]?.diagram) !==
            (tab.id === after.activeTabId ? after.diagram : after.tabSnapshots[tab.id]?.diagram));
        return changed ? { ...next, workspaceRevision: before.workspaceRevision + 1 } : next;
      });
      // internal helpers

      // Live-drag history tracking. Atomic ops _snapshot+mutate in one call;
      // live drags _mutate many times during pointermove and only seal at
      // pointerup via commitHistory. To make the gesture a single undo step
      // the pre-drag diagram has to be captured BEFORE the first live
      // mutation - but the canvas calls commitHistory AFTER the gesture,
      // by which point get().diagram is already post-drag. The fix is to
      // have _mutate stash the pre-mutation state lazily on first call;
      // commitHistory then pushes that stash instead of the current state.
      // lastSnapshottedDiagram is the diagram reference at the time of the
      // last _snapshot, used so atomic _snapshot+_mutate pairs don't
      // double-capture (their _mutate runs against an unchanged diagram
      // reference and skips the lazy capture). pendingPreSelection rides
      // along with the pre-state so undo can hand the selection back.
      let pendingPreState: DiagramState | null = null;
      let pendingPreSelection: readonly string[] = [];
      let lastSnapshottedDiagram: DiagramState | null = null;
      // beginHistoryBatch / endHistoryBatch nesting depth. While > 0 every
      // _snapshot is deferred into pendingPreState and the batch seals as a
      // single entry when the outermost bracket closes.
      let batchDepth = 0;
      // Nudge coalescing: collapse autorepeat arrow-key nudges into ONE undo
      // entry. `lastNudgeAt` is the previous nudge's timestamp; `lastNudgePast`
      // is the `past` array reference captured right after that nudge, so we
      // can tell whether any OTHER action pushed history since (every other
      // mutation replaces the `past` array identity).
      const NUDGE_COALESCE_MS = 400;
      let lastNudgeAt = 0;
      let lastNudgePast: readonly unknown[] | null = null;
      // The set of ids the previous nudge moved. Two bursts that fall inside
      // the window only merge when they move the SAME things - nudge A, then
      // select B and nudge it, are two actions and must stay two steps.
      let lastNudgeKey = '';

      /** Forget any in-flight live gesture and open batch. Every path that
       *  replaces the diagram wholesale (load, new, tab switch) and every
       *  history travel calls this - a stale pre-state from a previous
       *  document must never become an undo entry of the next one. */
      const _resetLiveTracking = () => {
        pendingPreState = null;
        pendingPreSelection = [];
        lastSnapshottedDiagram = null;
        batchDepth = 0;
      };

      /** Push one `kind: 'diagram'` entry, trimming to HISTORY_LIMIT and
       *  clearing the redo stack - any new edit invalidates redo. */
      const _pushEntry = (
        diagram: DiagramState,
        selectedIds: readonly string[],
      ) => {
        const past = get().past;
        const next = past.length >= HISTORY_LIMIT ? past.slice(1) : past.slice();
        next.push({ kind: 'diagram', diagram, selectedIds: selectedIds.slice() });
        set({ past: next, future: [] });
      };

      /** Structural "nothing actually changed" test between a gesture's
       *  pre-state and the current diagram. Cheap in the common case: the
       *  mutators keep untouched shapes/connectors referentially equal, so
       *  only the handful of edited items need a field-by-field compare
       *  (nested arrays such as waypoints / points / cells by value). */
      const _diagramsEquivalent = (a: DiagramState, b: DiagramState) => {
        if (a === b) return true;
        const same = (x: unknown, y: unknown): boolean => {
          if (Object.is(x, y)) return true;
          if (
            typeof x !== 'object' ||
            typeof y !== 'object' ||
            x === null ||
            y === null
          )
            return false;
          if (Array.isArray(x) !== Array.isArray(y)) return false;
          const kx = Object.keys(x as object);
          const ky = Object.keys(y as object);
          if (kx.length !== ky.length) return false;
          const yo = y as Record<string, unknown>;
          const xo = x as Record<string, unknown>;
          for (const k of kx) {
            if (!(k in yo) || !same(xo[k], yo[k])) return false;
          }
          return true;
        };
        return (
          same(a.shapes, b.shapes) &&
          same(a.connectors, b.connectors) &&
          same(a.annotations, b.annotations) &&
          same(a.meta, b.meta) &&
          same(a.assets, b.assets)
        );
      };

      /** Seal an in-flight live gesture as its own history entry. No-op
       *  when nothing is pending - and when the gesture changed nothing in
       *  the end (a drag released where it started, a slider scrubbed back
       *  to its old value): an entry for that is a Cmd+Z that visibly does
       *  nothing. */
      const _sealPending = () => {
        if (pendingPreState === null) return;
        if (!_diagramsEquivalent(pendingPreState, get().diagram)) {
          _pushEntry(pendingPreState, pendingPreSelection);
        }
        pendingPreState = null;
        pendingPreSelection = [];
        lastSnapshottedDiagram = null;
      };

      /** Capture the current diagram and push it to `past`, clearing `future`.
       *  Call this BEFORE mutating diagram to make the operation undoable.
       *  Wraps the diagram in a discriminated `kind: 'diagram'` entry so
       *  the unified history stack can mix shape edits and tab-structure
       *  changes.
       *
       *  Inside a history batch the push is deferred: the first snapshot
       *  stashes the pre-batch diagram as the pending pre-state and
       *  endHistoryBatch seals the lot as one entry.
       *
       *  Outside a batch, a live gesture that is still pending (a leak -
 * some pointerup path forgot to commit, or the user hit a shortcut
       *  mid-drag) is sealed FIRST as its own entry, and only then is this
       *  op's pre-state pushed. It used to be folded in instead - this
       *  op's entry took the gesture's pre-drag diagram as its baseline -
 * which meant one Cmd+Z silently reverted both the gesture and the
       *  op, and the user could never undo just the op. Two actions, two
       *  entries; a forgotten commit now costs nothing but a stray entry. */
      const _snapshot = () => {
        if (batchDepth > 0) {
          if (pendingPreState === null) {
            pendingPreState = get().diagram;
            pendingPreSelection = get().selectedIds;
          }
          return;
        }
        _sealPending();
        _pushEntry(get().diagram, get().selectedIds);
        lastSnapshottedDiagram = get().diagram;
      };

      /** The selection a history entry hands back on undo / redo: the ids
       *  it recorded, minus anything that no longer exists or sits on a
       *  layer the active pill hides - same pruning `setLayerMode` does, so
       *  history travel can't leave handles on an invisible shape. */
      const _restorableSelection = (
        ids: readonly string[] | undefined,
        diagram: DiagramState,
      ): string[] => {
        if (!ids || ids.length === 0) return [];
        const visible = visibleItemIds(
          diagram.shapes,
          diagram.connectors,
          get().layerMode,
        );
        return ids.filter((id) => visible.has(id));
      };

      /** True when every key in `patch` already holds that exact value on
       *  `target` - a click on the swatch that's already active, a slider
       *  press that lands on the current value. Reference equality for
       *  object-valued fields errs on the side of recording an entry. */
      const _patchIsNoop = (target: object, patch: object): boolean => {
        const t = target as Record<string, unknown>;
        const p = patch as Record<string, unknown>;
        for (const k of Object.keys(p)) {
          if (!Object.is(t[k], p[k])) return false;
        }
        return true;
      };

      /** Re-calculate the bounding box of groups based on their children.
       *  Ensures the group frame expands dynamically if a member is dragged outside.
       *
       *  Connector members count too - a group can hold lines as well as
       *  shapes (a shape plus the five arrows feeding it is a perfectly
       *  ordinary thing to group). Without them a mixed group's frame would
       *  shrink to hug the shapes on the first mutation and leave its own
       *  lines hanging outside, and a connector-ONLY group would have no
       *  members at all to measure. */
      const _recalculateGroupBounds = (
        shapes: Shape[],
        connectors: readonly Connector[],
      ): Shape[] => {
        let changed = false;
        const nextShapes = shapes.slice();

        const groups = nextShapes.filter((s) => s.kind === 'group');
        if (groups.length === 0) return shapes;

        const getDepth = (id: string): number => {
          const s = nextShapes.find((x) => x.id === id);
          if (!s || !s.parent) return 0;
          return 1 + getDepth(s.parent);
        };

        // Process deepest groups first just in case
        groups.sort((a, b) => getDepth(b.id) - getDepth(a.id));

        for (const group of groups) {
          const members = nextShapes.filter(
            (s) => s.parent === group.id && s.kind !== 'group'
          );
          const connMembers = connectors.filter((c) => c.parent === group.id);
          if (members.length === 0 && connMembers.length === 0) continue;

          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const m of members) {
            minX = Math.min(minX, m.x);
            minY = Math.min(minY, m.y);
            maxX = Math.max(maxX, m.x + m.w);
            maxY = Math.max(maxY, m.y + m.h);
          }
          for (const c of connMembers) {
            // Measure against the SHAPES WE ARE ABOUT TO COMMIT, so a line
            // bound to a member that just moved contributes its new anchor
            // rather than the one from the previous frame.
            const box = connectorBox(c, nextShapes);
            if (!box) continue;
            minX = Math.min(minX, box.x);
            minY = Math.min(minY, box.y);
            maxX = Math.max(maxX, box.x + box.w);
            maxY = Math.max(maxY, box.y + box.h);
          }

          if (minX === Infinity) continue;

          const pad = GROUP_FRAME_PAD;
          const nx = minX - pad;
          const ny = minY - pad;
          const nw = maxX - minX + pad * 2;
          const nh = maxY - minY + pad * 2;

          if (group.x !== nx || group.y !== ny || group.w !== nw || group.h !== nh) {
            const idx = nextShapes.findIndex((s) => s.id === group.id);
            if (idx !== -1) {
              nextShapes[idx] = { ...group, x: nx, y: ny, w: nw, h: nh };
              changed = true;
            }
          }
        }

        return changed ? nextShapes : shapes;
      };

      /** Live-mutate without snapshotting - for pointermove drag updates. The
       *  caller commits a single history step at gesture end via commitHistory.
       *  Lazily stashes the pre-mutation diagram in pendingPreState on the
       *  first _mutate of a live-drag chain, so commitHistory has the right
       *  pre-state to push. The "diagram changed since last _snapshot" guard
       *  prevents an atomic op's _snapshot+_mutate from also capturing
       *  (its diagram reference is unchanged between the two calls). */
      const _mutate = (next: Partial<DiagramState>) => {
        let finalShapes = next.shapes;
        if (finalShapes) {
          finalShapes = syncRacks(
            syncBoundaryEvents(finalShapes, get().diagram.shapes),
          );
        }
        // A group frame is derived from its members' geometry - shapes AND
        // connectors - so re-derive whenever either side moves. Connector-
        // only mutations have to trigger it too: the live drag path writes
        // shapes first and lines second, and a connector-only group would
        // otherwise leave its frame a full call behind the lines it frames.
        // No-ops cheaply (same array back) when the diagram has no groups.
        if (finalShapes || next.connectors) {
          finalShapes = _recalculateGroupBounds(
            finalShapes ?? get().diagram.shapes,
            next.connectors ?? get().diagram.connectors,
          );
        }
        if (
          pendingPreState === null &&
          lastSnapshottedDiagram !== get().diagram
        ) {
          pendingPreState = get().diagram;
          pendingPreSelection = get().selectedIds;
        }
        set((s) => ({
          diagram: {
            ...s.diagram,
            ...next,
            ...(finalShapes ? { shapes: finalShapes } : {}),
          },
          dirty: true,
        }));
      };

      /** Re-derive connector → container parenting from current geometry and
       *  fold the result into the diagram WITHOUT taking a history snapshot -
 * it's a derived consequence of whatever edit just happened, so it
       *  belongs to that edit's undo step, not its own. Called at commit
       *  boundaries (commitHistory + the atomic geometry ops). Bails when no
       *  parent actually changed so it never dirties the doc spuriously. */
      const _reconcileConnectorParents = () => {
        const { shapes, connectors } = get().diagram;
        const reconciled = reconcileConnectorParents(
          connectors,
          shapes,
          get().layerMode,
        );
        if (!reconciled) return;
        set((s) => ({
          diagram: { ...s.diagram, connectors: reconciled },
          dirty: true,
        }));
      };

      /** Move `ids` (shapes and/or connectors) to `layer` as whole subtrees:
       *  every descendant of a selected frame (group or container), every
       *  connector a selected container owns, and every connector whose
       *  endpoints both land on shapes that moved - related geometry stays
       *  on one layer instead of leaving orphaned lines or an empty frame
       *  behind. One snapshot for the batch so undo is a single step; no
       *  write at all when nothing would change.
       *
       *  Items that end up on a layer the active pill hides leave the
       *  selection - same rule as `setLayerMode`, so a "move to Notes" from
       *  a Blueprint-only view doesn't leave handles on an invisible shape.
       *  Every layer entry point (inspector segment control, Promote /
       *  Demote buttons, ⇧⌘P, `setShapeLayer`) funnels through here. */
      const _moveLayer = (ids: readonly string[], layer: Layer) => {
        if (ids.length === 0) return;
        const all = get().diagram.shapes;
        const allConns = get().diagram.connectors;
        const expanded = expandAllDescendants(ids, all);
        const sel = new Set(ids);
        const movedConns = new Set<string>();
        for (const c of allConns) {
          if (sel.has(c.id) || (c.parent && expanded.has(c.parent))) {
            movedConns.add(c.id);
            continue;
          }
          const f = 'shape' in c.from ? c.from.shape : null;
          const t = 'shape' in c.to ? c.to.shape : null;
          if (f && t && expanded.has(f) && expanded.has(t)) movedConns.add(c.id);
        }
        const shapeChanges = all.some(
          (sh) => expanded.has(sh.id) && sh.layer !== layer,
        );
        const connChanges = allConns.some(
          (c) => movedConns.has(c.id) && connectorLayer(c) !== layer,
        );
        if (!shapeChanges && !connChanges) return;
        _snapshot();
        _mutate({
          shapes: all.map((sh) =>
            expanded.has(sh.id) && sh.layer !== layer ? { ...sh, layer } : sh,
          ),
          connectors: allConns.map((c) =>
            movedConns.has(c.id) && connectorLayer(c) !== layer
              ? { ...c, layer }
              : c,
          ),
        });
        const s = get();
        const visible = visibleItemIds(
          s.diagram.shapes,
          s.diagram.connectors,
          s.layerMode,
        );
        const kept = s.selectedIds.filter((id) => visible.has(id));
        if (kept.length !== s.selectedIds.length) s.setSelected(kept);
      };

      /** Merge `patch` into table cell `[row][col]`. Allocates rows/cells
       *  lazily so sparse tables stay sparse on disk. If the merged cell ends
       *  up empty (no text + no overrides) we drop the cell to null so an
       *  edit-then-clear cycle doesn't leave behind stub objects. */
      const _writeCell = (
        sh: Shape,
        row: number,
        col: number,
        patch: Partial<TableCell>,
      ): Shape['cells'] => {
        if (sh.kind !== 'table') return sh.cells;
        const rows = Math.max(1, Math.floor(sh.rows ?? 3));
        const cols = Math.max(1, Math.floor(sh.cols ?? 3));
        if (row < 0 || row >= rows || col < 0 || col >= cols) return sh.cells;
        const next = (sh.cells ?? []).slice() as (TableCell | null)[][];
        while (next.length <= row) next.push([]);
        const r = (next[row] ?? []).slice();
        while (r.length <= col) r.push(null);
        const cur = r[col] ?? {};
        const merged: TableCell = { ...cur, ...patch };
        // Drop empty/blank cells back to null so sparse storage stays sparse.
        const isEmpty =
          (merged.text === undefined || merged.text === '') &&
          merged.anchor === undefined &&
          merged.textColor === undefined &&
          merged.fontFamily === undefined &&
          merged.fontSize === undefined &&
          merged.fill === undefined;
        r[col] = isEmpty ? null : merged;
        next[row] = r;
        return next;
      };

      // Bootstrap a single tab id so every action has a stable activeTabId
      // to reference. Persisted across reloads via the `activeTabId` /
      // `diagramTabs` slots - restore picks up exactly where it left off.
      const initialTabId = newId('tab');

      return {
        // Boot blank - the demo fixture (`renderPipeline`) is available via
        // the file menu so users can load it on demand without it ambushing
        // their first impression.
        diagram: { ...EMPTY_DIAGRAM, shapes: [], connectors: [], annotations: [] },
        filePath: null,
        dirty: false,
        workspaceId: newId('workspace'),
        workspaceRevision: 0,
        savedRevision: 0,
        exportReturnTabId: null,
        lastSavedAt: null,

        diagramTabs: [{ id: initialTabId }],
        activeTabId: initialTabId,
        tabSnapshots: {},
        tabHistories: {},
        tabsBarHeight: TABS_BAR_DEFAULT_PX,
        rightDockOpen: false,
        rightDockWidth: RIGHT_DOCK_DEFAULT_PX,
        tabsBarCollapsed: false,

        zoom: 1,
        pan: { x: 0, y: 0 },

        selectedIds: [],
        focusedGroupId: null,

        activeTool: '1',
        toolLock: false,
        hotkeyBindings: DEFAULT_BINDINGS,

        layerMode: 'both',
        activeLayer: 'blueprint',
        theme: 'dark',
        uiTextScale: DEFAULT_TEXT_SCALE,

        canvasPaper: undefined,
        showDots: true,
        showGrid: false,
        exportPrefs: DEFAULT_EXPORT_PREFS,
        // Opt-in canvas chrome. When enabled, shapes show width × height and
        // connectors show their routed path length, all in world-space px.
        showMeasurements: false,

        // Tips on by default - once the user knows the keystroke, they flip
        // it off in Customise canvas. activeTipKey is session-scoped so the
        // toast doesn't ghost-render on reload.
        tipsEnabled: true,
        activeTipKey: null,

        // Default OFF - opt-in feature. When the user turns it on globally
        // (Settings ▸ Editing ▸ Smart anchors on every shape), every shape without an
        // explicit per-shape value exposes the 8-point grid.
        smartAnchorsGlobal: false,
        // Workspace default count - matches SMART_ANCHOR_DEFAULT_COUNT (8,
        // the corners + edge mids set). Defaults inspector lets the user
        // raise or lower it; per-shape `smartAnchorCount` still wins.
        smartAnchorCountGlobal: 8,

        // Default ON - most users want align-snap during drag/draw. ⌥/Alt
        // free-places a single gesture.
        shapeSnapEnabled: true,
        gridSnapEnabled: true,
        snapEnabled: true,

        // First-run welcome dialog - false until the user finishes it.
        hasCompletedOnboarding: false,

        penColor: 'var(--ink)',
        penWidth: 3,

        lastStyles: {},
        lastConnectorStyle: {},

        morePopoverOpen: false,
        cmdkOpen: false,
        saveDialogOpen: false,
        saveDialogFormat: null,
        saveDialogSelectionOnly: false,
        libraryPanelOpen: false,
        legalDialogOpen: false,
        legalDialogTab: 'ip-complaints',
        findOpen: false,
        importDialogOpen: false,
        inspectorOpen: false,
        collapsedInspectorSections: {},
        editingShapeId: null,
        editingConnectorId: null,
        editingCell: null,
        selectedCell: null,

        past: [],
        future: [],
        clipboard: null,

        // tool / overlay
        setActiveTool: (k) => set({ activeTool: k, morePopoverOpen: false }),
        toggleLock: () => set((s) => ({ toolLock: !s.toolLock })),
        setLayerMode: (m) =>
          set((s) => {
            if (s.layerMode === m) return {};
            // Narrowing the view to a single layer re-points the draw target
            // at it: picking "Notes" from the pills and then drawing onto
            // Blueprint would put the new shape somewhere the user can't see.
            // `both` leaves the draw target alone - it's the "show me
            // everything" view, and the toolbar toggle owns the choice there.
            const activeLayer = m === 'both' ? s.activeLayer : m;
            // Items on a layer that just went hidden drop out of the
            // selection. Keeping them selected left a ghost halo + resize
            // handles over an invisible shape, and the next ⌫ / nudge /
            // inspector edit silently mutated something the user couldn't
            // see. The focused group follows the same rule.
            const visible = visibleItemIds(
              s.diagram.shapes,
              s.diagram.connectors,
              m,
            );
            const selectedIds = s.selectedIds.filter((id) => visible.has(id));
            const sc = s.selectedCell;
            const keepCell = sc ? selectedIds.includes(sc.shapeId) : true;
            return {
              layerMode: m,
              activeLayer,
              selectedIds:
                selectedIds.length === s.selectedIds.length
                  ? s.selectedIds
                  : selectedIds,
              selectedCell: keepCell ? sc : null,
              editingCell: keepCell ? s.editingCell : null,
              focusedGroupId:
                s.focusedGroupId && !visible.has(s.focusedGroupId)
                  ? null
                  : s.focusedGroupId,
            };
          }),
        /** Point the draw target at `l`. If the current view hides that layer
         *  the view widens to it too - otherwise the very next stroke would
         *  land somewhere invisible, which is the failure mode this whole
         *  toggle exists to remove. Widening to the layer itself (rather than
         *  `both`) keeps the user's "focus on one layer" intent when they had
         *  deliberately narrowed the view. */
        setActiveLayer: (l) => {
          const s = get();
          if (s.activeLayer === l) return;
          if (s.layerMode !== 'both' && s.layerMode !== l) {
            // Route through setLayerMode rather than setting both fields
            // here: widening the view has to prune anything the newly-hidden
            // layer was holding in the selection, and that rule is there.
            // setLayerMode re-points activeLayer at `l` on the way through.
            s.setLayerMode(l);
            return;
          }
          set({ activeLayer: l });
        },
        toggleActiveLayer: () =>
          get().setActiveLayer(
            get().activeLayer === 'notes' ? 'blueprint' : 'notes',
          ),
        setTheme: (t) => set({ theme: t }),
        toggleTheme: () =>
          set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
        setUiTextScale: (scale) => set({ uiTextScale: sanitizeTextScale(scale) }),
        toggleMorePopover: () =>
          set((s) => ({ morePopoverOpen: !s.morePopoverOpen, cmdkOpen: false })),
        setMorePopoverOpen: (open) => set({ morePopoverOpen: open }),
        toggleCmdk: () =>
          set((s) => ({ cmdkOpen: !s.cmdkOpen, morePopoverOpen: false })),
        setCmdkOpen: (open) => set({ cmdkOpen: open }),
        setSaveDialogOpen: (open, format, opts) =>
          set({
            saveDialogOpen: open,
            saveDialogFormat: open ? (format ?? null) : null,
            saveDialogSelectionOnly: open ? !!opts?.selectionOnly : false,
          }),
        setFindOpen: (open) => set({ findOpen: open }),
        toggleFind: () => set((s) => ({ findOpen: !s.findOpen })),
        replaceTextAll: (find, replacement, matchCase) => {
          if (!find) return 0;
          const needle = matchCase ? find : find.toLowerCase();
          let count = 0;
          const replaceIn = (s: string): string => {
            const haystack = matchCase ? s : s.toLowerCase();
            if (haystack.indexOf(needle) === -1) return s;
            let out = '';
            let i = 0;
            while (i < s.length) {
              const idx = haystack.indexOf(needle, i);
              if (idx === -1) {
                out += s.slice(i);
                break;
              }
              out += s.slice(i, idx) + replacement;
              i = idx + needle.length;
              count++;
            }
            return out;
          };
          const shapesNext = get().diagram.shapes.map((sh) => {
            let next = sh;
            const apply = (field: 'label' | 'body' | 'sublabel') => {
              const v = next[field];
              if (typeof v !== 'string' || !v) return;
              const out = replaceIn(v);
              if (out !== v) next = { ...next, [field]: out };
            };
            apply('label');
            apply('body');
            apply('sublabel');
            if (next.cells) {
              let cellsChanged = false;
              const newCells = next.cells.map((row) =>
                row
                  ? row.map((cell) => {
                      if (!cell || typeof cell.text !== 'string' || !cell.text) {
                        return cell;
                      }
                      const out = replaceIn(cell.text);
                      if (out === cell.text) return cell;
                      cellsChanged = true;
                      return { ...cell, text: out };
                    })
                  : row,
              );
              if (cellsChanged) next = { ...next, cells: newCells };
            }
            return next;
          });
          const connsNext = get().diagram.connectors.map((c) => {
            if (typeof c.label !== 'string' || !c.label) return c;
            const out = replaceIn(c.label);
            return out === c.label ? c : { ...c, label: out };
          });
          if (count === 0) return 0;
          _snapshot();
          _mutate({ shapes: shapesNext, connectors: connsNext });
          return count;
        },
        toggleLibraryPanel: () =>
          set((s) => ({ libraryPanelOpen: !s.libraryPanelOpen })),
        setLibraryPanelOpen: (open) => set({ libraryPanelOpen: open }),
        openLegalDialog: (tab = 'ip-complaints') =>
          set({ legalDialogOpen: true, legalDialogTab: tab }),
        closeLegalDialog: () => set({ legalDialogOpen: false }),
        setImportDialogOpen: (open) => set({ importDialogOpen: open }),
        toggleInspector: () =>
          set((s) => ({ inspectorOpen: !s.inspectorOpen })),
        setInspectorOpen: (open) => set({ inspectorOpen: open }),
        toggleInspectorSection: (key) =>
          set((s) => {
            const next = { ...s.collapsedInspectorSections };
            // Store only the folded ones - an open section is the default,
            // so deleting the key keeps the persisted map from accreting
            // `false` entries for every section the user has ever toggled.
            if (next[key]) delete next[key];
            else next[key] = true;
            return { collapsedInspectorSections: next };
          }),
        setEditingShapeId: (id) =>
          // Mutually exclusive with cell-edit and connector-edit - opening
          // one closes the others so a stray contenteditable from a previous
          // gesture can't linger over the new edit target.
          set({
            editingShapeId: id,
            editingCell: id ? null : get().editingCell,
            editingConnectorId: id ? null : get().editingConnectorId,
          }),
        setEditingConnectorId: (id) =>
          set({
            editingConnectorId: id,
            editingShapeId: id ? null : get().editingShapeId,
            editingCell: id ? null : get().editingCell,
          }),
        setEditingCell: (loc) =>
          set({
            editingCell: loc,
            editingShapeId: loc ? null : get().editingShapeId,
            // Entering cell-edit on a different cell promotes that cell to
            // the selected cell too, so the CELL inspector section stays
            // visible after the user commits and exits.
            selectedCell: loc ?? get().selectedCell,
          }),
        setSelectedCell: (loc) => set({ selectedCell: loc }),
        setCellText: (shapeId, row, col, text) => {
          _snapshot();
          _mutate({
            shapes: get().diagram.shapes.map((sh) =>
              sh.id === shapeId
                ? { ...sh, cells: _writeCell(sh, row, col, { text: text || undefined }) }
                : sh,
            ),
          });
        },
        setCellPatch: (shapeId, row, col, patch) => {
          _snapshot();
          _mutate({
            shapes: get().diagram.shapes.map((sh) =>
              sh.id === shapeId
                ? { ...sh, cells: _writeCell(sh, row, col, patch) }
                : sh,
            ),
          });
        },
        insertTableRow: (shapeId, index) => {
          _snapshot();
          _mutate({
            shapes: get().diagram.shapes.map((sh) => {
              if (sh.id !== shapeId || sh.kind !== 'table') return sh;
              const rows = Math.max(1, Math.floor(sh.rows ?? 3));
              const cols = Math.max(1, Math.floor(sh.cols ?? 3));
              const at = Math.max(0, Math.min(rows, index));
              const cells = sh.cells ?? [];
              const next = [...cells];
              // Pad sparse rows to `at` so insertion lands at the right index.
              while (next.length < at) next.push([]);
              next.splice(at, 0, []);
              // If the user had custom row weights, splice in an entry for
              // the new row at the same index. Pick the average of existing
              // weights so the new row reads as "a normal-sized row" instead
              // of getting shrunk by all the heavy ones around it. If
              // rowHeights is absent, leave it absent - the renderer treats
              // missing as all-equal and the user's "I never resized" intent
              // is preserved.
              let newHeights: number[] | undefined = undefined;
              if (sh.rowHeights && sh.rowHeights.length > 0) {
                const avg =
                  sh.rowHeights.reduce((a, b) => a + b, 0) /
                  sh.rowHeights.length;
                newHeights = [...sh.rowHeights];
                newHeights.splice(at, 0, avg);
              }
              return {
                ...sh,
                rows: rows + 1,
                cells: next,
                // Grow the bbox proportionally so cell sizes stay constant.
                h: sh.h * ((rows + 1) / rows),
                cols,
                rowHeights: newHeights,
              };
            }),
          });
        },
        insertTableCol: (shapeId, index) => {
          _snapshot();
          _mutate({
            shapes: get().diagram.shapes.map((sh) => {
              if (sh.id !== shapeId || sh.kind !== 'table') return sh;
              const rows = Math.max(1, Math.floor(sh.rows ?? 3));
              const cols = Math.max(1, Math.floor(sh.cols ?? 3));
              const at = Math.max(0, Math.min(cols, index));
              const cells = sh.cells ?? [];
              const next = cells.map((row) => {
                const r = row ? [...row] : [];
                while (r.length < at) r.push(null);
                r.splice(at, 0, null);
                return r;
              });
              let newWidths: number[] | undefined = undefined;
              if (sh.colWidths && sh.colWidths.length > 0) {
                const avg =
                  sh.colWidths.reduce((a, b) => a + b, 0) /
                  sh.colWidths.length;
                newWidths = [...sh.colWidths];
                newWidths.splice(at, 0, avg);
              }
              return {
                ...sh,
                cols: cols + 1,
                cells: next,
                w: sh.w * ((cols + 1) / cols),
                rows,
                colWidths: newWidths,
              };
            }),
          });
        },
        deleteTableRow: (shapeId, index) => {
          _snapshot();
          _mutate({
            shapes: get().diagram.shapes.map((sh) => {
              if (sh.id !== shapeId || sh.kind !== 'table') return sh;
              const rows = Math.max(1, Math.floor(sh.rows ?? 3));
              if (rows <= 1) return sh;
              const at = Math.max(0, Math.min(rows - 1, index));
              const cells = sh.cells ?? [];
              const next = [...cells];
              if (next.length > at) next.splice(at, 1);
              let newHeights: number[] | undefined = undefined;
              if (sh.rowHeights && sh.rowHeights.length > 0) {
                newHeights = [...sh.rowHeights];
                if (newHeights.length > at) newHeights.splice(at, 1);
              }
              return {
                ...sh,
                rows: rows - 1,
                cells: next,
                h: sh.h * ((rows - 1) / rows),
                rowHeights: newHeights,
              };
            }),
          });
        },
        deleteTableCol: (shapeId, index) => {
          _snapshot();
          _mutate({
            shapes: get().diagram.shapes.map((sh) => {
              if (sh.id !== shapeId || sh.kind !== 'table') return sh;
              const cols = Math.max(1, Math.floor(sh.cols ?? 3));
              if (cols <= 1) return sh;
              const at = Math.max(0, Math.min(cols - 1, index));
              const cells = sh.cells ?? [];
              const next = cells.map((row) => {
                if (!row) return row;
                if (row.length <= at) return row;
                const r = [...row];
                r.splice(at, 1);
                return r;
              });
              let newWidths: number[] | undefined = undefined;
              if (sh.colWidths && sh.colWidths.length > 0) {
                newWidths = [...sh.colWidths];
                if (newWidths.length > at) newWidths.splice(at, 1);
              }
              return {
                ...sh,
                cols: cols - 1,
                cells: next,
                w: sh.w * ((cols - 1) / cols),
                colWidths: newWidths,
              };
            }),
          });
        },
        closeAllOverlays: () =>
          set({
            morePopoverOpen: false,
            cmdkOpen: false,
            saveDialogOpen: false,
            saveDialogFormat: null,
            saveDialogSelectionOnly: false,
            legalDialogOpen: false,
            findOpen: false,
            importDialogOpen: false,
            editingCell: null,
            // Esc through closeAllOverlays also exits "focused group" mode.
            // Pairs with the explicit setSelected(null) the keybinding does.
            focusedGroupId: null,
          }),

        // selection
        setSelected: (ids) =>
          set((s) => {
            const next = ids == null ? [] : Array.isArray(ids) ? ids : [ids];
            // Drop selectedCell when its host table is no longer selected.
            // The cell inspector section keys on selectedCell.shapeId being
            // in selectedIds; without this clear, picking another shape
            // would leave a dangling cell pointer.
            const sc = s.selectedCell;
            const keepCell = sc ? next.includes(sc.shapeId) : true;
            return {
              selectedIds: next,
              selectedCell: keepCell ? sc : null,
              editingCell: keepCell ? s.editingCell : null,
            };
          }),
        toggleSelected: (id) =>
          set((s) => ({
            selectedIds: s.selectedIds.includes(id)
              ? s.selectedIds.filter((x) => x !== id)
              : [...s.selectedIds, id],
          })),
        addToSelection: (ids) =>
          set((s) => {
            const set_ = new Set(s.selectedIds);
            ids.forEach((i) => set_.add(i));
            return { selectedIds: Array.from(set_) };
          }),
        setFocusedGroup: (id) =>
          set((s) => {
            // Defensive guard: refuse to focus an id that doesn't resolve to a
            // group shape. A stale id (e.g. one that survived a delete) would
            // freeze the editor in a "focus" mode that has nothing to focus.
            if (id != null) {
              const sh = s.diagram.shapes.find((x) => x.id === id);
              if (!sh || sh.kind !== 'group') return { focusedGroupId: null };
            }
            return { focusedGroupId: id };
          }),

        // viewport
        setZoom: (v) => set({ zoom: Math.max(0.1, Math.min(8, v)) }),
        zoomBy: (factor, around) =>
          set((s) => {
            const next = Math.max(0.1, Math.min(8, s.zoom * factor));
            const ratio = next / s.zoom;
            if (!around) return { zoom: next };
            // Anchor zoom around a screen point: world point under the cursor
            // stays put. New pan = around - (around - pan) * ratio.
            return {
              zoom: next,
              pan: {
                x: around.x - (around.x - s.pan.x) * ratio,
                y: around.y - (around.y - s.pan.y) * ratio,
              },
            };
          }),
        setPan: (p) => set({ pan: p }),
        panBy: (dx, dy) =>
          set((s) => ({ pan: { x: s.pan.x + dx, y: s.pan.y + dy } })),
        fitToContent: (vw, vh) => {
          const { shapes } = get().diagram;
          if (shapes.length === 0) {
            set({ zoom: 1, pan: { x: 0, y: 0 } });
            return;
          }
          let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;
          for (const sh of shapes) {
            minX = Math.min(minX, sh.x);
            minY = Math.min(minY, sh.y);
            maxX = Math.max(maxX, sh.x + sh.w);
            maxY = Math.max(maxY, sh.y + sh.h);
          }
          const w = maxX - minX;
          const h = maxY - minY;
          const pad = 80;
          const zx = (vw - pad * 2) / w;
          const zy = (vh - pad * 2) / h;
          const z = Math.max(0.1, Math.min(4, Math.min(zx, zy)));
          set({
            zoom: z,
            pan: {
              x: vw / 2 - (minX + w / 2) * z,
              y: vh / 2 - (minY + h / 2) * z,
            },
          });
        },
        resetView: () => set({ zoom: 1, pan: { x: 0, y: 0 } }),

        // diagram mutation
        addShape: (sh) => {
          _snapshot();
          set((s) => {
            const z = nextZ(s);
            return {
              diagram: {
                ...s.diagram,
                shapes: syncRacks(syncBoundaryEvents([
                  ...s.diagram.shapes,
                  applyTextAutoFit({ ...sh, z: sh.z ?? z }),
                ], s.diagram.shapes)),
              },
              dirty: true,
              selectedIds: [sh.id],
            };
          });
        },
        registerAssets: (entries) => {
          const hashes = Object.keys(entries);
          if (hashes.length === 0) return;
          set((s) => {
            const existing = s.diagram.assets ?? {};
            // Skip the write entirely when every hash is already present -
            // keeps duplicate pastes from dirtying the doc or notifying
            // asset subscribers for nothing.
            if (hashes.every((h) => h in existing)) return {};
            return {
              diagram: {
                ...s.diagram,
                assets: { ...existing, ...entries },
              },
              dirty: true,
            };
          });
        },
        addShapes: (shs) => {
          _snapshot();
          set((s) => {
            let z = nextZ(s);
            const stamped = shs.map((sh) =>
              applyTextAutoFit({ ...sh, z: sh.z ?? z++ }),
            );
            return {
              diagram: {
                ...s.diagram,
                shapes: syncRacks(syncBoundaryEvents([...s.diagram.shapes, ...stamped], s.diagram.shapes)),
              },
              dirty: true,
              selectedIds: shs.map((sh) => sh.id),
            };
          });
        },
        addConnector: (c) => {
          _snapshot();
          set((s) => {
            const z = nextZ(s);
            return {
              diagram: {
                ...s.diagram,
                connectors: [...s.diagram.connectors, { ...c, z: c.z ?? z }],
              },
              dirty: true,
              selectedIds: [c.id],
            };
          });
          // A line drawn entirely inside a container is adopted by it.
          _reconcileConnectorParents();
        },
        addFragment: (shs, conns, assets) => {
          for (const [hash, incoming] of Object.entries(assets ?? {})) {
            const existing = get().diagram.assets?.[hash];
            if (existing && (existing.mime !== incoming.mime || existing.data !== incoming.data)) {
              throw new Error(`Imported asset ${hash} conflicts with existing image data.`);
            }
          }
          _snapshot();
          set((s) => {
            let z = nextZ(s);
            const stampedShapes = shs.map((sh) =>
              applyTextAutoFit({ ...sh, z: sh.z ?? z++ }),
            );
            const stampedConns = conns.map((c) => ({ ...c, z: c.z ?? z++ }));
            return {
              diagram: {
                ...s.diagram,
                ...(assets ? { assets: { ...s.diagram.assets, ...assets } } : {}),
                shapes: syncRacks([...s.diagram.shapes, ...stampedShapes]),
                connectors: [...s.diagram.connectors, ...stampedConns],
              },
              dirty: true,
              selectedIds: [...shs.map((sh) => sh.id), ...conns.map((connector) => connector.id)],
            };
          });
          _reconcileConnectorParents();
        },
        replaceFragment: (removeIds, shs, conns) => {
          _snapshot();
          set((s) => {
            const allShapes = s.diagram.shapes;
            const allConns = s.diagram.connectors;
            // Expand to descendants - same semantics as deleteSelection so
            // a removed container/group takes its children with it.
            const expanded = expandAllDescendants(removeIds, allShapes);
            const keptShapes = allShapes.filter((sh) => !expanded.has(sh.id));
            // Connectors parented to a removed container go with it (child
            // contract); everything else follows deleteSelection's danglify
            // rule - endpoints bound to removed shapes float in place so the
            // user can reattach or delete them rather than losing the line.
            const removedConnIds = new Set(removeIds);
            for (const c of allConns) {
              if (c.parent && expanded.has(c.parent)) removedConnIds.add(c.id);
            }
            const keptConns = danglifyConnectors(
              allConns,
              expanded,
              removedConnIds,
              allShapes,
            );
            // z-stamp against the kept set so removed shapes' z values don't
            // pad the new fragment past where it needs to sit.
            let z = nextZ({
              ...s,
              diagram: {
                ...s.diagram,
                shapes: keptShapes,
                connectors: keptConns,
              },
            });
            const stampedShapes = shs.map((sh) =>
              applyTextAutoFit({ ...sh, z: sh.z ?? z++ }),
            );
            const stampedConns = conns.map((c) => ({ ...c, z: c.z ?? z++ }));
            return {
              diagram: {
                ...s.diagram,
                shapes: [...keptShapes, ...stampedShapes],
                connectors: [...keptConns, ...stampedConns],
              },
              dirty: true,
              selectedIds: shs.map((sh) => sh.id),
            };
          });
          // Mirror deleteSelection's tail: drop the focused-group pointer if
          // its target was just removed.
          const fg = get().focusedGroupId;
          if (fg && !get().diagram.shapes.some((sh) => sh.id === fg)) {
            set({ focusedGroupId: null });
          }
          // The replacement fragment defines fresh geometry - re-derive
          // connector parenting against it.
          _reconcileConnectorParents();
        },

        swapRackUnits: (sourceId, targetId) => {
          const state = get();
          if (state.readOnly) return;
          const byId = new Map(state.diagram.shapes.map(s => [s.id,s]));
          if ([sourceId,targetId].some(id => {
            const unit = byId.get(id);
            return !unit || !shapeVisibleInMode(unit,state.layerMode) || hiddenByCollapsedAncestor(unit,byId);
          })) return;
          const shapes = swapRackUnitPositions(state.diagram.shapes,sourceId,targetId);
          if (shapes === state.diagram.shapes) return;
          _snapshot();
          _mutate({shapes});
          _reconcileConnectorParents();
          get().setSelected(sourceId);
        },
        assignIconToRackUnit: (sourceId, targetId, live = false) => {
          const state = get();
          if (state.readOnly) return false;
          const byId = new Map(state.diagram.shapes.map(s => [s.id,s]));
          if ([sourceId,targetId].some(id => {
            const shape = byId.get(id);
            return !shape || !shapeVisibleInMode(shape,state.layerMode) || hiddenByCollapsedAncestor(shape,byId);
          })) return false;
          const next = assignRackUnitIcon(state.diagram.shapes,state.diagram.connectors,sourceId,targetId);
          if (!next) return false;
          if (!live) _snapshot();
          _mutate(next);
          if (!live) _reconcileConnectorParents();
          get().setSelected(targetId);
          return true;
        },
        updateShape: (id, patch) => {
          const target = get().diagram.shapes.find((sh) => sh.id === id);
          // Nothing to record for an unknown id or a patch that changes
          // nothing. Snapshotting regardless used to leave a no-op entry on
          // the stack - "I pressed Cmd+Z and nothing happened". The sticky
          // style mirror below still runs: re-clicking the active swatch
          // is a legitimate "make this the default" gesture.
          if (target && !_patchIsNoop(target, patch)) {
            _snapshot();
            _mutate({
              shapes: get().diagram.shapes.map((sh) =>
                sh.id === id
                  ? applyTextAutoFit(
                      applyManualFontSizeOnFit({ ...sh, ...patch }, patch),
                    )
                  : sh,
              ),
            });
          }
          // Mirror style fields onto lastStyles so the next freshly-created
          // shape inherits whatever the user just chose. Geometry-only edits
          // skip the setState (extractLastStyles returns null).
          const sticky = extractLastStyles(patch);
          if (sticky) {
            set((s) => ({ lastStyles: { ...s.lastStyles, ...sticky } }));
          }
        },
        setShapeBox: (id, box) => {
          const all = get().diagram.shapes;
          const target = all.find((sh) => sh.id === id);
          if (!target) return;
          const { patches, dx, dy, translated } = planBoxEdit(target, box, all);
          if (patches.length === 0) return;
          const byId = new Map(patches.map((p) => [p.id, p.patch]));
          const nextShapes = all.map((sh) => {
            const p = byId.get(sh.id);
            if (!p) return sh;
            return applyTextAutoFit(applyManualFontSizeOnFit({ ...sh, ...p }, p));
          });
          // Waypoints are world-space: a rigid move has to carry them or a
          // routed line snaps back to the shape it no longer touches. Same
          // rule nudgeSelection uses - carry a connector whose BOTH endpoints
          // moved, plus any connector parented to a moved container.
          const rigid = dx !== 0 || dy !== 0;
          const nextConns = !rigid
            ? get().diagram.connectors
            : get().diagram.connectors.map((c) => {
                const f = 'shape' in c.from ? c.from.shape : null;
                const t = 'shape' in c.to ? c.to.shape : null;
                const rideAlong =
                  f != null && t != null && translated.has(f) && translated.has(t);
                const containerChild = c.parent != null && translated.has(c.parent);
                if (!rideAlong && !containerChild) return c;
                const patch: Partial<Connector> = {};
                if (containerChild) {
                  if (!('shape' in c.from)) {
                    patch.from = { x: c.from.x + dx, y: c.from.y + dy };
                  }
                  if (!('shape' in c.to)) {
                    patch.to = { x: c.to.x + dx, y: c.to.y + dy };
                  }
                }
                if (c.waypoints?.length) {
                  patch.waypoints = c.waypoints.map((w) => ({
                    x: w.x + dx,
                    y: w.y + dy,
                  }));
                }
                return Object.keys(patch).length === 0 ? c : { ...c, ...patch };
              });
          _snapshot();
          _mutate({ shapes: nextShapes, connectors: nextConns });
          _reconcileConnectorParents();
        },
        updateShapeLive: (id, patch) => {
          _mutate({
            shapes: get().diagram.shapes.map((sh) =>
              sh.id === id
                ? applyTextAutoFit(
                    applyManualFontSizeOnFit({ ...sh, ...patch }, patch),
                  )
                : sh,
            ),
          });
        },
        updateShapeLiveRaw: (id, patch) => {
          // Same as updateShapeLive minus the autoFit. Required by the
          // text-shape corner-resize handler so the cursor visibly
          // controls the bbox during the drag; commit re-runs autoFit.
          _mutate({
            shapes: get().diagram.shapes.map((sh) =>
              sh.id === id ? { ...sh, ...patch } : sh,
            ),
          });
        },
        updateShapesLive: (patches) => {
          const map = new Map(patches.map((p) => [p.id, p.patch]));
          _mutate({
            shapes: get().diagram.shapes.map((sh) => {
              const p = map.get(sh.id);
              if (!p) return sh;
              return applyTextAutoFit(
                applyManualFontSizeOnFit({ ...sh, ...p }, p),
              );
            }),
          });
        },
        updateSelection: (patch) => {
          const sel = new Set(get().selectedIds);
          if (sel.size === 0) return;
          // Single-shape inspector edit on a single-shape selection is the
          // overwhelmingly common case - fall through to updateShape so we
          // don't disturb its existing semantics (snapshot, lastStyles
          // mirroring, identical history shape). Cross-type translation
          // only matters when the selection spans kinds, so the single
          // case can shortcut.
          if (sel.size === 1) {
            const onlyId = sel.values().next().value as string;
            const allShapes = get().diagram.shapes;
            const allConns = get().diagram.connectors;
            const onlyShape = allShapes.find((sh) => sh.id === onlyId);
            if (onlyShape) {
              // Group-as-only-selection still needs the descendant fan-out
              // below - fall through instead of shortcutting to updateShape.
              if (onlyShape.kind !== 'group') {
                get().updateShape(onlyId, patch);
                return;
              }
            } else {
              const onlyConn = allConns.find((c) => c.id === onlyId);
              if (onlyConn) {
                const cp = _shapePatchToConnectorPatch(patch);
                if (Object.keys(cp).length > 0) get().updateConnector(onlyId, cp);
                return;
              }
              return;
            }
          }
          // Build per-shape patches with cross-type translation. The
          // snapshot waits until we know something actually changes.
          const shapes = get().diagram.shapes;
          const conns = get().diagram.connectors;
          // Expand selected GROUPS to their descendants so a per-style patch
          // (text-anchor, font, fill, etc.) lands on every child too - a
          // group frame doesn't paint its own label/fill, so the user's
          // expectation when they pick a group + change text-anchor is that
          // the children get the change. Containers are NOT expanded - they
          // own their own label/style independent of their children.
          const expanded = expandGroupDescendants(sel, shapes);
          const nextShapes = shapes.map((sh) => {
            if (!expanded.has(sh.id)) return sh;
            const sp = _translateShapePatch(sh, patch);
            return Object.keys(sp).length === 0 || _patchIsNoop(sh, sp)
              ? sh
              : { ...sh, ...sp };
          });
          const cp = _shapePatchToConnectorPatch(patch);
          const nextConns =
            Object.keys(cp).length === 0
              ? conns
              : conns.map((c) =>
                  sel.has(c.id) && !_patchIsNoop(c, cp) ? { ...c, ...cp } : c,
                );
          const changed =
            nextShapes.some((sh, i) => sh !== shapes[i]) ||
            nextConns.some((c, i) => c !== conns[i]);
          if (changed) {
            _snapshot();
            _mutate({ shapes: nextShapes, connectors: nextConns });
          }
          // Mirror onto lastStyles / lastConnectorStyle so next-drawn shapes
          // inherit the choice the user just made - same contract as the
          // single-shape updateShape / updateConnector paths.
          const sticky = extractLastStyles(patch);
          if (sticky) {
            set((s) => ({ lastStyles: { ...s.lastStyles, ...sticky } }));
          }
          const stickyConn = extractLastConnectorStyle(cp);
          if (stickyConn) {
            set((s) => ({
              lastConnectorStyle: { ...s.lastConnectorStyle, ...stickyConn },
            }));
          }
        },
        updateConnector: (id, patch) => {
          const target = get().diagram.connectors.find((c) => c.id === id);
          // Same no-op guard as updateShape: no entry for a patch that
          // changes nothing; the sticky-style mirror below still runs.
          if (target && !_patchIsNoop(target, patch)) {
            _snapshot();
            _mutate({
              connectors: get().diagram.connectors.map((c) =>
                c.id === id ? { ...c, ...patch } : c,
              ),
            });
          }
          // Mirror appearance fields onto lastConnectorStyle so the next
          // arrow/line the user draws inherits them. Geometry-only patches
          // (waypoint drag, endpoint reanchor) skip the setState - same
          // shortcut as updateShape's lastStyles mirroring.
          const sticky = extractLastConnectorStyle(patch);
          if (sticky) {
            set((s) => ({
              lastConnectorStyle: { ...s.lastConnectorStyle, ...sticky },
            }));
          }
        },
        updateConnectorLive: (id, patch) => {
          _mutate({
            connectors: get().diagram.connectors.map((c) =>
              c.id === id ? { ...c, ...patch } : c,
            ),
          });
        },
        setShapeLayer: (id, layer) => _moveLayer([id], layer),
        setSelectionLayer: (layer) => _moveLayer(get().selectedIds, layer),
        promoteSelection: () => {
          // ⇧⌘P / inspector button - the selection moves to Blueprint.
          // Same subtree + owned-connector expansion as the LAYER segment
          // control right above it; the two used to disagree (promote
          // touched only the directly-selected ids, so promoting a
          // container left its children behind on Notes).
          _moveLayer(get().selectedIds, 'blueprint');
        },
        demoteSelection: () => {
          // Inverse of promoteSelection - the selection moves to Notes.
          _moveLayer(get().selectedIds, 'notes');
        },
        deleteSelection: () => {
          const ids = new Set(get().selectedIds);
          if (ids.size === 0) return;
          // Expand groups and containers to include their (recursive)
          // descendants. Deleting a group used to leave the children behind
          // - visually nothing changed because the group frame was invisible,
          // and the user thought delete had silently failed. Treat
          // delete-on-frame as "delete the frame and everything in it"; if
          // the user wants to keep the children, Cmd+Shift+G ungroups first.
          const all = get().diagram.shapes;
          const expanded = expandAllDescendants(ids, all);
          // Delete clears equipment in a U, retaining the independently linked slot.
          const clearedUnits = new Set(all.filter(sh => sh.rackUnit && expanded.has(sh.id) && !expanded.has(sh.parent!)).map(sh => sh.id));
          for (const id of clearedUnits) expanded.delete(id);
          _snapshot();
          // A connector parented to a deleted container is a child of that
          // frame and goes with it - same contract as the container's child
          // shapes. Fold those into the removed-connector set so they're
          // dropped outright rather than left behind as orphans.
          const removedConnIds = new Set(ids);
          for (const c of get().diagram.connectors) {
            if (c.parent && expanded.has(c.parent)) removedConnIds.add(c.id);
          }
          // For connectors NOT owned by a deleted container, convert any
          // endpoint bound to a deleted shape into a floating point (see
          // `danglifyConnectors`) so the line stays put instead of vanishing
          // - the user can reattach or delete it. Directly-selected
          // connectors are removed.
          _mutate({
            shapes: all.filter((sh) => !expanded.has(sh.id)).map(sh => clearedUnits.has(sh.id) ? clearRackUnit(sh) : sh),
            connectors: danglifyConnectors(
              get().diagram.connectors,
              expanded,
              removedConnIds,
              all,
            ),
          });
          // If the focused group was just deleted (directly or because its
          // ancestor frame was), drop the focus pointer.
          const fg = get().focusedGroupId;
          set({
            selectedIds: [],
            focusedGroupId: fg && expanded.has(fg) ? null : fg,
          });
          // Surviving danglified lines may now sit inside a different
          // container (or none) - re-derive their parent.
          _reconcileConnectorParents();
        },
        bringForward: () => {
          // Step one VISIBLE unselected item up in effective-z order -
          // see `reorderZ` for the full contract. No-op at the front.
          _reorderZ(get, _snapshot, _mutate, 'forward');
        },
        sendBackward: () => {
          _reorderZ(get, _snapshot, _mutate, 'backward');
        },
        bringToFront: () => {
          // Whole selection (frames with their subtrees) above everything
          // else - used by ⇧⌘] and the menu's "Bring to front" entry.
          _reorderZ(get, _snapshot, _mutate, 'front');
        },
        sendToBack: () => {
          _reorderZ(get, _snapshot, _mutate, 'back');
        },
        flipSelection: (axis) => {
          const shapes = get().diagram.shapes;
          // Expand groups + containers to their descendants - the same rule
          // the drag and nudge flows use. A frame's own box is derived from
          // its members, so mirroring the frame alone is undone by the next
          // recalculation and the members never move: flipping a group
          // looked as dead as flipping a single shape did.
          const sel = expandAllDescendants(new Set(get().selectedIds), shapes);
          if (sel.size === 0) return;
          // Combined bbox so we mirror around the centre of the selection
          // (not each shape's own centre).
          const targets = shapes.filter((s) => sel.has(s.id));
          if (targets.length === 0) return;
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const s of targets) {
            minX = Math.min(minX, s.x);
            minY = Math.min(minY, s.y);
            maxX = Math.max(maxX, s.x + s.w);
            maxY = Math.max(maxY, s.y + s.h);
          }
          const cx = (minX + maxX) / 2;
          const cy = (minY + maxY) / 2;
          _snapshot();
          _mutate({
            shapes: shapes.map((s) => {
              if (!sel.has(s.id)) return s;
              // Two halves, and the operation used to be only the first:
              //
              //  1. POSITION - mirror the box about the selection centre, so
              //     a flipped row of shapes comes back in reverse order.
              //     Reduces to `x = x` for a lone shape, which is why flip
              //     used to look completely dead on a single selection.
              //  2. THE SHAPE ITSELF - mirror what's inside the box. A pen
              //     stroke bakes it into `points` (its path is its geometry);
              //     everything else records `flipH`/`flipV` and the renderer
              //     mirrors the body about its own centre. Some kinds have
              //     nothing to mirror - see `shapeSupportsMirror`.
              //
              // Rotation negates on both axes: the render order is
              // rotate(θ)·mirror, and mirror·rotate(θ) === rotate(-θ)·mirror,
              // so without this a flipped tilt leans the wrong way.
              const mirrored: Partial<Shape> = {};
              if (s.kind === 'freehand' && s.points) {
                mirrored.points = mirrorFreehandPoints(s.points, s, axis);
              } else if (shapeSupportsMirror(s)) {
                const key = axis === 'horizontal' ? 'flipH' : 'flipV';
                // `undefined` rather than `false` when it flips back, so a
                // shape that has been flipped an even number of times
                // serializes exactly as it did before it was ever touched.
                mirrored[key] = s[key] === true ? undefined : true;
              }
              if (s.rotation) mirrored.rotation = -s.rotation;
              if (axis === 'horizontal') {
                return { ...s, ...mirrored, x: 2 * cx - (s.x + s.w) };
              }
              return { ...s, ...mirrored, y: 2 * cy - (s.y + s.h) };
            }),
          });
        },
        nudgeSelection: (dx, dy, mode = 'fixed') => {
          const sel = new Set(get().selectedIds);
          if (sel.size === 0) return;
          const allShapes = get().diagram.shapes;
          const allConns = get().diagram.connectors;

          // Expand groups + containers to descendants - same rule the drag
          // flow uses. Without this, nudging a group would move the frame
          // out from under its children. (Parents are always groups or
          // containers, so the all-descendants walk is equivalent to the
          // old explicit kind check.)
          const moveShapes = expandAllDescendants(sel, allShapes);
          if (moveShapes.size === 0) return;

          // Selection bbox - needed for both estimate-mode distance picking
          // and to identify which connectors are "in" the selection for
          // waypoint translation.
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const id of moveShapes) {
            const sh = allShapes.find((s) => s.id === id);
            if (!sh) continue;
            minX = Math.min(minX, sh.x);
            minY = Math.min(minY, sh.y);
            maxX = Math.max(maxX, sh.x + sh.w);
            maxY = Math.max(maxY, sh.y + sh.h);
          }
          if (!isFinite(minX)) return;

          let stepX = dx;
          let stepY = dy;
          if (mode === 'estimate') {
            // Direction-only - pick the dominant axis the user pressed.
            const sx = Math.sign(dx);
            const sy = Math.sign(dy);
            const horizontal = sx !== 0 && sy === 0;
            const vertical = sy !== 0 && sx === 0;
            const ref = {
              minX, minY, maxX, maxY,
              cx: (minX + maxX) / 2,
              cy: (minY + maxY) / 2,
            };
            // Candidates: every shape NOT being moved, and that isn't a
            // group/container (those are layout frames - measuring to their
            // edges produces results that don't match what the user sees).
            const others = allShapes.filter(
              (s) =>
                !moveShapes.has(s.id) &&
                s.kind !== 'group' &&
                s.kind !== 'container',
            );
            const dist = _estimateNudgeDistance(ref, others, sx, sy);
            if (dist != null && dist > 0) {
              if (horizontal) stepX = sx * dist;
              else if (vertical) stepY = sy * dist;
              else {
                // Diagonal - apply along whichever axis has a hit and let the
                // other axis fall back to the literal sign. (Arrow keys are
                // never diagonal in the keymap, but defend the entry point.)
                if (sx !== 0) stepX = sx * dist;
                if (sy !== 0) stepY = sy * dist;
              }
            }
            // Otherwise (no reference geometry) fall through to the literal
            // dx/dy - better to nudge by the raw delta than freeze.
          }

          if (stepX === 0 && stepY === 0) return;

          // Coalesce autorepeat nudges into one undo entry. Holding an arrow
          // key fires dozens of nudges; without this each snapshots and a
          // sustained hold overflows the history stack. Reuse the
          // existing snapshot when the previous nudge was very recent AND no
          // other action has pushed history since (the `past` array identity
          // is unchanged - every other mutation replaces it).
          const _now = Date.now();
          const nudgeKey = [...moveShapes].sort().join('|');
          const coalesceNudge =
            _now - lastNudgeAt < NUDGE_COALESCE_MS &&
            get().past === lastNudgePast &&
            nudgeKey === lastNudgeKey;
          if (!coalesceNudge) _snapshot();
          // A coalesced nudge extends the entry the first nudge pushed, so
          // tell _mutate there is nothing new to capture. Otherwise it
          // stashed this intermediate position as a pending live gesture,
          // and the next atomic edit (or Cmd+Z) sealed that as a stray step
          // - undo then walked the shapes back to mid-nudge.
          else lastSnapshottedDiagram = get().diagram;
          lastNudgeAt = _now;
          lastNudgePast = get().past;
          lastNudgeKey = nudgeKey;
          const nextShapes = allShapes.map((sh) =>
            moveShapes.has(sh.id)
              ? { ...sh, x: sh.x + stepX, y: sh.y + stepY }
              : sh,
          );
          // Connectors: ride-along when both endpoints are bound to moved
          // shapes (already follow their shapes, so nothing to patch on the
          // line itself BUT waypoints are world-space and would lag behind
          // unless we translate them). Directly-selected connectors - and
          // connectors parented to a moved container - get their floating
          // endpoints translated too, so a line living inside a nudged
          // container travels with it as a proper child.
          const nextConns = allConns.map((c) => {
            const fromShape = 'shape' in c.from ? c.from.shape : null;
            const toShape = 'shape' in c.to ? c.to.shape : null;
            const directlySelected = sel.has(c.id);
            const rideAlong =
              fromShape != null &&
              toShape != null &&
              moveShapes.has(fromShape) &&
              moveShapes.has(toShape);
            const containerChild = c.parent != null && moveShapes.has(c.parent);
            if (!directlySelected && !rideAlong && !containerChild) return c;
            const patch: Partial<Connector> = {};
            if (directlySelected || containerChild) {
              if (!('shape' in c.from)) {
                patch.from = { x: c.from.x + stepX, y: c.from.y + stepY };
              }
              if (!('shape' in c.to)) {
                patch.to = { x: c.to.x + stepX, y: c.to.y + stepY };
              }
            }
            if (
              (rideAlong || directlySelected || containerChild) &&
              c.waypoints?.length
            ) {
              patch.waypoints = c.waypoints.map((w) => ({
                x: w.x + stepX,
                y: w.y + stepY,
              }));
            }
            return Object.keys(patch).length === 0 ? c : { ...c, ...patch };
          });
          _mutate({ shapes: nextShapes, connectors: nextConns });
          _reconcileConnectorParents();
        },
        groupSelection: () => {
          const ids = new Set(get().selectedIds);
          const allShapes = get().diagram.shapes;
          // U slots belong to their rack; group the frame instead.
          for (const sh of allShapes) if (sh.rackUnit) ids.delete(sh.id);
          const members = allShapes.filter(
            (s) => ids.has(s.id) && s.kind !== 'group',
          );
          // Connectors are members in their own right, not just passengers
          // of the shapes they touch: "this box and the five arrows feeding
          // it" and "these five arrows" are both things a user groups. Their
          // `parent` is stamped exactly like a shape's, and the reconcile
          // pass leaves group parents alone (see reconcileConnectorParents).
          const connMembers = get().diagram.connectors.filter((c) =>
            ids.has(c.id),
          );
          if (members.length + connMembers.length < 2) return;
          // Compute the group's bounding box with a little padding.
          const pad = 12;
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const s of members) {
            minX = Math.min(minX, s.x);
            minY = Math.min(minY, s.y);
            maxX = Math.max(maxX, s.x + s.w);
            maxY = Math.max(maxY, s.y + s.h);
          }
          for (const c of connMembers) {
            const box = connectorBox(c, allShapes);
            if (!box) continue;
            minX = Math.min(minX, box.x);
            minY = Math.min(minY, box.y);
            maxX = Math.max(maxX, box.x + box.w);
            maxY = Math.max(maxY, box.y + box.h);
          }
          // Every member's geometry failed to resolve (all lines dangling
          // off deleted shapes) - nothing to frame.
          if (minX === Infinity) return;
          const groupId = newId('group');
          // The frame is on its members' layer. A hard-coded Blueprint
          // frame around Notes members was invisible in a Notes-only view,
          // so the group silently stopped acting like one there (clicks
          // resolved to the bare member, marquee / Cmd+A never picked the
          // frame up). Mixed-layer members fall back to the toolbar's draw
          // layer - the one the user is currently working on.
          const memberLayers = new Set<Layer>([
            ...members.map((s) => s.layer),
            ...connMembers.map((c) => connectorLayer(c)),
          ]);
          const groupLayer: Layer =
            memberLayers.size === 1
              ? [...memberLayers][0]
              : get().activeLayer;
          const group: Shape = {
            id: groupId,
            kind: 'group',
            x: minX - pad,
            y: minY - pad,
            w: maxX - minX + pad * 2,
            h: maxY - minY + pad * 2,
            label: '',
            layer: groupLayer,
          };
          const connMemberIds = new Set(connMembers.map((c) => c.id));
          _snapshot();
          // Insert the group BEFORE its members so it renders behind them.
          set((s) => ({
            diagram: {
              ...s.diagram,
              shapes: [
                group,
                ...s.diagram.shapes.map((sh) =>
                  ids.has(sh.id) ? { ...sh, parent: groupId } : sh,
                ),
              ],
              connectors: s.diagram.connectors.map((c) =>
                connMemberIds.has(c.id) ? { ...c, parent: groupId } : c,
              ),
            },
            dirty: true,
            selectedIds: [groupId],
          }));
        },
        ungroupSelection: () => {
          const sel = new Set(get().selectedIds);
          // Treat containers as ungroupable too - same operation: drop the
          // frame, free the children. Means Cmd+Shift+G is a one-stroke
          // "remove container" alongside "ungroup".
          const groups = get().diagram.shapes.filter(
            (s) =>
              sel.has(s.id) && (s.kind === 'group' || s.kind === 'container'),
          );
          if (groups.length === 0) return;
          const groupIds = new Set(groups.map((g) => g.id));
          _snapshot();
          set((s) => ({
            diagram: {
              ...s.diagram,
              shapes: s.diagram.shapes
                // Drop the group shapes themselves.
                .filter((sh) => !groupIds.has(sh.id))
                // Strip parent on any shape pointing at one of the killed
                // groups.
                .map((sh) =>
                  sh.parent && groupIds.has(sh.parent)
                    ? { ...sh, parent: undefined }
                    : sh,
                ),
              // Connector members are freed the same way. Dropping the field
              // (rather than leaving a dead id) matters: the reconcile pass
              // below only re-derives a container parent for lines that
              // aren't claimed by a group, and a stale group id would keep
              // them out of it forever.
              connectors: s.diagram.connectors.map((c) => {
                if (!c.parent || !groupIds.has(c.parent)) return c;
                const { parent: _drop, ...rest } = c;
                return rest;
              }),
            },
            dirty: true,
            selectedIds: [
              ...s.diagram.shapes
                .filter((sh) => sh.parent && groupIds.has(sh.parent))
                .map((sh) => sh.id),
              ...s.diagram.connectors
                .filter((c) => c.parent && groupIds.has(c.parent))
                .map((c) => c.id),
            ],
            // If the group the user was "inside" just got dissolved, exit
            // focus mode. Without this clear, focusedGroupId would point at
            // a shape that no longer exists and shapeUnder's focus-aware
            // branches would silently treat all clicks as "unrelated to the
            // missing group" (which is fine) but the visual focus halo
            // would also vanish into nothing - confusing state.
            focusedGroupId: groupIds.has(s.focusedGroupId ?? '')
              ? null
              : s.focusedGroupId,
          }));
          // A dissolved container leaves its lines pointing at a parent id
          // that no longer exists - re-derive so they re-home into an
          // enclosing container (or none) now rather than at the next
          // gesture commit.
          _reconcileConnectorParents();
        },

        // history seams. Every live gesture - the drag/resize/rotate/
        // connector handlers in Canvas.tsx, the table row/column resize
        // handles in Shape.tsx, the inline text editor's per-keystroke
        // writes - mutates through _mutate and calls commitHistory at
        // gesture END. It has to be the end: commitHistory pushes the
        // pre-state _mutate captured lazily on the gesture's first live
        // write, so a call at gesture START finds nothing pending and
        // no-ops (three handlers used to do exactly that, and their
        // gestures were silently unundoable). A forgotten end-call is
        // survivable - _snapshot and undo seal a leftover pre-state as its
        // own entry - but costs the user a stray step.
        commitHistory: () => {
          if (pendingPreState === null) return;
          _sealPending();
          // The gesture's geometry is now sealed - re-evaluate which container
          // (if any) owns each connector. Runs after the snapshot push so the
          // parent change rides the same undo step as the move/resize that
          // caused it. Covers every live gesture (drag, resize, rotate,
          // endpoint drag, line translate, waypoint edit) in one place.
          _reconcileConnectorParents();
        },
        cancelHistory: () => {
          if (pendingPreState !== null) {
            set({ diagram: pendingPreState, dirty: true });
          }
          pendingPreState = null;
          pendingPreSelection = [];
          lastSnapshottedDiagram = null;
        },
        beginHistoryBatch: () => {
          batchDepth++;
        },
        endHistoryBatch: () => {
          if (batchDepth === 0) return;
          batchDepth--;
          if (batchDepth === 0) get().commitHistory();
        },
        discardEmptyTextShape: (id) => {
          // Drop the session's live edits first: the pre-session diagram is
          // the baseline any entry recorded below should restore.
          get().cancelHistory();
          const cur = get().diagram;
          if (!cur.shapes.some((sh) => sh.id === id)) return;
          const past = get().past;
          const top = past[past.length - 1];
          // "The last recorded action created exactly this shape": its
          // pre-state is the current diagram minus the shape.
          const createdByLastEntry =
            top?.kind === 'diagram' &&
            top.diagram.shapes.length === cur.shapes.length - 1 &&
            top.diagram.connectors.length === cur.connectors.length &&
            !top.diagram.shapes.some((sh) => sh.id === id);
          if (createdByLastEntry) {
            set((s) => ({
              past: past.slice(0, -1),
              diagram: {
                ...s.diagram,
                shapes: s.diagram.shapes.filter((sh) => sh.id !== id),
              },
              dirty: true,
              selectedIds: s.selectedIds.filter((x) => x !== id),
            }));
            return;
          }
          get().replaceFragment([id], [], []);
        },
        undo: () => {
          // An unsealed live edit is the most recent thing the user did:
          // seal it so THIS press reverts it, instead of discarding it and
          // reverting the action before it (which also left the edit itself
          // impossible to undo). Any open batch closes with it - a bracket
          // that never ended must not defer every later snapshot.
          batchDepth = 0;
          _sealPending();
          const past = get().past;
          if (past.length === 0) return;
          const prev = past[past.length - 1];
          if (prev.kind === 'diagram') {
            set((s) => ({
              past: past.slice(0, -1),
              future: [
                {
                  kind: 'diagram',
                  diagram: s.diagram,
                  selectedIds: s.selectedIds.slice(),
                },
                ...s.future,
              ],
              diagram: prev.diagram,
              dirty: true,
              // Hand back what was selected before the undone edit, so the
              // inspector stays on the shape whose property just reverted
              // and an undone delete returns its shapes selected.
              selectedIds: _restorableSelection(prev.selectedIds, prev.diagram),
              // History travel can dissolve the focused group out from under
              // the user; clear focus to avoid pointing at a vanished id.
              focusedGroupId: null,
            }));
            return;
          }
          // 'tabs' entry - restore the full pre-event workspace, including
          // the per-tab undo stacks captured at event time. The redo entry
          // pushed into future captures the CURRENT post-event state in
          // the same shape, so redo round-trips back symmetrically.
          //
          // future is `[redoEntry, ...s.future]` (current future), NOT
          // prev.future: the entry's `future` field is a pre-event
          // snapshot, but in between event and undo the user may have
          // accumulated unrelated redo entries that we must preserve.
          set((s) => ({
            past: prev.past,
            future: [
              {
                kind: 'tabs',
                diagram: s.diagram,
                filePath: s.filePath,
                dirty: s.dirty,
                diagramTabs: s.diagramTabs.slice(),
                activeTabId: s.activeTabId,
                tabSnapshots: { ...s.tabSnapshots },
                past: s.past,
                future: s.future,
                tabHistories: { ...s.tabHistories },
              },
              ...s.future,
            ],
            diagram: prev.diagram,
            filePath: prev.filePath,
            dirty: prev.dirty,
            diagramTabs: prev.diagramTabs.slice(),
            activeTabId: prev.activeTabId,
            tabSnapshots: { ...prev.tabSnapshots },
            tabHistories: { ...prev.tabHistories },
            selectedIds: [],
            focusedGroupId: null,
          }));
        },
        redo: () => {
          // A pending live edit is a NEW edit - sealing it clears the redo
          // stack exactly as committing it would have, so this press then
          // correctly does nothing.
          batchDepth = 0;
          _sealPending();
          const future = get().future;
          if (future.length === 0) return;
          const nxt = future[0];
          if (nxt.kind === 'diagram') {
            set((s) => ({
              future: future.slice(1),
              past: [
                ...s.past,
                {
                  kind: 'diagram',
                  diagram: s.diagram,
                  selectedIds: s.selectedIds.slice(),
                },
              ],
              diagram: nxt.diagram,
              dirty: true,
              // The selection as it stood when the user pressed undo.
              selectedIds: _restorableSelection(nxt.selectedIds, nxt.diagram),
              focusedGroupId: null,
            }));
            return;
          }
          // 'tabs' redo - restore the full post-event workspace from
          // `nxt`, including per-tab stacks. No separate "redo undo"
          // entry is pushed into past: nxt.past already ends with the
          // event's original undoEntry, which serves as the undo target
          // for re-undoing this redo (it points at the same pre-event
          // state). nxt.future is the future snapshot the original
          // undo() captured (= future as it was just before that undo),
          // restoring the timeline cleanly.
          set(() => ({
            past: nxt.past,
            future: nxt.future,
            diagram: nxt.diagram,
            filePath: nxt.filePath,
            dirty: nxt.dirty,
            diagramTabs: nxt.diagramTabs.slice(),
            activeTabId: nxt.activeTabId,
            tabSnapshots: { ...nxt.tabSnapshots },
            tabHistories: { ...nxt.tabHistories },
            selectedIds: [],
            focusedGroupId: null,
          }));
        },

        // clipboard
        copySelection: () => {
          const fragment = captureFragment(get().diagram, new Set(get().selectedIds), detachUnselectedEndpoints);
          if (fragment.shapes.length || fragment.connectors.length) set({ clipboard: fragment });
        },
        cutSelection: () => {
          get().copySelection();
          get().deleteSelection();
        },
        paste: (at) => {
          const cb = get().clipboard;
          if (!cb || (cb.shapes.length === 0 && cb.connectors.length === 0)) {
            return;
          }
          const box = fragmentBounds(cb);
          const dx = at && box ? at.x - box.x - box.w / 2 : 24;
          const dy = at && box ? at.y - box.y - box.h / 2 : 24;
          const { shapes: newShapes, connectors: newConnectors } = remapFragment(cb, dx, dy, newId);
          _snapshot();
          set((s) => {
            // Re-stamp z so the new bundle lands ON TOP of whatever's already
            // on the canvas. structuredClone preserves the originals' z, which
            // is wrong if those were drawn before later items.
            let topZ = 0;
            for (const sh of s.diagram.shapes) {
              if (typeof sh.z === 'number' && sh.z > topZ) topZ = sh.z;
            }
            for (const cc of s.diagram.connectors) {
              if (typeof cc.z === 'number' && cc.z > topZ) topZ = cc.z;
            }
            // Sort by the originals' z before re-stamping so the pasted bundle
            // keeps its visible front/back order. diagram.shapes is in
            // insertion order, which diverges from `.z` as soon as
            // bringForward / sendBackward / sendToBack runs - without this
            // sort, paste scrambles relative stacking of overlapping shapes.
            // Effective z (members lifted above their container) rather
            // than raw - a child adopted into a later-drawn container has
            // a lower raw z than the frame, and a raw sort would stamp the
            // frame above it.
            const effZ = effectiveZMap(newShapes, newConnectors);
            const byZ = <T extends { id: string }>(a: T, b: T) =>
              (effZ.get(a.id) ?? 0) - (effZ.get(b.id) ?? 0);
            const orderedShapes = [...newShapes].sort(byZ);
            const orderedConns = [...newConnectors].sort(byZ);
            const stampedShapes = orderedShapes.map((sh) => ({ ...sh, z: ++topZ }));
            const stampedConns = orderedConns.map((cc) => ({ ...cc, z: ++topZ }));
            // Select top-level shapes + every pasted connector. Top-level
            // only for shapes - selecting children too caused later resize
            // gestures to grab the child's handles instead of the
            // container's. Connectors MUST be in the selection so the
            // mouse-drag handler picks up their waypoints + floating
            // endpoints (it has no ride-along fallback there); without
            // this, dragging the pasted bundle leaves curve bends glued
            // to their old world coordinates.
            const stampedIds = new Set(stampedShapes.map((ss) => ss.id));
            const topLevelStamped = stampedShapes.filter(
              (ss) => !ss.parent || !stampedIds.has(ss.parent),
            );
            const newSel = [
              ...topLevelStamped.map((ss) => ss.id),
              ...stampedConns.map((cc) => cc.id),
            ];
            // Merge registry entries for pasted `asset:` refs the target
            // diagram doesn't hold yet (cross-tab paste). Same-tab pastes
            // and dupes find every hash already present and skip the merge.
            let mergedAssets = s.diagram.assets;
            if (cb.assets) {
              for (const sh of stampedShapes) {
                if (!isAssetSrc(sh.src)) continue;
                const hash = assetHashFromSrc(sh.src);
                if (mergedAssets?.[hash] || !cb.assets[hash]) continue;
                mergedAssets = { ...(mergedAssets ?? {}), [hash]: cb.assets[hash] };
              }
            }
            return {
              diagram: {
                ...s.diagram,
                shapes: syncRacks([...s.diagram.shapes, ...stampedShapes]),
                connectors: [...s.diagram.connectors, ...stampedConns],
                ...(mergedAssets !== s.diagram.assets
                  ? { assets: mergedAssets }
                  : {}),
              },
              dirty: true,
              selectedIds: newSel,
            };
          });
          // Cross-document pastes drop the parent link above; re-adopt the
          // pasted lines into whatever container they landed inside.
          _reconcileConnectorParents();
        },
        duplicateSelection: () => {
          const fragment = captureFragment(get().diagram, new Set(get().selectedIds), detachUnselectedEndpoints);
          if (!fragment.shapes.length && !fragment.connectors.length) return;
          const { shapes: newShapes, connectors: newConnectors } = remapFragment(fragment, 24, 24, newId);
          _snapshot();
          set((s) => {
            // Re-stamp z so the new bundle lands ON TOP of whatever's already
            // on the canvas. structuredClone preserves the originals' z, which
            // is wrong if those were drawn before later items.
            let topZ = 0;
            for (const sh of s.diagram.shapes) {
              if (typeof sh.z === 'number' && sh.z > topZ) topZ = sh.z;
            }
            for (const cc of s.diagram.connectors) {
              if (typeof cc.z === 'number' && cc.z > topZ) topZ = cc.z;
            }
            // Stamp in effective-z order (same as paste) so the clones keep
            // the originals' visible stacking.
            const effZ = effectiveZMap(newShapes, newConnectors);
            const byZ = <T extends { id: string }>(a: T, b: T) =>
              (effZ.get(a.id) ?? 0) - (effZ.get(b.id) ?? 0);
            const stampedShapes = [...newShapes]
              .sort(byZ)
              .map((sh) => ({ ...sh, z: ++topZ }));
            const stampedConns = [...newConnectors]
              .sort(byZ)
              .map((cc) => ({ ...cc, z: ++topZ }));
            const newSel =
              stampedShapes.length > 0
                ? stampedShapes.map((ss) => ss.id)
                : stampedConns.map((cc) => cc.id);
            return {
              diagram: {
                ...s.diagram,
                shapes: syncRacks([...s.diagram.shapes, ...stampedShapes]),
                connectors: [...s.diagram.connectors, ...stampedConns],
              },
              dirty: true,
              selectedIds: newSel,
            };
          });
          _reconcileConnectorParents();
        },

        duplicateShapesLive: (ids) => {
          const shapeIdMap = new Map<string, string>();
          const connIdMap = new Map<string, string>();
          const idSet = new Set(ids);
          const all = get().diagram.shapes;
          const allConns = get().diagram.connectors;
          const srcShapes = all.filter((s) => idSet.has(s.id));
          if (srcShapes.length === 0)
            return { shapeIdMap, connIdMap };
          // Clone with NO offset - clones land exactly on the originals, then
          // the caller drags them. New id + new seed (so hand-drawn shapes
          // re-roll their jitter and don't look like carbon copies).
          const newShapes: Shape[] = srcShapes.map((sh) => {
            const id = newId(sh.kind);
            shapeIdMap.set(sh.id, id);
            return {
              ...structuredClone(sh),
              id,
              seed: Math.floor(Math.random() * 1e6),
            };
          });
          // Parent + anchorId remap: keep intra-set links pointed at the
          // clones; drop links to shapes outside the dragged set.
          for (const ns of newShapes) {
            if (ns.parent && shapeIdMap.has(ns.parent)) {
              ns.parent = shapeIdMap.get(ns.parent);
            } else if (ns.parent) {
              ns.parent = undefined;
            }
            if (ns.anchorId && shapeIdMap.has(ns.anchorId)) {
              ns.anchorId = shapeIdMap.get(ns.anchorId);
            } else if (ns.anchorId) {
              ns.anchorId = undefined;
            }
          }
          // Clone a connector when both endpoints are bound to shapes in the
          // dragged set (ride-along) OR it's parented to a dragged container
          // (a line living inside the box). A half-attached connector stays
          // with the original - cloning it would leave a dangling copy.
          const remapEndpoint = (ep: ConnectorEndpoint): ConnectorEndpoint => {
            if ('shape' in ep) {
              return { ...ep, shape: shapeIdMap.get(ep.shape) ?? ep.shape };
            }
            return { x: ep.x, y: ep.y };
          };
          const newConns: Connector[] = allConns
            .filter((c) => {
              const f = 'shape' in c.from ? c.from.shape : null;
              const t = 'shape' in c.to ? c.to.shape : null;
              const rideAlong =
                f != null && t != null && idSet.has(f) && idSet.has(t);
              const containerChild = c.parent != null && idSet.has(c.parent);
              return rideAlong || containerChild;
            })
            .map((c) => {
              const cloned = structuredClone(c);
              const id = newId('c');
              connIdMap.set(c.id, id);
              // Point the clone's parent at the cloned container (or drop it
              // if that container didn't come along).
              const parent =
                cloned.parent && shapeIdMap.has(cloned.parent)
                  ? shapeIdMap.get(cloned.parent)
                  : undefined;
              return {
                ...cloned,
                id,
                parent,
                from: remapEndpoint(cloned.from),
                to: remapEndpoint(cloned.to),
                waypoints: cloned.waypoints?.map((wp) => ({ x: wp.x, y: wp.y })),
              };
            });
          // Re-stamp z so the clones sit on top, matching duplicateSelection.
          let topZ = 0;
          for (const sh of all) {
            if (typeof sh.z === 'number' && sh.z > topZ) topZ = sh.z;
          }
          for (const cc of allConns) {
            if (typeof cc.z === 'number' && cc.z > topZ) topZ = cc.z;
          }
          const effZ = effectiveZMap(newShapes, newConns);
          const byZ = <T extends { id: string }>(a: T, b: T) =>
            (effZ.get(a.id) ?? 0) - (effZ.get(b.id) ?? 0);
          const stampedShapes = [...newShapes]
            .sort(byZ)
            .map((sh) => ({ ...sh, z: ++topZ }));
          const stampedConns = [...newConns]
            .sort(byZ)
            .map((cc) => ({ ...cc, z: ++topZ }));
          // Live mutate - folds into the active gesture's pending pre-state so
          // commitHistory seals "duplicate + drag" as one undo step. No
          // _snapshot here; the caller's first updateShapesLive (or this call,
          // if it lands first) is what stashes the pre-drag diagram.
          _mutate({
            shapes: [...get().diagram.shapes, ...stampedShapes],
            connectors: [...get().diagram.connectors, ...stampedConns],
          });
          return { shapeIdMap, connIdMap };
        },

        // file
        setFilePath: (path) => set((s) => ({ filePath: path,
          tabSnapshots: Object.fromEntries(Object.entries(s.tabSnapshots).map(([id, snap]) => [id, { ...snap, filePath: path }])),
        })),
        setDirty: (d) => set({ dirty: d }),
        markSaved: (receipt) => set((s) => {
          if (receipt && receipt.workspaceId !== s.workspaceId) return {};
          const written = receipt?.workspace.tabs;
          const matches = (id: string, diagram: DiagramState) => !written || written.some((tab) => tab.id === id && tab.diagram === diagram);
          return {
            savedRevision: Math.max(s.savedRevision, receipt?.revision ?? s.workspaceRevision),
            dirty: matches(s.activeTabId, s.diagram) ? false : s.dirty,
            lastSavedAt: Date.now(),
            tabSnapshots: Object.fromEntries(Object.entries(s.tabSnapshots).map(([id, snap]) => [id,
              snap.dirty && matches(id, snap.diagram) ? { ...snap, dirty: false } : snap,
            ])),
          };
        }),
        applyDiagram: (diagram) => {
          _snapshot();
          _resetLiveTracking();
          set({ diagram: { ...diagram, shapes: syncRacks(diagram.shapes) }, dirty: true, selectedIds: [], focusedGroupId: null });
        },
        applyWorkspace: (workspace) => {
          _sealPending();
          const s = get();
          const entry: HistoryEntry = {
            kind: 'tabs', diagram: s.diagram, filePath: s.filePath, dirty: s.dirty,
            diagramTabs: s.diagramTabs, activeTabId: s.activeTabId, tabSnapshots: s.tabSnapshots,
            past: s.past, future: s.future, tabHistories: s.tabHistories,
          };
          const active = workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ?? workspace.tabs[0];
          if (!active) throw new Error('A workspace must contain a tab.');
          _resetLiveTracking();
          set({
            diagram: active.diagram, activeTabId: active.id,
            diagramTabs: workspace.tabs.map(({ id }) => ({ id })),
            tabSnapshots: Object.fromEntries(workspace.tabs.filter((tab) => tab.id !== active.id).map((tab) => [tab.id,
              { diagram: tab.diagram, dirty: true, filePath: s.filePath },
            ])),
            dirty: true, past: [...s.past.slice(-(HISTORY_LIMIT - 1)), entry], future: [], tabHistories: {},
            selectedIds: [], focusedGroupId: null,
          });
        },
        loadDiagram: (d, path) => {
          recoveryStorage.resume();
          // Drop any uncommitted live-drag tracking - it refers to a diagram
          // that's about to be replaced wholesale.
          _resetLiveTracking();
          set({
            workspaceId: newId('workspace'),
            diagram: { ...d, shapes: syncRacks(d.shapes) },
            filePath: path,
            dirty: false,
            lastSavedAt: Date.now(),
            past: [],
            future: [],
            // Per-tab histories are diagram-coupled - load wipes them so
            // an undo can't pull the user back into a state that doesn't
            // match the diagram now on disk.
            tabHistories: {},
            selectedIds: [],
            focusedGroupId: null,
          });
        },
        loadWorkspace: (payload, path) => {
          recoveryStorage.resume();
          // Resolve the active tab; fall back to the first tab if the
          // declared activeTabId doesn't match any entry (defensive - the
          // schema parser already coerces, but a hand-rolled call could
          // hand us anything).
          const tabs = payload.tabs;
          const activeId =
            tabs.find((t) => t.id === payload.activeTabId)?.id ?? tabs[0].id;
          const active = tabs.find((t) => t.id === activeId)!;
          const snapshots: Record<string, DiagramTabSnapshot> = {};
          for (const t of tabs) {
            if (t.id === activeId) continue;
            snapshots[t.id] = {
              diagram: t.diagram,
              filePath: path,
              dirty: false,
            };
          }
          // Drop any uncommitted live-drag tracking for the same reason as
          // loadDiagram - diagram is being replaced wholesale.
          _resetLiveTracking();
          set({
            workspaceId: newId('workspace'),
            diagramTabs: tabs.map((t) => ({ id: t.id })),
            activeTabId: activeId,
            tabSnapshots: snapshots,
            // Loaded tabs start without per-tab history; nothing on disk
            // describes a prior session's undo stack.
            tabHistories: {},
            diagram: active.diagram,
            filePath: path,
            dirty: false,
            lastSavedAt: Date.now(),
            past: [],
            future: [],
            selectedIds: [],
            focusedGroupId: null,
          });
        },
        renameDiagramTab: (id, title) => {
          const trimmed = title.trim();
          if (!trimmed) return;
          const s = get();
          if (id === s.activeTabId) {
            // Active tab - route through setTitle so the change goes onto
            // the undo stack alongside other diagram edits.
            s.setTitle(trimmed);
            return;
          }
          const snap = s.tabSnapshots[id];
          if (!snap) return;
          set({
            tabSnapshots: {
              ...s.tabSnapshots,
              [id]: {
                ...snap,
                diagram: {
                  ...snap.diagram,
                  meta: { ...snap.diagram.meta, title: trimmed },
                },
                dirty: true,
              },
            },
          });
        },
        reorderDiagramTab: (fromIndex, toIndex) => {
          const s = get();
          if (fromIndex === toIndex) return;
          if (fromIndex < 0 || fromIndex >= s.diagramTabs.length) return;
          if (toIndex < 0 || toIndex >= s.diagramTabs.length) return;
          const next = s.diagramTabs.slice();
          const [moved] = next.splice(fromIndex, 1);
          next.splice(toIndex, 0, moved);
          set({ diagramTabs: next });
        },
        newDiagram: () => {
          recoveryStorage.resume();
          // "New" = fresh project, not just a fresh active tab. Drop every
          // background tab snapshot and reseed the workspace with one empty
          // tab so the user gets a true blank slate. A previous version
          // cleared only the active slots, leaving the other tabs alone -
          // that read as "tabs are second-class" because the menu's "New"
          // didn't match the user's mental model of a new project.
          _resetLiveTracking();
          const freshTabId = newId('tab');
          set({
            workspaceId: newId('workspace'),
            diagram: { ...EMPTY_DIAGRAM, shapes: [], connectors: [], annotations: [] },
            filePath: null,
            dirty: false,
            lastSavedAt: null,
            past: [],
            future: [],
            selectedIds: [],
            focusedGroupId: null,
            zoom: 1,
            pan: { x: 0, y: 0 },
            diagramTabs: [{ id: freshTabId }],
            activeTabId: freshTabId,
            tabSnapshots: {},
            tabHistories: {},
          });
        },

        // Tab actions - see DiagramTabSnapshot for the storage shape. The
        // active tab's state is in s.diagram/filePath/dirty; switch
        // moves that state into a snapshot keyed by the OLD tab id and
        // pulls the NEW tab's snapshot back out.
        setTabsBarHeight: (h) => {
          const clamped = Math.max(
            TABS_BAR_MIN_PX,
            Math.min(TABS_BAR_MAX_PX, Math.round(h)),
          );
          set({ tabsBarHeight: clamped });
        },
        setRightDockOpen: (open) => set({ rightDockOpen: open }),
        setRightDockWidth: (w) => {
          const clamped = Math.max(
            RIGHT_DOCK_MIN_PX,
            Math.min(RIGHT_DOCK_MAX_PX, Math.round(w)),
          );
          set({ rightDockWidth: clamped });
        },
        toggleTabsBarCollapsed: () =>
          set((s) => ({ tabsBarCollapsed: !s.tabsBarCollapsed })),
        openNewDiagramTab: () => {
          const s = get();
          const newTabId = newId('tab');
          // Snapshot the currently-active tab into tabSnapshots so it can
          // be restored when the user switches back.
          const nextSnapshots = {
            ...s.tabSnapshots,
            [s.activeTabId]: {
              diagram: s.diagram,
              filePath: s.filePath,
              dirty: s.dirty,
            },
          };
          // Park the outgoing tab's per-tab history alongside its
          // snapshot - switching back later restores it intact.
          const nextHistories = {
            ...s.tabHistories,
            [s.activeTabId]: { past: s.past, future: s.future },
          };
          _resetLiveTracking();
          set({
            diagramTabs: [...s.diagramTabs, { id: newTabId }],
            activeTabId: newTabId,
            tabSnapshots: nextSnapshots,
            tabHistories: nextHistories,
            // Reset to a fresh empty diagram for the new tab.
            diagram: { ...EMPTY_DIAGRAM, shapes: [], connectors: [], annotations: [] },
            filePath: s.filePath,
            dirty: false,
            lastSavedAt: s.lastSavedAt,
            past: [],
            future: [],
            selectedIds: [],
            focusedGroupId: null,
            zoom: 1,
            pan: { x: 0, y: 0 },
          });
        },
        duplicateDiagramTab: (id: string) => {
          const s = get();
          const idx = s.diagramTabs.findIndex((t) => t.id === id);
          if (idx < 0) return;
          // Pull the source diagram off the canonical slot if the source IS
          // the active tab; otherwise from its snapshot. Either way, deep-
          // clone so the new tab can't share refs with the source.
          const sourceDiagram =
            id === s.activeTabId ? s.diagram : s.tabSnapshots[id]?.diagram;
          if (!sourceDiagram) return;
          const sourceTitle = sourceDiagram.meta.title ?? 'untitled';
          const cloned = structuredClone(sourceDiagram);
          // Title gets a "Copy of" prefix so the user can spot it in the
          // strip without renaming first. Rename via dbl-click commits a
          // cleaner label whenever they want.
          cloned.meta = {
            ...cloned.meta,
            title: `Copy of ${sourceTitle}`,
          };
          const newTabId = newId('tab');
          // Snapshot the currently-active tab so the duplicate's
          // activation doesn't lose unsaved edits on the active tab.
          const nextSnapshots = {
            ...s.tabSnapshots,
            [s.activeTabId]: {
              diagram: s.diagram,
              filePath: s.filePath,
              dirty: s.dirty,
            },
          };
          // Park outgoing tab's per-tab history (mirror of openNewDiagramTab).
          const nextHistories = {
            ...s.tabHistories,
            [s.activeTabId]: { past: s.past, future: s.future },
          };
          // Insert the clone immediately after the source in tab order.
          const nextTabs = [
            ...s.diagramTabs.slice(0, idx + 1),
            { id: newTabId },
            ...s.diagramTabs.slice(idx + 1),
          ];
          _resetLiveTracking();
          set({
            diagramTabs: nextTabs,
            activeTabId: newTabId,
            tabSnapshots: nextSnapshots,
            tabHistories: nextHistories,
            diagram: cloned,
            filePath: s.filePath,
            // Mark dirty: a fresh-but-unsaved copy is a candidate for
            // Save, just like a brand-new tab with shapes drawn into it.
            dirty: true,
            lastSavedAt: s.lastSavedAt,
            past: [],
            future: [],
            selectedIds: [],
            focusedGroupId: null,
            zoom: 1,
            pan: { x: 0, y: 0 },
          });
        },
        switchDiagramTab: (id: string, temporary = false) => {
          _sealPending();
          const s = get();
          if (id === s.activeTabId) {
            if (!temporary && s.exportReturnTabId) set({ exportReturnTabId: null });
            return;
          }
          const target = s.tabSnapshots[id];
          if (!target) return; // Unknown tab - no-op.
          // Save current → snapshot for the OLD tab.
          const nextSnapshots = {
            ...s.tabSnapshots,
            [s.activeTabId]: {
              diagram: s.diagram,
              filePath: s.filePath,
              dirty: s.dirty,
            },
          };
          // Drop the snapshot we're about to load - it's now the active
          // tab and is in s.diagram instead.
          delete nextSnapshots[id];
          // Same swap for per-tab undo stacks: the outgoing tab's
          // past/future moves into tabHistories[outgoing], the incoming
          // tab's history comes out and becomes root past/future.
          const nextHistories = {
            ...s.tabHistories,
            [s.activeTabId]: { past: s.past, future: s.future },
          };
          const targetHistory = nextHistories[id];
          delete nextHistories[id];
          // Tab-scoped live-drag tracking reset: an in-flight drag on
          // the outgoing tab shouldn't leak its pre-state into the new
          // tab's first mutation. (Belt-and-braces: pointer events
          // would normally hold the gesture open until pointerup, so
          // mid-gesture switches are not an actual flow.)
          _resetLiveTracking();
          set({
            exportReturnTabId: temporary ? s.exportReturnTabId : null,
            activeTabId: id,
            tabSnapshots: nextSnapshots,
            tabHistories: nextHistories,
            diagram: target.diagram,
            filePath: target.filePath,
            dirty: target.dirty,
            past: targetHistory?.past ?? [],
            future: targetHistory?.future ?? [],
            selectedIds: [],
            focusedGroupId: null,
            // Don't reset zoom/pan - keep the user's viewport so switching
            // to a tab they were just viewing doesn't yank them around.
          });
        },
        closeDiagramTab: (id: string) => {
          const s = get();
          // Last tab is non-closable - we always need at least one active
          // tab so the editor has a diagram to render. UI hides the close
          // affordance when there's only one tab; this guard is belt-and-
          // braces for unexpected callers.
          if (s.diagramTabs.length <= 1) return;
          const idx = s.diagramTabs.findIndex((t) => t.id === id);
          if (idx < 0) return;

          // Build the pre-close snapshot for undo. Restoring this lands
          // the user at the precise moment of close, regardless of which
          // tab they closed. Includes the active tab's past/future + the
          // background tabs' histories so undo restores per-tab undo
          // stacks too - without these fields, undo would land back on
          // the closed tab but with whichever tab's stacks happened to
          // be on root at undo time.
          const undoEntry: HistoryEntry = {
            kind: 'tabs',
            diagram: s.diagram,
            filePath: s.filePath,
            dirty: s.dirty,
            diagramTabs: s.diagramTabs.slice(),
            activeTabId: s.activeTabId,
            tabSnapshots: { ...s.tabSnapshots },
            past: s.past,
            future: s.future,
            tabHistories: { ...s.tabHistories },
          };

          const remaining = s.diagramTabs.filter((t) => t.id !== id);
          if (id !== s.activeTabId) {
            // Closing a background tab - active tab unchanged. Append the
            // undo entry to the active tab's existing past so Cmd+Z first
            // restores the closed tab, then continues with prior diagram
            // edits if the user keeps pressing.
            const nextSnapshots = { ...s.tabSnapshots };
            delete nextSnapshots[id];
            // Drop the closed tab's history - restored from undoEntry on undo.
            const nextHistories = { ...s.tabHistories };
            delete nextHistories[id];
            const nextPast =
              s.past.length >= HISTORY_LIMIT ? s.past.slice(1) : s.past.slice();
            nextPast.push(undoEntry);
            set({
              diagramTabs: remaining,
              tabSnapshots: nextSnapshots,
              tabHistories: nextHistories,
              past: nextPast,
              future: [],
            });
            return;
          }
          // Closing the active tab - pick the neighbour to the left (or
          // right if we were at index 0) and load its snapshot. The
          // neighbour's per-tab history (parked in tabHistories at
          // switch time) carries over into root past, with the close
          // undo entry appended so Cmd+Z first reverses the close and
          // then keeps walking the neighbour's prior history.
          const neighbourIdx = idx === 0 ? 0 : idx - 1;
          const neighbour = remaining[neighbourIdx];
          const target = s.tabSnapshots[neighbour.id];
          if (!target) {
            reportRecoveryError(new Error('The neighbouring tab has no recovery data. Close that missing tab or open your last saved file.'));
            return;
          }
          const targetHistory = s.tabHistories[neighbour.id];
          const nextSnapshots = { ...s.tabSnapshots };
          delete nextSnapshots[neighbour.id];
          const nextHistories = { ...s.tabHistories };
          delete nextHistories[neighbour.id];
          const neighbourPast = targetHistory?.past ?? [];
          const trimmedPast =
            neighbourPast.length >= HISTORY_LIMIT
              ? neighbourPast.slice(1)
              : neighbourPast.slice();
          trimmedPast.push(undoEntry);
          // Diagram is being swapped wholesale - drop any uncommitted
          // live-drag tracking that referred to the closing tab.
          _resetLiveTracking();
          set({
            diagramTabs: remaining,
            activeTabId: neighbour.id,
            tabSnapshots: nextSnapshots,
            tabHistories: nextHistories,
            diagram: target.diagram,
            filePath: target.filePath,
            dirty: target.dirty,
            past: trimmedPast,
            // Close clears the neighbour's redo stack - the close itself is
            // a new "action" that invalidates redo, matching the standard
            // linear undo/redo model.
            future: [],
            selectedIds: [],
            focusedGroupId: null,
          });
        },
        setTitle: (t: string) => {
          const next = t || 'untitled';
          // Same no-op rule as the shape setters: re-committing the title
          // the document already has records nothing.
          if (get().diagram.meta.title === next) return;
          _snapshot();
          set((s) => ({
            diagram: {
              ...s.diagram,
              meta: { ...s.diagram.meta, title: next },
            },
            dirty: true,
          }));
        },

        // hotkey rebind
        bindHotkey: (key, def) =>
          set((s) => ({
            hotkeyBindings: { ...s.hotkeyBindings, [key]: def },
          })),
        resetBindings: () => set({ hotkeyBindings: DEFAULT_BINDINGS }),

        // canvas appearance
        setCanvasPaper: (c) => set({ canvasPaper: c }),
        setShowDots: (v) => set({ showDots: v }),
        setShowGrid: (v) => set({ showGrid: v }),
        setShowMeasurements: (v) => set({ showMeasurements: v }),
        setExportPrefs: (p) =>
          set((s) => ({
            exportPrefs: sanitizeExportPrefs({ ...s.exportPrefs, ...p }),
          })),

        setTipsEnabled: (v) =>
          // Flipping the master switch off also clears whatever's currently
          // showing - otherwise a toast that was visible at toggle time
          // would freeze on screen until the next interaction.
          set({ tipsEnabled: v, activeTipKey: v ? get().activeTipKey : null }),
        setActiveTipKey: (k) => set({ activeTipKey: k }),

        setSmartAnchorsGlobal: (v) => set({ smartAnchorsGlobal: v }),
        setSmartAnchorCountGlobal: (n) => {
          // Clamp to the same [4, 64] band the per-shape control enforces.
          const clamped = Math.max(4, Math.min(64, Math.floor(n)));
          set({ smartAnchorCountGlobal: Number.isFinite(clamped) ? clamped : 8 });
        },

        // The master writes both halves; each half re-derives the master, so
        // `snapEnabled` can never disagree with them.
        setSnapEnabled: (v) =>
          set({ snapEnabled: v, shapeSnapEnabled: v, gridSnapEnabled: v }),
        toggleSnapEnabled: () =>
          set((s) => ({
            snapEnabled: !s.snapEnabled,
            shapeSnapEnabled: !s.snapEnabled,
            gridSnapEnabled: !s.snapEnabled,
          })),
        setShapeSnapEnabled: (v) =>
          set((s) => ({
            shapeSnapEnabled: v,
            snapEnabled: v || s.gridSnapEnabled,
          })),
        setGridSnapEnabled: (v) =>
          set((s) => ({
            gridSnapEnabled: v,
            snapEnabled: s.shapeSnapEnabled || v,
          })),

        setHasCompletedOnboarding: (v) => set({ hasCompletedOnboarding: v }),

        // pen settings
        setPenColor: (c) => set({ penColor: c }),
        setPenWidth: (w) => set({ penWidth: w }),

        // sticky last-used styles
        setLastStyles: (patch) =>
          set((s) => ({ lastStyles: { ...s.lastStyles, ...patch } })),
        setLastConnectorStyle: (patch) =>
          set((s) => ({
            lastConnectorStyle: { ...s.lastConnectorStyle, ...patch },
          })),
        resetStyleDefaults: () =>
          set({ lastStyles: {}, lastConnectorStyle: {} }),

        // containers
        // Wrap a single non-basic shape in a container frame. The shape stays
        // anchored at the top-left of the container; the container extends
        // right + down so the user has space to drop additional members in.
        // Containers behave like groups for drag (children come along) but
        // resize differently - see the resize handler in Canvas which scales
        // group children but leaves container children pinned.
        makeContainer: (id) => {
          const sh = get().diagram.shapes.find((s) => s.id === id);
          if (!sh || sh.rackUnit) return;
          // Already containerised - no-op.
          if (sh.parent) {
            const parent = get().diagram.shapes.find((p) => p.id === sh.parent);
            if (parent?.kind === 'container') return;
          }
          // Containers are about identifying a region, not displaying a giant
          // glyph. Shrink the anchor child to a small default - 40px square
          // for icon/image (square assets), 56px-tall for service tiles
          // (which carry a 3-letter glyph that needs reading room). Other
          // kinds keep their existing dims.
          const ANCHOR_ICON_SIZE = 40;
          const ANCHOR_SERVICE_W = 96;
          const ANCHOR_SERVICE_H = 56;
          const isIconish = sh.kind === 'icon' || sh.kind === 'image';
          const isService = sh.kind === 'service';
          const childW = isIconish
            ? ANCHOR_ICON_SIZE
            : isService
              ? ANCHOR_SERVICE_W
              : sh.w;
          const childH = isIconish
            ? ANCHOR_ICON_SIZE
            : isService
              ? ANCHOR_SERVICE_H
              : sh.h;
          // Padding so the anchor child doesn't sit flush against the frame's
          // top-left edge. Subtle (12px) - enough to read as breathing room
          // without making tiny containers feel sparse.
          const PAD = 12;
          // Frame leaves room for a label to the right of the child + a
          // drop area below. Min dims keep the frame readable for tiny
          // anchor shapes.
          const frameW = Math.max(childW + 200, 260);
          const frameH = Math.max(childH + 120, 160);
          const containerId = newId('container');
          // Stamp the new container at the top of the z stack. Its members
          // (the anchor child, plus any later adoptees) are kept above the
          // container by Canvas.tsx's effective-z floor, so a high container
          // z doesn't paint over the children - it only positions the
          // container relative to non-members.
          const containerZ = nextZ(get());
          const container: Shape = {
            id: containerId,
            kind: 'container',
            // Shift the frame up + left by PAD so the anchor child stays put
            // (selecting + tweaking the icon doesn't surprise the user) but
            // gains visible padding inside the container.
            x: sh.x - PAD,
            y: sh.y - PAD,
            w: frameW,
            h: frameH,
            label: '',
            layer: sh.layer,
            z: containerZ,
            // Pin the label to THIS shape - the original wrapped child.
            // Subsequent drop-ins are siblings; without this pin, label
            // positioning re-picks by array order and shifts with adoption.
            anchorId: sh.id,
          };
          _snapshot();
          set((s) => ({
            diagram: {
              ...s.diagram,
              // Insert container BEFORE the anchor so it renders behind it.
              // Group-frame ordering (Canvas renders kind: 'group' first) is
              // separate; containers sit in normal z order.
              shapes: [
                container,
                ...s.diagram.shapes.map((x) =>
                  x.id === sh.id
                    ? { ...x, parent: containerId, w: childW, h: childH }
                    : x,
                ),
              ],
            },
            dirty: true,
            selectedIds: [containerId],
          }));
        },

        encapsulateSelection: (frame) => {
          const st = get();
          // Only icon-kind shapes in the current selection. A mixed
          // marquee (icons + a rectangle, say) just frames the icons and
          // leaves the rest untouched - same forgiving contract as the
          // style actions.
          const targetIds = new Set(
            st.selectedIds.filter(
              (sid) =>
                st.diagram.shapes.find((s) => s.id === sid)?.kind === 'icon',
            ),
          );
          if (targetIds.size === 0) return;
          _snapshot();
          set((s) => ({
            diagram: {
              ...s.diagram,
              shapes: s.diagram.shapes.map((x) => {
                if (!targetIds.has(x.id) || x.kind !== 'icon') return x;
                if (frame === null) {
                  // Strip back to a bare icon. The (squared) bbox is left
                  // as-is on purpose: the icon simply fills the square it
                  // had - re-deriving the pre-encapsulation size would
                  // mean stashing it somewhere, and a predictable
                  // in-place unwrap is less surprising than a size jump.
                  return { ...x, frame: undefined };
                }
                // Each icon is framed INDEPENDENTLY around its own centre
                // - many selected icons → many separate framed shapes
                // (this is the per-shape encapsulate, never a shared
                // group). Square the bbox so the circle/square is regular
                // (rx == ry, w == h) and connectors anchor to a clean
                // outline. Match the icon's EXISTING footprint (its
                // larger side) - do NOT grow it; the renderer insets the
                // glyph to ~0.6·S so the on-canvas size is unchanged (a
                // square icon's bbox is untouched entirely).
                const cx = x.x + x.w / 2;
                const cy = x.y + x.h / 2;
                const side = Math.round(Math.max(x.w, x.h));
                return {
                  ...x,
                  frame,
                  x: Math.round(cx - side / 2),
                  y: Math.round(cy - side / 2),
                  w: side,
                  h: side,
                };
              }),
            },
            dirty: true,
            // Selection preserved (don't collapse a multi-select to one) -
            // the user keeps every icon they framed selected.
          }));
        },

        adoptIntoContainer: (id) => {
          const sh = get().diagram.shapes.find((s) => s.id === id);
          if (!sh || sh.rackUnit) return;
          const all = get().diagram.shapes;
          if (sh.notation?.type === 'bpmn-boundary' && isBpmnActivity(all.find(s => s.id === sh.parent))) return;
          // Group membership is sticky - selecting a group child has its own
          // contract (the group drags together). Don't auto-release
          // group members as containers do. This guard fires for *children*
          // of a group; the group itself is allowed to enter a container
          // (parenting is the same `parent` field for both kinds, and the
          // drag/resize code walks the parent chain transitively).
          if (sh.parent) {
            const currentParent = all.find((p) => p.id === sh.parent);
            if (currentParent?.kind === 'group') return;
          }
          // Containment rule (Vellum bug list 13): a shape is "in" a
          // container only if more than half of its bbox area overlaps the
          // container. Centre-point was too eager - a long rectangle that
          // mostly stuck out got swallowed because its midpoint happened to
          // fall inside.
          const shArea = Math.max(0, Math.abs(sh.w)) * Math.max(0, Math.abs(sh.h));
          if (shArea === 0) return;
          // Forbid container-into-self / descendant cycle - a container can
          // be adopted by an ANCESTOR container but never by a child.
          const byId = shapeIndex(all);
          const overlapFrac = (c: Shape) => {
            const ix1 = Math.max(sh.x, c.x);
            const iy1 = Math.max(sh.y, c.y);
            const ix2 = Math.min(sh.x + sh.w, c.x + c.w);
            const iy2 = Math.min(sh.y + sh.h, c.y + c.h);
            const iw = Math.max(0, ix2 - ix1);
            const ih = Math.max(0, iy2 - iy1);
            return (iw * ih) / shArea;
          };
          // Layer rule (shared with connector parenting): only containers
          // the user can SEE under the active pill can capture a shape -
          // dropping a Notes shape over a hidden Blueprint frame used to
          // parent it silently, so the invisible frame later dragged,
          // copied and deleted it. The shape's CURRENT parent stays a
          // candidate even when hidden: you can stay where you are, you
          // can only move into what you can see.
          const layerMode = get().layerMode;
          const eff = effectiveZMap(all, get().diagram.connectors);
          const candidates = all
            .filter((c) => c.kind === 'container' && c.id !== id)
            .filter(
              (c) => shapeVisibleInMode(c, layerMode) || c.id === sh.parent,
            )
            // Don't adopt a frame (container or group) into one of its own
            // descendants - that would create a parent-chain cycle. Plain
            // shapes have no descendants so the check is a cheap no-op for
            // them, but we run it unconditionally to keep the rule simple.
            .filter((c) => !isDescendantOf(c.id, id, byId))
            .map((c) => ({ c, frac: overlapFrac(c) }))
            .filter(({ frac }) => frac > 0.5)
            // Walk in reverse EFFECTIVE z order - the front-most qualifying
            // container wins so dropping into a nested container picks the
            // inner one (whose effective z is always above its parent's,
            // whatever the raw values say).
            .sort((a, b) => (eff.get(b.c.id) ?? 0) - (eff.get(a.c.id) ?? 0));
          const target = candidates[0]?.c;
          // Re-evaluate parent unconditionally on every drop. Three outcomes:
          //   1. New target found → adopt (set parent, possibly re-parent
          //      from container A to container B).
          //   2. No target AND current parent is a container → release
          //      (drag-out unbinds, the bug fix).
          //   3. No change needed → bail without writing.
          // `target?.id` of undefined means "no parent" (clean release).
          const nextParent = target?.id;
          if (nextParent === sh.parent) return;
          set((s) => ({
            diagram: {
              ...s.diagram,
              shapes: s.diagram.shapes.map((x) =>
                x.id === id ? { ...x, parent: nextParent } : x,
              ),
            },
            dirty: true,
          }));
        },

        // recent activity
        recentShapes: [],
        recordRecent: (entry) =>
          set((s) => {
            // Dedup by key - the most recent occurrence wins and floats to the
            // top. Without dedup the list would degenerate into N copies of
            // the user's favourite shape after a few uses.
            const filtered = s.recentShapes.filter((r) => r.key !== entry.key);
            return {
              recentShapes: [entry, ...filtered].slice(0, RECENT_LIMIT),
            };
          }),
        clearRecent: () => set({ recentShapes: [] }),

        // personal library
        personalLibrary: [],
        addToLibrary: (label, ids) => {
          const fragment = captureFragment(get().diagram, new Set(ids), detachUnselectedEndpoints);
          if (!fragment.shapes.length && !fragment.connectors.length) return;
          const box = fragmentBounds(fragment);
          const normalized = remapFragment(fragment, -(box?.x ?? 0), -(box?.y ?? 0));
          // Glyph: first three chars of the label, uppercased.
          const glyph = label.slice(0, 3).toUpperCase() || 'SHP';
          set((s) => ({
            personalLibrary: [
              ...s.personalLibrary,
              { label, glyph, ...normalized },
            ],
          }));
        },
        removeFromLibrary: (index) =>
          set((s) => ({
            personalLibrary: s.personalLibrary.filter((_, i) => i !== index),
          })),

        // pinned icon packs - toggle moves a vendor key in/out of the front of
        // the list. Front-of-list (rather than append) so a freshly pinned
        // pack jumps to the top, which is what "pin" implies.
        pinnedIconPacks: [],
        togglePinnedIconPack: (vendorKey) =>
          set((s) => {
            const idx = s.pinnedIconPacks.indexOf(vendorKey);
            if (idx >= 0) {
              return {
                pinnedIconPacks: s.pinnedIconPacks.filter((_, i) => i !== idx),
              };
            }
            return { pinnedIconPacks: [vendorKey, ...s.pinnedIconPacks] };
          }),

        // embed - Blueprintr overlay slots. Wired by embedBridge in
        // response to host postMessages; read by EmbedView's effects.
        readOnly: false,
        setReadOnly: (v) => set({ readOnly: v }),
        highlightedShapeIds: [],
        setHighlightedShapeIds: (ids) => set({ highlightedShapeIds: ids }),
        activeHighlightedShapeId: null,
        setActiveHighlightedShapeId: (id) =>
          set({ activeHighlightedShapeId: id }),
        revealTick: 0,
        triggerReveal: () => set((s) => ({ revealTick: s.revealTick + 1 })),
      };
    },
    {
      name: 'vellum.editor',
      storage: recoveryStorage as PersistStorage<Partial<PersistedSlice>>,
      // merge validates every recovered document, regardless of storage version.
      // Invalid recovery data stays untouched so a later read can recover it.
      version: 1,
      onRehydrateStorage: (state) => {
        const started = {
          workspaceId: state.workspaceId, workspaceRevision: state.workspaceRevision,
          diagram: state.diagram, diagramTabs: state.diagramTabs, tabSnapshots: state.tabSnapshots,
        };
        hydrationStart = started;
        return () => {
          if (hydrationStart === started) hydrationStart = undefined;
          // Writes are held while recovery is read, so save the settled state once.
          queueMicrotask(() => useEditor.setState({}));
        };
      },
      partialize: (state): PersistedSlice => {
        // Store the user's original active tab while export renders another tab.
        // Use live diagram references so concurrent edits still reach recovery.
        let s = state;
        const original = state.exportReturnTabId && state.tabSnapshots[state.exportReturnTabId];
        if (original && state.activeTabId !== state.exportReturnTabId) {
          const tabSnapshots = { ...state.tabSnapshots,
            [state.activeTabId]: { diagram: state.diagram, filePath: state.filePath, dirty: state.dirty },
          };
          delete tabSnapshots[state.exportReturnTabId!];
          s = { ...state, ...original, activeTabId: state.exportReturnTabId!, tabSnapshots };
        }
        return ({
        hotkeyBindings: s.hotkeyBindings,
        theme: s.theme,
        uiTextScale: s.uiTextScale,
        personalLibrary: s.personalLibrary,
        canvasPaper: s.canvasPaper,
        showDots: s.showDots,
        showGrid: s.showGrid,
        showMeasurements: s.showMeasurements,
        exportPrefs: s.exportPrefs,
        libraryPanelOpen: s.libraryPanelOpen,
        lastStyles: s.lastStyles,
        lastConnectorStyle: s.lastConnectorStyle,
        recentShapes: s.recentShapes,
        diagram: s.diagram,
        dirty: s.dirty,
        workspaceRevision: s.workspaceRevision,
        savedRevision: s.savedRevision,
        filePath: s.filePath,
        inspectorOpen: s.inspectorOpen,
        collapsedInspectorSections: s.collapsedInspectorSections,
        tipsEnabled: s.tipsEnabled,
        smartAnchorsGlobal: s.smartAnchorsGlobal,
        smartAnchorCountGlobal: s.smartAnchorCountGlobal,
        shapeSnapEnabled: s.shapeSnapEnabled,
        gridSnapEnabled: s.gridSnapEnabled,
        snapEnabled: s.snapEnabled,
        hasCompletedOnboarding: s.hasCompletedOnboarding,
        pinnedIconPacks: s.pinnedIconPacks,
        diagramTabs: s.diagramTabs,
        activeTabId: s.activeTabId,
        tabSnapshots: s.tabSnapshots,
        tabsBarHeight: s.tabsBarHeight,
        rightDockOpen: s.rightDockOpen,
        rightDockWidth: s.rightDockWidth,
        tabsBarCollapsed: s.tabsBarCollapsed,
      });
      },
      // Validation runs in merge for both legacy and current storage versions.
      migrate: (persisted) => (persisted ?? {}) as Partial<PersistedSlice>,
      // Bindings are no longer user-rebindable, so we ignore any stored
      // hotkeyBindings and always boot with the current DEFAULT_BINDINGS.
      // This prevents legacy persisted slots (e.g. user-bound 8/9 from when
      // those were rebindable, or the old `b` pen binding) from polluting
      // the new fixed layout.
      //
      // Wrapped in try/catch as a defense-in-depth backstop: if `migrate`
      // somehow lets through a payload the type system doesn't expect, the
      // spread can throw on getter properties. Fall back to defaults rather
      // than crash the editor on boot.
      merge: (persisted, current) => {
        // Embedding hosts can load or edit a document before IndexedDB returns,
        // including through useEditor.setState, which does not advance the
        // revision. Keep that newer document, but still restore preferences and
        // the personal library: persist writes the merged state back, so
        // dropping them here would replace the saved copies with defaults.
        const start = hydrationStart;
        if (start && (current.workspaceId !== start.workspaceId ||
          current.workspaceRevision !== start.workspaceRevision ||
          current.diagram !== start.diagram || current.diagramTabs !== start.diagramTabs ||
          current.tabSnapshots !== start.tabSnapshots)) {
          persisted = Object.fromEntries(Object.entries((persisted ?? {}) as object)
            .filter(([key]) => !RECOVERED_DOCUMENT_FIELDS.has(key)));
        }
        try {
          const p = (persisted ?? {}) as Partial<PersistedSlice>;
          if (p.diagram) {
            p.diagram = parseDiagram(p.diagram);
            p.dirty ??= true;
          }
          if (p.personalLibrary) p.personalLibrary = p.personalLibrary.map((entry) => ({ ...entry, ...parseClipboardEnvelope(entry) }));
          if (p.tabSnapshots) p.tabSnapshots = Object.fromEntries(Object.entries(p.tabSnapshots).map(([id, snap]) => [id, { ...snap, diagram: parseDiagram(snap.diagram) }]));
          const missing = p.diagramTabs?.filter((tab) => tab.id !== p.activeTabId && !p.tabSnapshots?.[tab.id]);
          if (missing?.length) {
            recoveryStorage.protect();
            reportRecoveryError(new Error(`${missing.length} tabs are missing recovery data. Open the last saved .vellum file before replacing it.`));
          }
          // Legacy preferences have one snapEnabled flag. Seed missing
          // shape/grid flags from it and derive the master from both flags.
          // This also handles older preference fields at the current
          // persistence version.
          const shapeSnapEnabled =
            p.shapeSnapEnabled ?? p.snapEnabled ?? current.shapeSnapEnabled;
          const gridSnapEnabled =
            p.gridSnapEnabled ?? p.snapEnabled ?? current.gridSnapEnabled;
          const merged: typeof current = {
            ...current,
            ...p,
            shapeSnapEnabled,
            gridSnapEnabled,
            snapEnabled: shapeSnapEnabled || gridSnapEnabled,
            // Feeds a CSS multiplier, so only an offered step gets through.
            uiTextScale: sanitizeTextScale(p.uiTextScale ?? current.uiTextScale),
            hotkeyBindings: DEFAULT_BINDINGS,
            // Re-validate + backfill: a persisted prefs object from an
            // older build may lack newer keys or carry an out-of-range
            // scale; never let it replace the defaults wholesale.
            exportPrefs: sanitizeExportPrefs({
              ...DEFAULT_EXPORT_PREFS,
              ...(p.exportPrefs ?? {}),
            }),
          };
          return merged;
        } catch (err) {
          if (typeof console !== 'undefined') {
            console.warn(
              '[vellum] persisted state failed to merge:',
              err,
            );
          }
          recoveryStorage.protect();
          reportRecoveryError(err);
          return { ...current, hotkeyBindings: DEFAULT_BINDINGS };
        }
      },
    },
  ),
);

/** Selectors - keep tight, the canvas re-renders on every diagram change.
 *
 *  selectVisibleShapes used to be a bare `s.diagram.shapes.filter(...)`
 * - a new array reference on every store tick, re-rendering every
 *  Zustand consumer that subscribed to it even when nothing changed.
 *  The cache below pins the result to the (shapes, layerMode) pair so
 *  identical inputs return the identical array reference.
 *
 *  Key insight: in the common case `layerMode === 'both'` the filter is
 *  the identity transform - we can short-circuit and return the live
 *  `shapes` array, which Zustand already memoises across ticks that
 *  don't touch it. The layer-specific branches use a WeakMap so a
 *  re-filter only happens when the underlying shapes array changes. */
type LayerCache = { notes?: Shape[]; blueprint?: Shape[] };
const _visibleShapesCache = new WeakMap<readonly Shape[], LayerCache>();
export const selectVisibleShapes = (s: EditorState): Shape[] => {
  const shapes = s.diagram.shapes;
  if (s.layerMode === 'both') return shapes as Shape[];
  let entry = _visibleShapesCache.get(shapes);
  if (!entry) {
    entry = {};
    _visibleShapesCache.set(shapes, entry);
  }
  const key = s.layerMode;
  if (!entry[key]) {
    entry[key] = shapes.filter((sh) => sh.layer === key);
  }
  return entry[key]!;
};

/** Factory for newly-created shapes from the toolbar. Centralised here so the
 *  default geometry / layer is one place to change.
 *
 *  Style inheritance: pulls `lastStyles` off the store and applies whichever
 *  fields are set so new shapes inherit the user's most-recent style choices
 *  (fill, stroke, font, line width, text colour). Notes are exempt - the
 *  sticky-note look depends on its baked-in palette and a user-picked stroke
 *  override would clash with that. */
export function defaultShapeFromTool(
  toolKey: ToolKey,
  toolName: string,
  x: number,
  y: number,
  w: number,
  h: number,
  glyph?: string,
  label?: string,
): Shape | null {
  const seed = Math.floor(Math.random() * 1e6);
  const id = newId(toolName);

  const kindMap: Record<string, ShapeKind> = {
    rect: 'rect',
    ellipse: 'ellipse',
    diamond: 'diamond',
    text: 'text',
    note: 'note',
  };

  // The toolbar's layer toggle drives where new shapes land - never the
  // visibility pill, which can sit on `both`.
  const defaultLayer: Layer = useEditor.getState().activeLayer;

  // Pull sticky styles. Notes intentionally skip these.
  const ls = useEditor.getState().lastStyles;
  const stickyStyles = (kind: ShapeKind): Partial<Shape> => {
    if (kind === 'note') return {};
    const out: Partial<Shape> = {};
    if (ls.fill !== undefined) out.fill = ls.fill;
    if (ls.stroke !== undefined) out.stroke = ls.stroke;
    if (ls.strokeWidth !== undefined) out.strokeWidth = ls.strokeWidth;
    if (ls.fontFamily !== undefined) out.fontFamily = ls.fontFamily;
    if (ls.fontSize !== undefined) out.fontSize = ls.fontSize;
    if (ls.textColor !== undefined) out.textColor = ls.textColor;
    if (ls.textAlign !== undefined) out.textAlign = ls.textAlign;
    // Corner radius is rect / service / container only at render time; only
    // stamp it on those kinds so an ellipse/diamond doesn't carry a
    // meaningless field.
    if (
      ls.cornerRadius !== undefined &&
      (kind === 'rect' || kind === 'service' || kind === 'container')
    ) {
      out.cornerRadius = ls.cornerRadius;
    }
    // Same "only stamp it where it paints" rule as cornerRadius, delegated to
    // the renderer's own gate so the two can't drift. Spread-copied because a
    // shared object reference would make every shape drawn from one sticky
    // pick mutate together on the next inspector edit.
    if (
      ls.strokeGradient !== undefined &&
      shapeKindSupportsPrismStroke(kind)
    ) {
      out.strokeGradient = { ...ls.strokeGradient };
    }
    return out;
  };

  if (toolName === 'rect' || toolName === 'ellipse' || toolName === 'diamond') {
    return {
      id,
      kind: kindMap[toolName],
      x,
      y,
      w,
      h,
      label: '',
      layer: defaultLayer,
      seed,
      ...stickyStyles(kindMap[toolName]),
    };
  }
  if (toolName === 'container') {
    // Drawing a fresh container with the 8 hotkey - frame with empty
    // anchor. The "add icon" affordance is in the inspector + the
    // canvas-side top-left + button on a hovered/selected container.
    //
    // Containers deliberately don't inherit the full sticky-style set
    // (the dashed-frame identity should win over a leftover stroke /
    // fill choice), but cornerRadius IS a useful sticky default for
    // them - the user wants their preferred frame radius to persist.
    // Only stamp it when the user has actually saved a value.
    const containerSticky: Partial<Shape> = {};
    if (ls.cornerRadius !== undefined) {
      containerSticky.cornerRadius = ls.cornerRadius;
    }
    return {
      id,
      kind: 'container',
      x,
      y,
      w,
      h,
      label: '',
      layer: defaultLayer,
      seed,
      strokeStyle: 'dashed',
      ...containerSticky,
    };
  }
  if (toolName === 'text') {
    return {
      id,
      kind: 'text',
      x,
      y,
      w,
      h,
      label: 'text',
      layer: defaultLayer,
      seed,
      ...stickyStyles('text'),
    };
  }
  if (toolName === 'note') {
    // Note-kind shapes always live in the Notes layer (the sticky-note metaphor).
    return {
      id,
      kind: 'note',
      x,
      y,
      w,
      h,
      label: '',
      layer: 'notes',
      seed,
    };
  }
  if (toolName === 'table') {
    // Default 3×3 grid. Cells start unallocated - render fills them as empty
    // strings, and the file stays compact ("absent cells" beats "rows of empty
    // strings" on disk). Min size guard ensures dragging out a tiny rectangle
    // still produces a readable grid.
    const tableW = Math.max(w, 120);
    const tableH = Math.max(h, 60);
    return {
      id,
      kind: 'table',
      x,
      y,
      w: tableW,
      h: tableH,
      layer: defaultLayer,
      rows: 3,
      cols: 3,
      ...stickyStyles('rect' as ShapeKind),
    };
  }
  // Library / custom-bound tools: drop a service tile with the glyph + label.
  // The toolName is the library shape id (e.g. "lambda", "s3").
  if (glyph || label) {
    return {
      id,
      kind: 'service',
      x,
      y,
      w,
      h,
      label: label ?? '',
      icon: glyph,
      layer: defaultLayer,
      ...stickyStyles('service'),
    };
  }
  void toolKey;
  return null;
}

/** Centralised resolver for whether the current activeTool produces a shape on
 *  pointer drag. Tools 5/6 (arrow, line) draw connectors instead - handled
 *  separately in the canvas interaction module. */
export function toolCreatesShape(toolName: string): boolean {
  return [
    'rect',
    'ellipse',
    'diamond',
    'text',
    'note',
    'container',
    'table',
  ].includes(toolName);
}

export function toolCreatesConnector(toolName: string): boolean {
  return ['arrow', 'line'].includes(toolName);
}
