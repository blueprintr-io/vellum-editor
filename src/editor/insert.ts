import { fragmentBounds, remapFragment } from '@/store/fragments';
import { createRack } from '@/editor/rack/model';
import { RACK_PRESETS, RACK_EQUIPMENT } from '@/editor/rack/catalog';
import { pickShapeAt } from '@/editor/canvas/pick';
import { effectiveZMap } from '@/editor/canvas/z-order';
import { shapeVisibleInMode } from '@/store/layers';
import { isBpmnActivity, hiddenByCollapsedAncestor } from '@/editor/notation/model';
import { notationDefinition, notationShape, RELATIONSHIPS } from '@/editor/notation/catalog';
/* Programmatic shape insertion - extracted from Canvas's drop handlers so
 * the universal launcher (UniversalLauncher.tsx) and the picker tiles'
 * click-to-insert path can drop a shape/icon at the viewport centre without
 * duplicating the same construction logic.
 *
 * The Canvas drop branches still own the cursor-follows-cursor behaviour
 * (drop-at-pointer, drop-target highlighting); these helpers are the shared
 * "construct + add + adopt + record" tail. Keeping them here means a
 * regression in shape construction breaks both paths together - which is
 * the right trade-off when the construction logic is identical.
 *
 * Every helper takes an optional `at` (world-space centre). Without it the
 * shape lands at the viewport centre, nudged down-right in paste-offset
 * steps while that exact spot is already taken - see `placeAt`.
 */

import { useEditor, newId, type PersonalLibraryEntry } from '@/store/editor';
import { shapeKindSupportsPrismStroke } from '@/editor/canvas/prism';
import { screenToWorld } from '@/editor/canvas/projection';
import { BASIC_SHAPES, type BasicShapeInsertSpec } from '@/editor/shapes/catalog';
export type { BasicShapeInsertSpec } from '@/editor/shapes/catalog';
import { parseClipboardEnvelope } from '@/store/schema';
import type { Shape } from '@/store/types';
import type { IconDragPayload } from '@/icons/types';
import { resolveIcon } from '@/icons/resolve';

/** World-space point at the centre of the current viewport. The launcher
 *  and the picker tiles drop shapes here so the user sees them appear in
 *  the visible area without having to scroll/pan. Reads zoom + pan + the
 *  canvas element's size at call time so the answer is always current.
 *
 *  Measures the canvas `<svg>` rather than the window: pan/zoom are
 *  relative to the svg's top-left, and a plugin dock (Blueprintr's right
 *  dock) insets the canvas, so a window-based centre would land off to
 *  the right of what the user actually sees. Falls back to the window
 *  when the canvas isn't mounted (tests, headless). */
export function viewportCentre(): { x: number; y: number } {
  const { pan, zoom } = useEditor.getState();
  if (typeof window === 'undefined') return { x: 0, y: 0 };
  const rect =
    typeof document !== 'undefined'
      ? document.querySelector('[data-vellum-canvas]')?.getBoundingClientRect()
      : undefined;
  const w = rect && rect.width > 0 ? rect.width : window.innerWidth;
  const h = rect && rect.height > 0 ? rect.height : window.innerHeight;
  return screenToWorld({ x: w / 2, y: h / 2 }, { pan, zoom });
}

/** Cascade step (world px) when the target spot already holds a shape with
 *  the same top-left - the same offset paste/duplicate use. */
const CASCADE_STEP = 24;
/** Upper bound on cascade steps so a pathological diagram can't push the
 *  insert off-screen. */
const CASCADE_LIMIT = 12;

/** Top-left for a `w`×`h` shape centred on `centre`, nudged down-right in
 *  paste-offset steps while an existing shape already sits at exactly that
 *  top-left. Clicking the same tile three times would otherwise stack three
 *  identical shapes on one spot, which reads as "nothing happened". Returns
 *  the exact centred spot when it's free. */
export function placeAt(
  centre: { x: number; y: number },
  w: number,
  h: number,
): { x: number; y: number } {
  let x = centre.x - w / 2;
  let y = centre.y - h / 2;
  const shapes = useEditor.getState().diagram.shapes;
  for (let i = 0; i < CASCADE_LIMIT; i++) {
    const taken = shapes.some(
      (s) => Math.abs(s.x - x) < 0.5 && Math.abs(s.y - y) < 0.5,
    );
    if (!taken) break;
    x += CASCADE_STEP;
    y += CASCADE_STEP;
  }
  return { x, y };
}

/** Drop a library shape (the service-tile catalog entry shown in
 *  MoreShapesPopover / LibraryPanel) centred on world-space `at`, defaulting
 *  to the viewport centre. Mirrors Canvas's `application/x-vellum-library`
 *  drop branch so a launcher pick or a tile click is byte-for-byte
 *  equivalent to a drag-and-drop of the same tile. */
export function insertLibraryShape(
  lib: { id: string; label: string; glyph: string; libName: string },
  at?: { x: number; y: number },
): void {
  if (lib.id.startsWith('basic:')) {
    const basic = BASIC_SHAPES.find(s => s.id === lib.id.slice(6));
    if (basic) insertBasicShape(basic, at);
    return;
  }
  const rackPreset = RACK_PRESETS.find(p => p.id === lib.id);
  const equipment = RACK_EQUIPMENT.find(p => p.id === lib.id);
  if (rackPreset || equipment) {
    const editor = useEditor.getState();
    const p = at ?? viewportCentre();
    if (rackPreset) {
      const fragment = createRack(newId('rack'), 0, 0, rackPreset.units, editor.activeLayer);
      const pos = placeAt(p, fragment[0].w, fragment[0].h);
      editor.beginHistoryBatch();
      editor.addShapes(fragment.map(s=>({...s,x:s.x+pos.x,y:s.y+pos.y})));
      editor.adoptIntoContainer(fragment[0].id);
      editor.endHistoryBatch();
      editor.setSelected(fragment[0].id);
      editor.setInspectorOpen(true);
    } else if (equipment) {
      const unit = rackUnitTarget(at);
      if (unit) editor.updateShape(unit.id,{iconSvg:equipment.svg,iconAttribution:undefined,iconConstraints:undefined,label:unit.label===`U${unit.rackUnit!.u}`?equipment.label:unit.label});
      else editor.addShape({id:newId('equipment'),kind:'icon',...placeAt(p,160,24),w:160,h:24,layer:editor.activeLayer,iconSvg:equipment.svg,label:equipment.label});
    }
    editor.recordRecent({key:`library:${lib.id}`,label:lib.label,glyph:lib.glyph,source:{kind:'library',libShapeId:lib.id,libName:lib.libName}});
    return;
  }
  const relationship = RELATIONSHIPS.find(p => p.id === lib.id);
  if (relationship) {
    const editor = useEditor.getState();
    const selected = editor.selectedIds.map(id => editor.diagram.shapes.find(s => s.id === id)).filter((s): s is Shape => !!s);
    const p = at ?? viewportCentre();
    const id = newId('relationship');
    editor.addConnector({id, routing:'straight', layer:editor.activeLayer,
      from:selected.length===2?{shape:selected[0].id,anchor:'auto'}:{x:p.x-80,y:p.y},
      to:selected.length===2?{shape:selected[1].id,anchor:'auto'}:{x:p.x+80,y:p.y},
      ...relationship.patch});
    editor.setSelected(id);
    editor.recordRecent({key:`library:${lib.id}`,label:lib.label,glyph:'→',source:{kind:'library',libShapeId:lib.id,libName:lib.libName}});
    return;
  }
  const native = notationDefinition(lib.id);
  const w = native?.w ?? 130;
  const h = native?.h ?? 64;
  const p = at ?? viewportCentre();
  const { x, y } = placeAt(p, w, h);
  const id = newId(lib.id);
  const editor = useEditor.getState();
  const nativeShape = notationShape(lib.id, id, x, y, editor.activeLayer);
  if (nativeShape?.notation?.type === 'bpmn-boundary') {
    const host = at ? editor.diagram.shapes.filter(isBpmnActivity).filter(s=>p.x>=s.x-24&&p.x<=s.x+s.w+24&&p.y>=s.y-24&&p.y<=s.y+s.h+24).sort((a,b)=>a.w*a.h-b.w*b.h)[0] : editor.diagram.shapes.find(s=>editor.selectedIds.includes(s.id)&&isBpmnActivity(s));
    if (host) { nativeShape.parent=host.id; if (!at) { nativeShape.x=host.x+host.w*.75-w/2; nativeShape.y=host.y+host.h-h/2; } }
  }
  editor.beginHistoryBatch();
  editor.addShape(nativeShape ?? {
    id,
    kind: 'service',
    x,
    y,
    w,
    h,
    label: lib.label,
    icon: lib.glyph,
    // The toolbar's layer toggle decides where new shapes land - a
    // hard-coded Blueprint here dropped an invisible tile while the user
    // was working on Notes (the drag-drop path already followed it).
    layer: editor.activeLayer,
  });
  editor.adoptIntoContainer(id);
  editor.endHistoryBatch();
  editor.recordRecent({
    key: `library:${lib.id}`,
    label: lib.label,
    glyph: lib.glyph,
    source: { kind: 'library', libShapeId: lib.id, libName: lib.libName },
  });
  editor.setSelected(id);
}

/** Drop a vendor icon centred on world-space `at`. Async because vendor
 *  packs are lazy-loaded. Mirrors Canvas's `application/x-vellum-icon` drop
 *  branch end-to-end. Throws on resolve failure - caller decides whether
 *  to toast or silently swallow. The placement is read AFTER the await so
 *  a pan that happens while the pack loads still lands the icon in view. */
export async function insertIconShape(
  payload: IconDragPayload,
  at?: { x: number; y: number },
): Promise<void> {
  const native = payload.vendor === 'flowchart' ? notationDefinition(payload.iconId.replace('flowchart/', 'flow-')) : undefined;
  if (native) { insertLibraryShape({id:native.id,label:native.label,glyph:'',libName:'Flowchart'}, at); return; }
  const targetId = rackUnitTarget(at)?.id;
  const resolved = await resolveIcon(payload);
  if (targetId) {
    const editor = useEditor.getState();
    const unit = editor.diagram.shapes.find(s=>s.id===targetId && s.rackUnit);
    if (!unit) return;
    editor.updateShape(unit.id,{iconSvg:resolved.svg,iconAttribution:resolved.attribution,iconConstraints:resolved.constraints});
    editor.setSelected(unit.id);
    return;
  }
  const { w, h } = resolved.defaultSize;
  const p = at ?? viewportCentre();
  const { x, y } = placeAt(p, w, h);
  const id = newId('icon');
  const editor = useEditor.getState();
  editor.addShape({
    id,
    kind: 'icon',
    x,
    y,
    w,
    h,
    layer: editor.activeLayer,
    iconSvg: resolved.svg,
    iconAttribution: resolved.attribution,
    iconConstraints: resolved.constraints,
  });
  editor.adoptIntoContainer(id);
  const tail = payload.iconId.split('/').pop() ?? payload.iconId;
  editor.recordRecent({
    key: `vendor:${payload.iconId}`,
    label: tail,
    glyph: tail.slice(0, 3).toUpperCase(),
    source: { kind: 'vendor', iconId: payload.iconId, vendor: payload.vendor },
  });
  editor.setSelected(id);
}

/** Drop a bare shape kind at the viewport centre. Used by launcher
 *  commands like "insert sticky note" / "insert table" that bypass the
 *  drag-out tool gesture. Subset of `defaultShapeFromTool` - only the
 *  kinds that make sense to drop at a fixed size. */
export function insertBareShape(
  kind: Extract<Shape['kind'], 'rect' | 'ellipse' | 'diamond' | 'note' | 'text' | 'table' | 'container'>,
  at?: { x: number; y: number },
): void {
  const p = at ?? viewportCentre();
  const editor = useEditor.getState();
  // Conservative defaults - caller can resize after.
  const dims: Record<string, { w: number; h: number }> = {
    rect: { w: 140, h: 80 },
    ellipse: { w: 140, h: 80 },
    diamond: { w: 120, h: 80 },
    note: { w: 160, h: 120 },
    text: { w: 120, h: 28 },
    table: { w: 240, h: 120 },
    container: { w: 280, h: 200 },
  };
  const { w, h } = dims[kind];
  const { x, y } = placeAt(p, w, h);
  const id = newId(kind);
  // Tables need a default cells matrix; note shapes get a seed for the
  // sketchy treatment. Both are picked up by Shape.tsx's renderer.
  const extras: Partial<Shape> = {};
  if (kind === 'table') {
    extras.rows = 3;
    extras.cols = 3;
    extras.cells = [];
  } else if (kind === 'note') {
    extras.seed = Math.floor(Math.random() * 0xffff);
    extras.layer = 'notes';
  }
  // Sticky styles - same lastStyles slice that defaultShapeFromTool uses.
  // Notes opt out (sticky-note look depends on its baked-in palette).
  const ls = editor.lastStyles;
  const sticky: Partial<Shape> = {};
  if (kind !== 'note') {
    if (ls.fill !== undefined) sticky.fill = ls.fill;
    if (ls.stroke !== undefined) sticky.stroke = ls.stroke;
    if (ls.strokeWidth !== undefined) sticky.strokeWidth = ls.strokeWidth;
    if (ls.fontFamily !== undefined) sticky.fontFamily = ls.fontFamily;
    if (ls.fontSize !== undefined) sticky.fontSize = ls.fontSize;
    if (ls.textColor !== undefined) sticky.textColor = ls.textColor;
    if (ls.textAlign !== undefined) sticky.textAlign = ls.textAlign;
    if (
      ls.cornerRadius !== undefined &&
      (kind === 'rect' || kind === 'container')
    ) {
      sticky.cornerRadius = ls.cornerRadius;
    }
    // Both sticky copies call the same gate helper, so unlike cornerRadius
    // (whose kind list already disagrees with defaultShapeFromTool's) prism
    // can't drift between the two paths.
    if (ls.strokeGradient !== undefined && shapeKindSupportsPrismStroke(kind)) {
      sticky.strokeGradient = { ...ls.strokeGradient };
    }
  }
  editor.addShape({
    id,
    kind,
    x,
    y,
    w,
    h,
    layer: extras.layer ?? editor.activeLayer,
    ...sticky,
    ...extras,
  } as Shape);
  // Parity with the canvas drop + draw paths: a shape that lands over a
  // visible container becomes its member. Containers themselves stay out
  // (nesting is an explicit drag-in, never an accident of placement).
  if (kind !== 'container') editor.adoptIntoContainer(id);
  editor.setSelected(id);
}

/** Drop a Dashboard basic-shape primitive centred on world-space `at`,
 *  defaulting to the viewport centre. Mirrors Canvas's
 *  `application/x-vellum-shape` drop branch: an actual geometric primitive
 *  with an empty label and its own seed, sticky-style-free so it behaves
 *  exactly like the toolbar-drawn one once on canvas. */
export function insertBasicShape(spec: BasicShapeInsertSpec, at?: { x: number; y: number }): void {
  const w = spec.w ?? 120, h = spec.h ?? 90;
  const p = at ?? viewportCentre();
  const { x, y } = at ? {x: at.x-w/2,y: at.y-h/2} : placeAt(p, w, h);
  const kind = spec.kind ?? 'polygon';
  const id = newId(kind);
  const editor = useEditor.getState();
  editor.beginHistoryBatch();
  editor.addShape({
    id, kind, x, y, w, h, label: '', layer: editor.activeLayer,
    seed: Math.floor(Math.random() * 1e6),
    ...(spec.cornerRadius !== undefined ? {cornerRadius: spec.cornerRadius} : {}),
    ...(kind === 'polygon' ? spec.preset ? {polygonPreset: spec.preset} : {sides: spec.sides ?? 3, polygonStar: spec.star === true} : {}),
  });
  editor.adoptIntoContainer(id);
  editor.endHistoryBatch();
  editor.setSelected(id);
  const entry = BASIC_SHAPES.find(candidate =>
    (candidate.kind ?? 'polygon') === kind && candidate.preset === spec.preset &&
    (candidate.sides ?? 3) === (spec.sides ?? 3) && !!candidate.star === !!spec.star &&
    (candidate.w ?? 120) === w && (candidate.h ?? 90) === h && candidate.cornerRadius === spec.cornerRadius);
  if (entry) editor.recordRecent({key:`library:basic:${entry.id}`,label:entry.label,glyph:'',source:{kind:'library',libShapeId:`basic:${entry.id}`,libName:'Basic Shapes'}});

}

/** Insert a validated library fragment as one undoable edit. Clicks centre
 * the bundle; drops place its top-left at the pointer. */
export function insertBundle(
  entry: PersonalLibraryEntry | unknown,
  at?: { x: number; y: number },
  placement: 'center' | 'top-left' = 'center',
): void {
  const fragment = parseClipboardEnvelope(entry);
  if (!fragment.shapes.length && !fragment.connectors.length) return;
  const box = fragmentBounds(fragment);
  const point = at ?? viewportCentre();
  const origin = placement === 'top-left' ? point : placeAt(point, box?.w ?? 0, box?.h ?? 0);
  const transformed = remapFragment(fragment, origin.x - (box?.x ?? 0), origin.y - (box?.y ?? 0), newId);
  const stripZ = <T extends { z?: number }>(o: T): T => {
    const { z: _z, ...rest } = o;
    return rest as T;
  };
  useEditor.getState().addFragment(transformed.shapes.map(stripZ), transformed.connectors.map(stripZ), transformed.assets);
}

/** Resolve the destination before any async icon fetch, so a later selection
 * change cannot put the equipment in a different U. */
export function rackUnitTarget(at?: { x: number; y: number }, ignoreIds: readonly string[] = []): Shape | undefined {
  const s = useEditor.getState();
  const byId = new Map(s.diagram.shapes.map(sh => [sh.id, sh]));
  const visible = s.diagram.shapes.filter(sh =>
    !ignoreIds.includes(sh.id) && shapeVisibleInMode(sh, s.layerMode) && !hiddenByCollapsedAncestor(sh, byId));
  if (!at) return s.selectedIds.length === 1
    ? visible.find(sh => sh.id === s.selectedIds[0] && sh.rackUnit)
    : undefined;
  const hit = pickShapeAt(at, visible,
    effectiveZMap(s.diagram.shapes, s.diagram.connectors), { bypassGroup: true });
  return hit?.rackUnit ? hit : undefined;
}
