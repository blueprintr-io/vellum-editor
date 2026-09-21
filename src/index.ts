// Public API for `vellum-editor`. Consumers import from this entry only;
// anything not re-exported here is internal.

export { Editor as VellumEditor } from './editor/Editor';
export type { VellumEditorProps } from './editor/Editor';

export { useEditor } from './store/editor';
export { setUnsavedChangesPrompt } from './editor/useAutosave';

/** Default slim bottom bar used by the `diagramTabs` plugin slot. Embedders
 *  who want the standalone-style chrome can register a plugin with
 *  `diagramTabs: <DiagramTabsBar />`; embedders that omit the slot get no
 *  bottom strip. Stand-alone Vellum (vellum.blueprintr.io) opts in via the
 *  shipped App.tsx; Blueprintr's wizard / strata picker leaves it out. */
export { DiagramTabsBar } from './editor/chrome/DiagramTabsBar';

// Plugin / slot extension API. Embedders (e.g. Blueprintr) build a
// `VellumPlugin` and pass it via <VellumEditor plugins={[plugin]} /> to
// contribute hamburger items, context-menu items, top-right buttons, and
// brand-icon replacements without forking core.
export type {
  VellumPlugin,
  PluginMenuItem,
  PluginMenuSeparator,
  PluginMenuEntry,
  PluginContextMenuItem,
  PluginContextMenuEntry,
  ContextMenuTargetKind,
} from './plugins/types';
export type { ContextMenuTarget } from './editor/chrome/ContextMenu';

export type {
  DiagramState,
  Shape,
  ShapeKind,
  Anchor,
  TableCell,
  LabelAnchor,
  IconAttribution,
  IconConstraints,
  Connector,
  ConnectorEndpoint,
  EndpointMarker,
  Annotation,
  Theme,
  Layer,
  LayerMode,
  ToolKey,
  ToolDef,
  HotkeyBindings,
} from './store/types';

export {
  parseDiagram,
  parseShapes,
  parseConnectors,
  parseAnnotations,
  parseClipboardEnvelope,
} from './store/schema';
export { sanitizeSvg } from './lib/sanitize-svg';

export {
  diagramToYaml,
  yamlToDiagram,
  openVellumFile,
  saveVellumFile,
  triggerDownload,
} from './store/persist';

export {
  handleNew,
  handleOpen,
  handleSave,
  handleSaveAs,
  handleCopyPng,
  handleCopySvg,
  handleSaveRasterImage,
  handleSaveSvg,
  handleSavePdf,
  handleExportYaml,
  rasterizeCanvas,
  buildSvgExport,
  buildPdfExport,
  renderExportPreview,
  openSaveSink,
  selectionExportIds,
  tryInsertEmbeddedDiagram,
  forEachTab,
} from './editor/files';
export type {
  ImageExportOptions,
  RasterResult,
  SvgExport,
  PdfExport,
  ExportPreview,
  SaveSink,
} from './editor/files';
export { workspaceFromFile } from './store/persist';
export {
  extractEmbeddedSource,
  extractSourceFromPng,
  extractSourceFromSvg,
  PNG_SOURCE_KEYWORD,
  SVG_SOURCE_ID,
} from './editor/export/source';
export { handleSaveGif, rasterizeAnimatedGif } from './editor/gif';

// Image-export building blocks for hosts that render their own export UI.
export {
  prepareCanvasClone,
  effectivePaperColour,
  serializeSvg,
  viewportWorldRect,
  themeTokens,
} from './editor/canvas-export';
export type { CanvasClonePrep, PrepareOptions } from './editor/canvas-export';
export {
  DEFAULT_EXPORT_PREFS,
  SCALE_OPTIONS,
  resolveBackground,
  exportFilename,
} from './editor/export/options';
export type {
  ExportPrefs,
  ExportBackground,
  ExportFormat,
  ExportTheme,
  ExportArea,
  ImageFormat,
  RasterFormat,
} from './editor/export/options';
export { notify } from './editor/notify';
export type { NoticeDetail, NoticeTone } from './editor/notify';

// Native diagram notation: shared by the editor and embedded consumers.
export { NOTATION_CATALOG, RELATIONSHIPS, notationShape } from './editor/notation/catalog';
export type { Notation, NotationType, Callout } from './editor/notation/catalog';
export { validateNotation } from './editor/notation/model';

export { createRack, getRackUnits, rackHeightPatch, rackLayout, rackUnitBox, rackUnitCount, MAX_RACK_UNITS } from './editor/rack/model';
export type { RackConfig, RackUnit } from './editor/rack/model';
