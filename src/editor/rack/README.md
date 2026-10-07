# Rack diagrams

Open **Shapes & icons → Shapes → Racks**. Start with a 12U, 24U, 42U or 48U rack;
the inspector accepts any height from 1 to 100U. U1 is at the bottom by
default, with a top-down numbering option.

## Equipment

Select a U (or use **Select rack unit** in the inspector) and choose from
**Equipment**, or drop an equipment tile from the Racks library onto a U.
The catalogue (`RACK_DEVICE_SPECS`) covers what goes in a rack:

- **Network:** switches, chassis switches, routers, firewalls, load
  balancers, wireless controllers, copper and fiber patch panels, cable
  managers, console servers, KVM switches and SAN switches.
- **Compute:** servers, GPU servers, blade chassis, multi-node servers and
  rack PCs.
- **Storage:** storage arrays, storage nodes, disk shelves, NAS and tape
  libraries.
- **Power:** UPSes, battery packs, PDUs and transfer switches.
- **Panels and accessories:** blanking, vented and brush panels, shelves,
  drawers, KVM consoles, fan trays and environment monitors.
- **Other:** PBX, AV, NVR, time servers, HSMs and a generic device.

Built-in equipment is drawn to fill its U, and redraws at the new size
when the rack is resized. **Search icons…** lists the rack equipment
first - the whole catalogue before anything is typed - then any installed
pack icon. The search is forgiving: abbreviations and synonyms ("fw",
"lb", "jbod", "oob", "cctv"), typos ("swtich") and partly typed words all
find the equipment, and options named in the query are applied when it is
fitted - "48 port switch", "c19 pdu", "12 bay nas", "2u server". The arrow
keys and Enter pick from the keyboard. An ordinary icon is not stretched -
it sits on the left of the U with its label beside it. A shelf item's
search lists icons only.

Each device lists its own **options** - port counts and types, uplinks,
power supplies, drive bays, slots, blades or nodes - and redraws to match.
Fitting a device gives it its usual height (a 2U storage node, a 7U
chassis) when the U above are free, or as much of it as fits.

**Height** makes a unit span several U. It grows toward higher U numbers -
up the rack when U1 is at the bottom - over empty slots only: a U that
holds equipment, a label of its own, or a connection stops it. The slots it
covers stay in the document, hidden, with their ids and links, and come
back when the unit shrinks, is cleared or moves away. A device squeezed
below its usual height keeps every slot and interface, drawn smaller.

An equipment label floats beside the rack, on the right by default; **Label
at** moves it to the left or draws it over the device.

## Interfaces

Every interface a device draws - switch ports and uplinks, console and
management ports, server NICs and BMCs, controller host ports, power
inlets and outlets - is a shape of its own. Click one to select it,
double-click to name it, and drag a line from its dot to cable it. The
inspector's **Equipment** section lists them all (**Select interface**) and
counts the cabled ones.

An interface has one connection point: the middle of the edge its cable
plugs in by - the top of a top-row port, the bottom of a bottom-row one. A
cable bound to an interface always meets that point. Ports are numbered as
on a switch face, odd on top and even beneath, and cabled interfaces are
drawn filled. Equipment with interfaces offers only its two ends as
connection points of its own, so they never crowd its interfaces;
equipment without any keeps the standard eight, on the device outline.

Changing an option keeps every interface that still exists, with its id,
name, cables and links. Interfaces an option removes are stored, hidden,
until an option brings them back. The inspector says when cabled
interfaces are stored this way.

## Modules

Some equipment holds modules in slots: a chassis switch takes line cards
and supervisors, a blade chassis takes blades, a multi-node server takes
nodes, a storage array takes controllers and a shelf takes items. Each
module is a shape of its own too, selectable and linkable, carrying its own
interfaces. Change what a slot holds from the equipment's slot list or,
with the module selected, **Module holds**. A different card brings its
own ports; the previous card's ports are stored with their links, and
return when that card does. A shelf item can show any icon. Supervisors
start in the middle of a large chassis.

## Moving, clearing and copying

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
between racks. Dropping onto an empty U moves the equipment there. Taller
equipment lands with its leading edge on the target - its bottom U when
moving down the numbering, its top U when moving up - so it can be nudged a
single U; units it passes over shift to the other side of it. A move that
would cover equipment or a connected slot, or push a third device aside, is
refused, and the preview says there is no room. The preview highlights the
whole destination; Escape, losing window focus, or dropping outside a U
cancels the drag. Each move is one undo/redo step. Dragging a module or an
interface moves the equipment it belongs to.

The **whole unit moves**: its ID, icon, label, appearance, metadata, modules,
interfaces and attached connectors travel together. This keeps Blueprintr
stratum links with the moved equipment. The U number, parent rack, geometry,
rotation and layer change to match the destination. Rack heights and the
number of unit shapes stay unchanged.

Drag the header or rails to move the rack. Resize the frame to change the
display size without changing its height in U or scaling the frame's stroke
width. Change **height (U)** to add units while keeping the existing row
pitch. Units above a reduced height are hidden, retaining their contents,
IDs and connections; increasing the height restores those same units.

**Clear unit** or Delete on a selected U clears its equipment and label
and returns it to a single U, preserving the unit and its connections; its
modules and interfaces are stored, hidden, and return if the same equipment
is fitted again. Delete on a module empties its slot. Delete on an
interface only resets its name: interfaces come and go with the equipment's
options, never one at a time. Delete on the rack removes the whole rack.
Undo restores each of these. Copying a rack copies all of its units,
modules and interfaces (including hidden ones) and remaps internal
connector endpoints. Copying just one unit makes an independent icon or
service shape; modules and interfaces are not copied without their rack.

## Data and Blueprintr integration

The frame is a `kind: 'rack'` shape with
`rack: { units: number, numbering?: 'bottom-up' | 'top-down' }`.
Each U, module and interface is a separate **top-level entry in
`diagram.shapes`**:

```ts
// A U
{
  id: 'rack-123-u1',        // opaque stable identity; do not derive links from the spelling
  kind: 'service',
  parent: 'rack-123',
  rackUnit: {
    u: 1,                   // lowest U the unit occupies
    span: 2,                // optional height in U (default 1)
    device: 'switch',       // optional built-in equipment: a RACK_DEVICE_SPECS type
    options: { ports: 48 }, // optional device options; missing or unknown values read as the default
    labelSide: 'left',      // equipment label: right (default) | left | over
    // hidden: true when above the rack height or covered by taller equipment
  },
  label: 'Core switch',
  iconSvg: '…',             // equipment: a static copy of the artwork, for older readers
  iconAttribution: { /* existing icon provenance format, when applicable */ },
  // x, y, w, h, rotation and layer are maintained by the rack layout.
}

// A module, in a slot of the U's equipment
{
  id: 'rack-123-u1-slot-3',
  kind: 'service',
  parent: 'rack-123-u1',
  rackModule: { slot: 3, type: 'supervisor' /* , hidden: true */ },
  label: 'Slot 3',
}

// An interface, on the U's equipment or on a module
{
  id: 'rack-123-u1-slot-3-uplink-2',
  kind: 'service',
  parent: 'rack-123-u1-slot-3',
  rackPort: { group: 'uplink', n: 2, kind: 'sfp' /* , side: 'bottom', hidden: true */ },
  label: 'Uplink 2',
}
```

A unit is equipment when `rackUnit.device` is set (or its `iconSvg` is
built-in rack artwork, as in documents saved before devices were modelled)
and it carries no other icon: a picked icon always wins. The rack model
creates module and interface shapes as equipment needs them and keeps
their geometry, layer, connector kind and cable side in step with the
device; identity is the owner plus slot, or the owner plus `group` and `n`.
Ids are generated once, as above, and are opaque after that. `hidden` marks
a module or interface its equipment no longer has: excluded from drawing
and new links, retained with its links.

A unit's ID is opaque: after dragging, an ID originally generated as
`rack-123-u1` may belong to another rack or U position. Always read `parent` and
`rackUnit.u` for its current location. Store actions apply the normal
visibility and read-only gates and make one undo step each; they return
false (or do nothing) when refused:

- `swapRackUnits(sourceId, targetId)` - a programmatic move or swap.
- `setRackUnitSpan(unitId, span)` - a unit's height.
- `setRackUnitDevice(unitId, type)` - fit equipment at its usual height,
  or as much as fits.
- `setRackDeviceOption(unitId, key, value)` - one of the device's options;
  only catalogue values are accepted.
- `setRackModuleType(moduleId, type)` - what a slot holds.
- `assignIconToRackUnit(iconId, unitId)` - the canvas-icon assignment. As
  with replacing artwork from a picker, the U's ID remains the host link
  target; the absorbed loose icon's ID is removed. Hosts that also link
  standalone icons should remap those external links to the U.

There is no stratum-specific field in Vellum core. Existing per-shape `meta`
is preserved, and the external relation should target the **id of the U,
module or interface** it describes. This matches the current Blueprintr
contract reviewed in:

- `src/lib/diagram.ts`: `extractVellumShapes` walks top-level shapes and
  recognizes `service` as linkable - which admits every U, module and
  interface.
- `vellum-shell/blueprintr/embedBridge.ts`: hover resolves the nearest
  `data-shape-id`; click uses the single selected shape id.
- `BlueprintFile.linkedShapeId`: the external stratum-to-shape relation.

Units, modules and interfaces use those existing DOM wrappers, selection
state and context-menu shape targets. A unit draws its equipment's modules
and interfaces itself, as rects marked `data-rack-target` that carry their
own `data-shape-id`, so a hit-test at a point lands on the innermost one.
A host that links only the equipment should walk up from there to the
nearest linked `data-shape-id` (the module, then the unit) rather than
treat the interface as unlinked. Empty units are also addressable, so a
stratum can be assigned before equipment is chosen. Replacing artwork,
renaming, moving, resizing, rotating, changing numbering or options,
clearing equipment and reducing/restoring rack height keep every unit,
module and interface id. Duplicating a rack generates new ids for
everything in it; it does not duplicate externally stored strata.

The public API exports `createRack`, `getRackUnits`, `getRackInterfaces`,
`rackChildren`, `rackOwnerUnit`, `rackHeightPatch`, `rackLayout`,
`rackUnitBox`, `rackUnitCount`, `rackUnitSpan`, `rackUnitDevicePatch`,
`rackUnitMaxSpan`, `rackUnitDevice`, `rackDeviceSpec`, `RACK_DEVICE_SPECS`,
`RACK_CATEGORIES`, `RACK_MODULE_LABELS`, `MAX_RACK_UNITS`, and their types:

```ts
const shapes = useEditor.getState().diagram.shapes;
const units = getRackUnits(shapes, rackId);
// Persist BlueprintFile.linkedShapeId = units[n].id in the host.
const ports = getRackInterfaces(shapes, units[n].id);
// Every interface on that unit's equipment and its modules; pass `true`
// as a third argument to include stored (hidden) ones for link retention.
```

When adopting this core version into Blueprintr, add `rack` to
`VELLUM_LINKABLE_KINDS` if the frame itself should also accept a stratum.
Exclude hidden units (`rackUnit.hidden`), modules (`rackModule.hidden`) and
interfaces (`rackPort.hidden`) from _new assignment_ lists, while retaining
existing links to them. Name an interface by its equipment in pickers
("Port 5 · Core switch"); the label alone repeats across a rack. Core
changes do not update Blueprintr's pinned submodule, overlay deployment or
database; those remain host integration steps.

Use the normal schema parsers when loading documents and the store mutation
methods when editing. They materialize missing units, modules and
interfaces and synchronize layout. An unreadable rack field falls back on
its own, so a damaged option never empties a cabled unit. SVG artwork uses
the existing sanitizer and provenance fields; tooltip markup is suppressed
only in the rendered DOM. YAML and exported editable sources retain the
document data, including hidden units, modules and interfaces. Visual
exports omit hidden shapes, their connectors and editing controls.
