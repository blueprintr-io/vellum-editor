import { useEditor } from '@/store/editor';
import { ConnectorInspector } from './ConnectorInspector';
import { ShapeInspector } from './ShapeInspector';
import { DefaultsInspector } from './DefaultsInspector';

/** Contextual inspector - morphs based on selection (shape vs connector vs
 *  multi-select). Multi-select v2 will show only fields common to all
 *  selected items; v1 picks the first selected for now.
 *
 *  When nothing is selected, the inspector renders a *defaults* editor IF the
 *  user has pinned it open (`inspectorOpen`). That panel writes to
 *  `lastStyles` / `lastConnectorStyle`, which the shape/connector creation
 *  paths already read from - so configuring stroke + fill there before
 *  drawing actually changes the next-drawn shape's appearance.
 *
 *  The `key` on the inner panel is critical: it forces a remount when the
 *  selected entity changes, which resets the controlled-input drafts. Without
 *  it, internal `useState(value)` defaults stick to the first-mounted value. */
export function Inspector() {
  const id = useEditor((s) => s.selectedIds[0] ?? null);
  const shape = useEditor((s) =>
    id ? s.diagram.shapes.find((sh) => sh.id === id) ?? null : null,
  );
  const conn = useEditor((s) =>
    id ? s.diagram.connectors.find((c) => c.id === id) ?? null : null,
  );
  const inspectorOpen = useEditor((s) => s.inspectorOpen);

  if (!id) return inspectorOpen ? <DefaultsInspector /> : null;
  if (conn) return <ConnectorInspector key={conn.id} conn={conn} />;
  if (shape) return <ShapeInspector key={shape.id} shape={shape} />;
  return null;
}
