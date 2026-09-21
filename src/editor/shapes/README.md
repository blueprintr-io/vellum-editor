# Basic and freeform shapes

Basic Shapes contains 33 presets (24 additions to the earlier nine). Palette
clicks and drags share catalog data and insertion, including circle/square
sizes and rounded-rectangle corners.

Choose **Shapes → Basic Shapes → Draw freeform shape**, the canvas menu command,
or press **F**. Drag an outline; the dashed edge shows how it will close. Release
to create a filled polygon. Escape or pointer cancellation discards the gesture;
a click or a line is not committed. Tool lock allows consecutive shapes.

The existing **9** pen continues to create open freehand strokes.

Freeform shapes persist as `kind: polygon` with `polygonVertices` in normalized
bounding-box coordinates. SVG paths always end in `Z`. Resizing changes the
coordinates without scaling the stroke. The renderer, connector anchor
projection, hit testing and exports use this same outline. The even-odd fill
rule defines the interior of self-crossing outlines. Existing polygon presets
and pen `points` keep their original data format.
