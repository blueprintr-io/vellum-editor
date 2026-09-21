# Orthogonal connector editing

Elbows use segment controls: dragging a horizontal segment moves it vertically;
dragging a vertical segment moves it horizontally. The gesture starts from the
rendered polyline, including synthetic bends in legacy documents. Moving a
segment changes its two corners together. End segments gain short connecting
legs so both endpoints remain attached. Aligning neighbouring segments removes
redundant bends. Grid snapping follows the magnet toggle; Alt bypasses snapping.

A click or movement along a segment does not edit the document. Returning to the
starting position, pressing Escape, or pointer cancellation restores the original
connector. Each completed edit is one undo entry. Endpoints can subsequently be
rebound, and moving a shape stretches the terminal legs while retaining the
manually positioned route.

Routing does not avoid obstacles across unrelated shapes.

## Document compatibility

`Connector.waypointMode?: 'segments'` identifies manually edited route corners.
The field is written only when an orthogonal segment actually changes. Without
it, both automatic and waypoint routes use the unchanged legacy router. Loading,
rendering, or saving an old document does not opt its connectors into the new
interpretation. Undo restores the original connector, including the absence of
the field. Clearing bends clears the field as well.

`connectorPolyline` is shared by segment handles, body hit-testing, labels and
route measurements. `buildPath` accepts the mode as its final optional argument;
the renderer, hover highlights and selection highlights pass it. Export uses
the same canvas renderer. Embedders that implement their own geometry predictor
must support this field before interpreting newly edited connectors. The
legacy automatic routing algorithm has not changed.

## Regression checks

- `tests/orthogonal-edit.test.ts`: segment movement, attachment direction,
  shape movement, marker setbacks, save/load, off-axis data after routing-style
  changes, 4,224 geometry cases and 288 pre-change route fingerprints.
- `tests/e2e/connector-undo.spec.ts`: real pointer gestures at three zoom levels,
  grid/Alt behaviour, legacy segment hit-testing, alignment, repeated edits,
  cancellation, undo/redo, rebinding and saving/reopening.

Run `npm test`, `npm run typecheck`, and
`npx playwright test tests/e2e/connector-undo.spec.ts tests/e2e/undo-gestures.spec.ts tests/e2e/export.spec.ts --workers=2`.
