# Native diagram notation coverage

The palette currently contains **41 UML shapes, 32 BPMN shapes, 31 flowchart
shapes and 19 relationship presets**, alongside 33 Basic Shapes and native
rack frames/equipment. Event definitions, task types, loop markers and other
inspector variants do not inflate those shape counts.

All are editable world-coordinate geometry. Resizing preserves stroke width.
Labels, layers, grouping, connectors, copying, undo, Vellum files and SVG/PNG
exports use the existing editor paths.

## Added after the catalog audit

- UML: ports, provided/required interfaces, input/output pins, send/accept
  signals, accept-time actions, entry/exit points, junction/termination,
  destruction, interaction references, activity partitions and timing lifelines.
  Timing steps have editable state names and durations.
- BPMN: ad-hoc subprocesses, data inputs/outputs, instantiating exclusive and
  parallel event gateways, instantiating receive tasks, choreography tasks,
  sub/call choreographies, conversations, sub/call conversations and double-line
  conversation links. Choreography participant names, initiating side and
  multiplicity are editable. Pools support participant multiplicity.
- Flowchart: alternate process, sequential-access storage and magnetic disk.

## Scope and remaining gaps

This is a diagram authoring tool, not a claim of complete OMG conformance.
The catalog audit is based on the
[OMG UML specification](https://www.omg.org/spec/UML/2.5/PDF),
[OMG BPMN 2.0.2 specification](https://www.omg.org/spec/BPMN/2.0.2/PDF), and the
[LibreOffice flowchart symbol reference](https://books.libreoffice.org/en/DG76/DG7608-ConnectionsFlowchartsOrganisationCharts.html).

- UML ports, pins and state connection points can be placed and grouped with
  other shapes; they are not automatically bound to a classifier's perimeter.
- Combined fragments do not yet have structured operand/guard editing.
- Choreography symbols currently have two participant bands. Additional bands,
  participant-message decorators and complete choreography semantics remain.
- Timing lifelines draw editable state/duration traces, but do not validate
  time constraints between separate lifelines.
- UML metamodel validation, BPMN execution and XMI/BPMN XML interchange are not
  implemented. The BPMN checker reports a limited set of diagramming issues.

Generic labels, freeform polygons and connectors can supplement diagrams, but
are not counted as dedicated standard elements or a replacement for these gaps.
