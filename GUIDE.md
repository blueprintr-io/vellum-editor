# Vellum guide

Detailed notes on shapes, exports and saving. For an overview, see the [README](./README.md).

## Native UML, BPMN and flowcharts

Open the library (`S`), select **Shapes**, then choose **UML**, **BPMN** or **Flowchart**.
Click a tile to insert it, or drag it onto the canvas. These are native geometry,
so resizing changes the outline dimensions without changing stroke width.
The old Flowchart icon pack is replaced in the picker. Existing icon-based
flowcharts still open; select one and use **Convert to an editable native shape**
to upgrade it in place.

- UML includes class/interface/object/enumeration compartments, use cases and actors,
  components, packages and deployment nodes, state/activity nodes, lifelines,
  activations and combined fragments. Double-click to edit a name; use the
  inspector for stereotypes, attributes and operations (one member per line).
- For relationships, select two shapes, then choose a relationship in the library.
  With no pair selected, it inserts a connector whose ends can be dragged onto
  shapes. The connector inspector offers generalization, realization, dependency,
  aggregation, composition, include/extend, sequence messages, BPMN sequence and
  message flows, associations, conditional flows and default flows. Source/target
  role fields also hold UML multiplicities such as `1` and `0..*`.
- For BPMN, configure event definitions, interruption/throw behavior, task types,
  loop and compensation markers. Pools and lanes are nested containers. Add a
  boundary event while its activity is selected, or drop it onto the activity;
  it stays attached when the activity moves or resizes. Slide it along the edge
  or change **Attached to** in the inspector. Subprocesses can collapse and
  expand while preserving their contents. **Check BPMN diagram** checks flow
  attachment, event direction, pool boundaries and supported event rules; click
  an issue to select its element.
- For callouts, drag the gold tip to point the tail and extend it, or drag its
  base along the edge. The inspector controls side, base/tip position, width and
  length. Tail dimensions are in canvas units and stay stable during body resize;
  text occupies the bubble, away from the tail.

Native notation uses the same layers, styling, groups, undo, clipboard, personal
libraries, `.vellum` saves and image exports as the rest of the editor. Notation
options are stored on `Shape.notation`; callout parameters on `Shape.callout`.
The notation catalog, shape factory and diagram checks are exported for embedded
consumers. The notation references are [OMG UML 2.5.1](https://www.omg.org/spec/UML/2.5.1)
and [OMG BPMN 2.0.2](https://www.omg.org/spec/BPMN/2.0.2).

The catalog contains 41 UML, 32 BPMN and 31 flowchart shapes, plus 19
relationship presets. Additional controls cover choreography participant bands,
conversation links, ad-hoc subprocesses, data inputs/outputs and timing lifelines.
See the [coverage and remaining limits](src/editor/notation/COVERAGE.md) for the
scope of standards support.

### Basic and freeform shapes

**Shapes → Basic Shapes** includes 33 presets. **Draw freeform shape** (`F`)
lets you drag a custom outline, with a dashed closing edge visible while drawing.
Release to create a closed, fillable shape, or press Escape to discard it.
Resizing preserves stroke width, and labels, connectors, saving and export work
as with other shapes. The existing freehand pen (`9`) still draws open strokes.
See [freeform shape behavior and storage](src/editor/shapes/README.md).

### Rack diagrams

The **Racks** library adds a native rack shape with 1–100U, per-unit equipment icons, labels and connectors. Units retain independent shape IDs for Blueprintr stratum links, including when hidden by a reduced rack height. See [rack usage and integration](src/editor/rack/README.md).


The shape picker is organized as **Home** (recent and pinned), **Shapes**
(Basic Shapes, UML, BPMN, Racks and Flowchart, plus your Personal library), and
**Icons**. Recent shapes use the same previews as their category tiles.

Double-click a rack header or any U to edit its text, including occupied units.
The rack and each U keep their existing IDs, equipment artwork and host metadata.
Callout tips can extend past the box and move around all four sides; drag the
base handle to choose an edge. Internal storage and predefined process shapes
have yellow handles for their internal dividers. These adjustments are saved
with the diagram and support undo/redo.

## Exporting images

`⌘S` opens the Save / Export dialog; `⇧⌘C` copies the selection (or the
whole diagram) to the clipboard as a PNG; right-click → "Export
selection…" scopes the dialog to what's selected. Every export path -
the dialog, the top-bar Copy button, the context menu, the public
`rasterizeCanvas` / `buildSvgExport` / `buildPdfExport` API - runs the
same pipeline ([`src/editor/canvas-export.ts`](./src/editor/canvas-export.ts)),
so the live preview in the dialog is exactly what lands on disk.

| Format | Notes |
| --- | --- |
| PNG | Lossless, transparency, DPI-stamped; editable source is an explicit opt-in |
| JPG / WebP | Quality slider, DPI-stamped (JPG is always opaque) |
| SVG | Cropped vector with tokens resolved, labels flattened to measured `<text>`, webfonts inlined, connector/prism animation kept; editable source is an explicit opt-in |
| PDF | One bitmap page per tab at the export scale |
| GIF | Animated capture, offered when a connector or prism stroke animates |

Options: area (diagram / selection / viewport), background (paper as
shown on screen, transparent, white, custom), theme override (light /
dark regardless of the screen), scale 1–4× or an exact pixel width /
height, padding, grid, quality, and "All tabs" (a zip of images or a
multi-page PDF).

### Editable exports

A PNG or SVG exported with "Include full editable document" enabled reopens as
a diagram. File ▸ Open accepts it, and dropping or pasting it onto a canvas
inserts the shapes rather than a flat picture (`src/editor/export/source.ts`).
The embedded source is the same YAML a `.vellum` file holds, stored in a PNG
`iTXt` chunk or an SVG `<metadata>` element.

The option resets to off each time the dialog opens. When enabled, it includes
the full active diagram, including hidden layers, notes and unselected content,
and the dialog states this scope. In an all-tabs image ZIP, each image embeds
its own tab. Clipboard image and SVG copies always omit editable source.

For a private viewport crop, choose PNG and leave the editable document off.
The PNG contains only the rendered pixels within the crop. Viewport SVG exports
keep vector objects outside the visible crop even with editable source off, so
SVG cropping is not redaction. Selection SVG exports remove unselected shapes
and connectors; selected or partially visible objects keep their full geometry.

## Recovery and saving

Browser recovery stores all tabs and personal-library assets in IndexedDB.
Small preferences use localStorage. If storage is full or unavailable, the editor
shows a recovery notice and keeps edits in memory. Keep the page open and use
Save As to make a file copy. Browser recovery is separate from a saved file.

Save, Save As and autosave share an ordered write queue. Edits made during a write
remain unsaved until a later write includes them. Autosave requires a file handle;
a restored browser session must reopen its file or use Save As to establish one.
When a browser supports only download links, Vellum starts a download and retains
the unsaved indicator because that API cannot confirm completion or cancellation.

