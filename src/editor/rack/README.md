# Rack diagrams

Open **Shapes & icons → Shapes → Racks**. Start with a 12U, 24U, 42U or 48U rack;
the inspector accepts any height from 1 to 100U. U1 is at the bottom by
default, with a top-down numbering option.

Select a U (or use **Select rack unit** in the inspector) to add a server,
switch, patch panel, UPS or blanking panel. **Search icons…** accepts any
installed pack icon. Icon tiles can also be dropped directly onto a U.
Drag an existing canvas icon onto a U to assign its artwork and label there.
The destination highlights before release. This replaces any previous artwork,
removes the loose icon, and reconnects its attached lines to the U. The U keeps
its ID, rack position, frame styling and stratum metadata. Other icon metadata
is merged without overwriting the U's metadata. Escape or pointer cancellation
restores the original icon; the completed move is one undo/redo step. Dropping
outside a U remains an ordinary icon move, and moving a selection of multiple
icons does not combine them into one U.
Each U has its own editable equipment label, appearance and connector
anchors. Double-click a unit to edit its label, or the header to rename the
rack. Icon and height controls remain available in the inspector.

Drag a U onto another U to swap their positions, either within one rack or
between racks. Dropping onto an empty U moves the equipment there. The
preview highlights the destination; Escape, losing window focus, or dropping
outside a U cancels the drag. Each swap is one undo/redo step.

The **whole unit moves**: its ID, icon, label, appearance, metadata and attached
connectors travel together. This keeps Blueprintr stratum links with the moved
unit. The U number, parent rack, geometry, rotation and layer change to match
the destination. Rack heights and the number of unit shapes stay unchanged.

Drag the header or rails to move the rack. Resize the frame to change the
display size without changing its height in U or scaling the frame's stroke
width. Change **height (U)** to add units while keeping the existing row
pitch. Units above a reduced height are hidden, retaining their contents,
IDs and connections; increasing the height restores those same units.

**Clear unit** or Delete on a selected U clears its equipment and label,
preserving the unit and its connections. Delete on the rack removes the
whole rack. Undo restores either operation. Copying a rack copies all of
its units (including hidden ones) and remaps internal connector endpoints.
Copying just one unit makes an independent icon or service shape.

## Data and Blueprintr integration

The frame is a new `kind: 'rack'` shape with
`rack: { units: number, numbering?: 'bottom-up' | 'top-down' }`.
Each U is a separate **top-level entry in `diagram.shapes`**, with:

```ts
{
  id: 'rack-123-u1',        // opaque stable identity; do not derive links from the spelling
  kind: 'service',
  parent: 'rack-123',
  rackUnit: { u: 1 },      // hidden: true when above the current rack height
  label: 'Core switch',
  iconSvg: '…',
  iconAttribution: { /* existing icon provenance format, when applicable */ },
  // x, y, w, h, rotation and layer are maintained by the rack layout.
}
```

A unit's ID is opaque: after dragging, an ID originally generated as
`rack-123-u1` may belong to another rack or U position. Always read `parent` and
`rackUnit.u` for its current location. Use
`useEditor.getState().swapRackUnits(sourceId, targetId)` for a programmatic
swap with normal visibility/read-only gates and one undo step.
`useEditor.getState().assignIconToRackUnit(iconId, unitId)` performs the same
canvas-icon assignment programmatically. As with replacing artwork from a
picker, the U's ID remains the host link target; the absorbed loose icon's ID
is removed. Hosts that also link standalone icons should remap those external
links to the U when implementing this merge in their integration.

There is no stratum-specific field in Vellum core. Existing per-shape `meta`
is preserved, and the external relation should target the **U shape's id**.
This matches the current Blueprintr contract reviewed in:

- `src/lib/diagram.ts`: `extractVellumShapes` walks top-level shapes and
  recognizes `service` as linkable.
- `vellum-shell/blueprintr/embedBridge.ts`: hover resolves the nearest
  `data-shape-id`; click uses the single selected shape id.
- `BlueprintFile.linkedShapeId`: the external stratum-to-shape relation.

Rack units use those existing DOM wrappers, selection state and context-menu
shape targets. Empty units are also addressable, so a stratum can be assigned
before equipment is chosen. Replacing artwork, renaming, moving, resizing,
rotating, changing numbering, clearing equipment and reducing/restoring rack
height keep that unit id. Duplicating a rack generates new frame and unit ids;
it does not duplicate externally stored strata.

The public API exports `createRack`, `getRackUnits`, `rackHeightPatch`,
`rackLayout`, `rackUnitBox`, `rackUnitCount`, `MAX_RACK_UNITS`, and their types:

```ts
const units = getRackUnits(useEditor.getState().diagram.shapes, rackId);
// Persist BlueprintFile.linkedShapeId = units[n].id in the host.
// getRackUnits(shapes, rackId, true) includes hidden units for link retention.
```

When adopting this core version into Blueprintr, add `rack` to
`VELLUM_LINKABLE_KINDS` if the frame itself should also accept a stratum.
Exclude `shape.rackUnit?.hidden` from _new assignment_ lists, while retaining
existing links to those units. The existing `service` whitelist already
admits every U. Core changes do not update Blueprintr's pinned submodule,
overlay deployment or database; those remain host integration steps.

Use the normal schema parsers when loading documents and the store mutation
methods when editing. They materialize missing units and synchronize layout.
SVG artwork uses the existing sanitizer and provenance fields; tooltip markup
is suppressed only in the rendered DOM. YAML and exported editable sources
retain the document data, including hidden units. Visual exports omit hidden
units, their connectors and editing controls.
