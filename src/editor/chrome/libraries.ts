import { RACK_EQUIPMENT, RACK_PRESETS } from '@/editor/rack/catalog';
import { NOTATION_CATALOG, RELATIONSHIPS } from '@/editor/notation/catalog';
/** Static shape catalog - surfaced by both the floating MoreShapesPopover and
 *  the persistent LibraryPanel. v1 is hard-coded; v2 will derive from
 *  `src/libraries/*.ts` (each loaded on demand) so users can install/remove
 *  packs without a code change. Living here (not in MoreShapesPopover) so any
 *  future surface - palette, command-k, etc. - can read from the same source. */

export type LibraryShape = {
  id: string;
  label: string;
  glyph: string;
  /** When this shape is bound to a hotkey slot (from the editor store). */
  boundKey?: string;
};

export type Library = {
  id: string;
  name: string;
  version: string;
  shapes: LibraryShape[];
};

export const LIBRARIES: Library[] = [
  // Home ships empty - the recent-shapes feed + pinned-packs column
  // are rendered out-of-band by Dashboard.tsx. The `recent` id is kept for
  // back-compat with the persisted tab state.
  { id: 'recent', name: 'Home', version: '', shapes: [] },
  { id:'racks', name:'Racks', version:'', shapes:[...RACK_PRESETS.map(p=>({id:p.id,label:p.label,glyph:'▤'})),...RACK_EQUIPMENT.map(p=>({id:p.id,label:p.label,glyph:'▥'}))] },
  ...(['UML', 'BPMN', 'Flowchart'] as const).map(family => ({ id: family.toLowerCase(), name: family, version: '', shapes: [...NOTATION_CATALOG.filter(d => d.family === family).map(d => ({id:d.id,label:d.label,glyph:family})), ...RELATIONSHIPS.filter(r => r.id.startsWith(family.toLowerCase()+'-')).map(r => ({id:r.id,label:r.label.split(' · ')[1],glyph:'→'}))] })),
];
