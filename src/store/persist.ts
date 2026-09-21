/* YAML save/load + File System Access integration.
 *
 * RULE: in-memory state === serialised state. We hand the diagram to yaml
 * directly - no DTO, no toJSON. yaml.parse(text) → DiagramState.
 *
 * ONE exception: serialised diagrams additionally carry a derived `graph:`
 * section (plus its `graphHash` staleness tripwire) - a diagrams-as-code
 * projection of the connectors, generated here at save time and reconciled
 * back by `applyGraphSection` at load time. It never enters the store; see
 * store/graph.ts for grammar and precedence rules.
 *
 * Determinism: fixed key order + 2-space indent. The point is diff-friendly
 * files - git stays sane and PR review of a diagram change is readable. */

import YAML from 'yaml';
import type { DiagramState } from './types';
import { pruneAssets } from '../lib/doc-assets';
import { parseDiagram, parseWorkspace, type WorkspacePayload } from './schema';
import { extractEmbeddedSource } from '../editor/export/source';
import {
  applyGraphSection,
  buildGraphSection,
  graphDigestForEntries,
} from './graph';

/** Serialisation key order. Semantic first, alphabetical after - still fully
 *  deterministic (same input, same bytes) which is all the git-diff story
 *  needs. Plain alphabetical order buried the story: `annotations` led the
 *  file, `connectors` preceded the shapes they reference, and a connector's
 *  `from`/`to` were split apart by whatever sorted between them. One global
 *  priority list covers every nesting level: envelopes read version-first,
 *  a connector reads id → from → to → label, an endpoint reads shape before
 *  anchor, and a shape leads with id/kind/label before geometry. */
const KEY_PRIORITY = [
  // envelopes
  'version',
  'activeTabId',
  'id',
  'diagram',
  // identity before geometry/presentation
  'kind',
  'from',
  'to',
  'shape',
  'anchor',
  'label',
  'sublabel',
  'icon',
  'body',
  'x',
  'y',
  'w',
  'h',
  'layer',
  'routing',
  'waypoints',
  'style',
  'fromMarker',
  'toMarker',
  // `graph` outranks `meta` so the topology view opens the file; `meta` is
  // ranked here (not left to the residue) so shape/connector meta sits
  // after the identity cluster instead of alphabetically before `id`.
  'graph',
  'meta',
  'title',
  'defaults',
  'tabs',
  // document arrays last so the terse graph view leads the file. graphHash
  // is deliberately UNranked: machine noise sorts into the residue at the
  // very end of the envelope.
  'shapes',
  'connectors',
  'annotations',
  // Binary payloads dead last - multi-KB base64 blocks after everything a
  // human might scroll the file to read.
  'assets',
];
const KEY_RANK = new Map(KEY_PRIORITY.map((k, i) => [k, i]));

const keyName = (k: unknown): string =>
  typeof k === 'object' && k !== null && 'value' in k
    ? String((k as { value: unknown }).value)
    : String(k);

function compareMapKeys(
  a: { key: unknown },
  b: { key: unknown },
): number {
  const ka = keyName(a.key);
  const kb = keyName(b.key);
  const ra = KEY_RANK.get(ka) ?? KEY_PRIORITY.length;
  const rb = KEY_RANK.get(kb) ?? KEY_PRIORITY.length;
  if (ra !== rb) return ra - rb;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** YAML config: 2-space indent, deterministic key order (see KEY_PRIORITY),
 *  defaults flow style for short scalars. The second-arg overload of
 *  YAML.stringify accepts either a replacer or an options object; passing
 *  options directly trips an overload-resolution error. We pass `null` for
 *  the replacer slot to land cleanly in the (value, replacer, options)
 *  overload. */
const STRINGIFY_OPTS = {
  indent: 2,
  sortMapEntries: compareMapKeys,
  lineWidth: 0, // Don't wrap long strings - they round-trip cleanly that way.
};

/** Attach the derived graph projection for serialisation. Never mutates or
 *  stores - the extra keys exist only in the emitted YAML. The hash is
 *  derived from the SAME emitted section (not recomputed from the diagram) so
 *  the save-side hash and section can never disagree. */
function withGraph(d: DiagramState) {
  // Serialize-time asset GC: entries no shape references anymore (deleted
  // image, undone paste) never reach the file. In-memory state keeps the
  // orphans until the next save - harmless, and pruning on every mutation
  // would fight the undo stack.
  const pruned = pruneAssets(d);
  const graph = buildGraphSection(pruned);
  return { ...pruned, graph, graphHash: graphDigestForEntries(graph) };
}

/** Serialise the diagram. Note we do NOT write the editor's UI state (zoom,
 *  pan, theme, selection) into the file - those are session-local. */
export function diagramToYaml(d: DiagramState): string {
  return YAML.stringify(withGraph(d), null, STRINGIFY_OPTS);
}

/** Serialise a multi-tab workspace. Always written by the editor's save
 *  path now that tabs exist; legacy single-diagram files still load via
 *  parseWorkspace's backward-compat branch. */
export function workspaceToYaml(w: WorkspacePayload): string {
  parseWorkspace({ version: 'workspace-1.0', ...w });
  return YAML.stringify(
    {
      version: 'workspace-1.0',
      activeTabId: w.activeTabId,
      tabs: w.tabs.map((t) => ({ id: t.id, diagram: withGraph(t.diagram) })),
    },
    null,
    STRINGIFY_OPTS,
  );
}

/** Parse a YAML file back to a DiagramState. Throws on malformed YAML or
 *  schema-invalid contents; the caller surfaces the error to the user.
 *
 *  Single-diagram entry point. Newer code should prefer `yamlToWorkspace`
 *  which transparently accepts both formats - this helper is kept for
 *  paste/import paths that are diagram-only. */
export function yamlToDiagram(text: string): DiagramState {
  const parsed = YAML.parse(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Not a Vellum YAML file (expected a top-level object)');
  }
  if (!('version' in parsed)) {
    throw new Error('Not a Vellum YAML file (missing version)');
  }
  const d = parseDiagram(parsed);
  // The schema strips graph/graphHash (they're a projection, not state), so
  // reconciliation reads them from the raw parse. See store/graph.ts.
  const raw = parsed as { graph?: unknown; graphHash?: unknown };
  applyGraphSection(d, raw.graph, raw.graphHash);
  return d;
}

/** Parse a YAML file back to a multi-tab workspace. Accepts both the new
 *  workspace format AND legacy single-diagram files (wrapped into a
 *  one-tab workspace). This is the loader the editor's file-open path
 *  uses now that tabs exist. */
export function yamlToWorkspace(text: string): WorkspacePayload {
  const parsed = YAML.parse(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Not a Vellum YAML file (expected a top-level object)');
  }
  const w = parseWorkspace(parsed);
  // Reconcile each tab's graph section from the raw parse (the schema strips
  // it - projection, not state). parseWorkspace preserves tab order, and the
  // legacy single-diagram branch maps the top-level object to the one tab.
  const raw = parsed as {
    version?: unknown;
    graph?: unknown;
    graphHash?: unknown;
    tabs?: { diagram?: { graph?: unknown; graphHash?: unknown } }[];
  };
  for (let i = 0; i < w.tabs.length; i++) {
    const rawDiagram =
      raw.version === 'workspace-1.0' ? raw.tabs?.[i]?.diagram : raw;
    if (rawDiagram) {
      applyGraphSection(w.tabs[i].diagram, rawDiagram.graph, rawDiagram.graphHash);
    }
  }
  return w;
}

/** File handle returned by File System Access API. We hold onto it so subsequent
 *  saves write back to the same file. */
type SaveHandle = FileSystemFileHandle;

/** Is this an image that may carry an embedded `.vellum` source? Vellum's
 *  PNG / SVG exports do (editor/export/source.ts); the Open dialog accepts
 *  them and restores the diagram instead of failing on "not YAML". */
function isEditableImageFile(file: File): boolean {
  return (
    /\.(png|svg)$/i.test(file.name) ||
    file.type === 'image/png' ||
    file.type === 'image/svg+xml'
  );
}

/** Parse any file the Open dialog accepts into a workspace. */
export async function workspaceFromFile(file: File): Promise<WorkspacePayload> {
  if (isEditableImageFile(file)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const source = extractEmbeddedSource(bytes);
    if (!source) {
      throw new Error(
        'This image has no embedded Vellum diagram. Export from Vellum with "Include full editable document" switched on to get an image that reopens as a diagram.',
      );
    }
    return yamlToWorkspace(source);
  }
  return yamlToWorkspace(await file.text());
}

/** Suggested `.vellum` path for an opened file - images lose their
 *  extension so a later Save doesn't offer to overwrite the picture. */
function openedFilePath(file: File): string {
  return isEditableImageFile(file) ? file.name.replace(/\.(png|svg)$/i, '') + '.vellum' : file.name;
}

/** Open a file picker and load a Vellum YAML - or a PNG / SVG that Vellum
 *  exported with its source embedded. Returns null if the user cancels.
 *  Falls back to a hidden <input type="file"> in browsers without FSA
 *  support.
 *
 *  Returns a workspace (one or more tabs). Legacy single-diagram files are
 *  wrapped into a one-tab workspace at parse time - see `parseWorkspace`. */
export async function openVellumFile(): Promise<{
  workspace: WorkspacePayload;
  filePath: string;
  handle: SaveHandle | null;
} | null> {
  if (typeof window !== 'undefined' && 'showOpenFilePicker' in window) {
    try {
      const [h] = await (
        window as unknown as {
          showOpenFilePicker: (opts: object) => Promise<SaveHandle[]>;
        }
      ).showOpenFilePicker({
        types: [
          {
            description: 'Vellum diagram',
            accept: {
              // Canonical extension is `.vellum`. Bytes are YAML, so we still
              // accept `.yaml`/`.yml` (and legacy `.vellum.yaml`) to keep old
              // files openable, but the "correct" name is now bare `.vellum`.
              'application/x-yaml': ['.vellum', '.vellum.yaml', '.yaml', '.yml'],
            },
          },
          {
            description: 'Image exported from Vellum (with embedded diagram)',
            accept: { 'image/png': ['.png'], 'image/svg+xml': ['.svg'] },
          },
        ],
        multiple: false,
      });
      const file = await h.getFile();
      const image = isEditableImageFile(file);
      return {
        workspace: await workspaceFromFile(file),
        filePath: openedFilePath(file),
        // Never hand back a handle to a picture: Save would overwrite the
        // PNG with YAML. The next Save prompts for a `.vellum` location.
        handle: image ? null : h,
      };
    } catch (err) {
      // AbortError = user cancelled; everything else is an actual error.
      if ((err as DOMException)?.name === 'AbortError') return null;
      throw err;
    }
  }

  // Fallback: <input type="file">
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.vellum,.vellum.yaml,.yaml,.yml,.png,.svg';
    input.oncancel = () => resolve(null);
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        resolve({
          workspace: await workspaceFromFile(file),
          filePath: openedFilePath(file),
          handle: null,
        });
      } catch (err) {
        reject(err);
      }
    };
    input.click();
  });
}

/** Save the active workspace (all tabs) to the existing handle, or prompt
 *  for a new one. Returns the handle used so callers can cache it for next
 *  time. Always writes the multi-tab workspace format - single-tab cases
 *  produce a `tabs:` array of length 1. */
export type SaveResult = { status: 'saved'; filePath: string; handle: SaveHandle | null } | { status: 'cancelled' } | { status: 'downloaded' };

export type SaveDestination = { status: 'ready'; handle: SaveHandle | null } | { status: 'cancelled' };

/** Request the destination in the initiating click, before waiting on other writes. */
export async function requestSaveDestination(suggestedName: string): Promise<SaveDestination> {
  if (typeof window === 'undefined' || !('showSaveFilePicker' in window)) return { status: 'ready', handle: null };
  try {
    const handle = await (window as unknown as {
      showSaveFilePicker: (opts: object) => Promise<SaveHandle>;
    }).showSaveFilePicker({
      suggestedName,
      types: [{ description: 'Vellum diagram', accept: { 'application/x-yaml': ['.vellum'] } }],
    });
    return { status: 'ready', handle };
  } catch (error) {
    if ((error as DOMException)?.name === 'AbortError') return { status: 'cancelled' };
    throw error;
  }
}

let writeQueue: Promise<unknown> = Promise.resolve();

export function saveVellumFile(
  workspace: WorkspacePayload,
  existingHandle: SaveHandle | null,
  suggestedName = 'untitled.vellum',
  preparedDestination?: SaveDestination,
): Promise<SaveResult> {
  // Validate before opening a writer: invalid state must not truncate a file.
  const text = workspaceToYaml(workspace);
  const destination = Promise.resolve(preparedDestination ?? (existingHandle
    ? { status: 'ready' as const, handle: existingHandle }
    : requestSaveDestination(suggestedName))).then(
    (value) => ({ value }), (error: unknown) => ({ error }),
  );
  const write = async (): Promise<SaveResult> => {
    try {
      const picked = await destination;
      if ('error' in picked) throw picked.error;
      if (picked.value.status === 'cancelled') return { status: 'cancelled' };
      const handle = picked.value.handle;
      if (handle) {
        const writable = await handle.createWritable();
        try {
          await writable.write(text);
          await writable.close();
        } catch (error) {
          await writable.abort?.().catch(() => {});
          throw error;
        }
        return { status: 'saved', filePath: handle.name, handle };
      }
      const nativeDownload = typeof window !== 'undefined' && typeof (window as Window & { __vellumSaveBlob?: unknown }).__vellumSaveBlob === 'function';
      if (!await triggerDownload(suggestedName, text, 'application/x-yaml')) return { status: 'cancelled' };
      return nativeDownload ? { status: 'saved', filePath: suggestedName, handle: null } : { status: 'downloaded' };
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') return { status: 'cancelled' };
      // A native write failure must not become an unverified download success.
      throw error;
    }
  };
  const result = writeQueue.then(write, write);
  writeQueue = result.catch(() => {});
  return result;
}

export async function triggerDownload(filename: string, text: string, mime: string): Promise<boolean> {
  const blob = new Blob([text], { type: mime });
  const nativeSave = typeof window === 'undefined' ? undefined : (window as Window & {
    __vellumSaveBlob?: (name: string, blob: Blob) => Promise<boolean>;
  }).__vellumSaveBlob;
  if (nativeSave) return nativeSave(filename, blob);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so Firefox actually finishes the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** Session-only destination shared by every tab in the workspace. The handle
 *  stays outside JSON preferences, and a reload requires opening a file again. */
let _activeHandle: SaveHandle | null = null;
export function getActiveHandle(): SaveHandle | null {
  return _activeHandle;
}
export function setActiveHandle(h: SaveHandle | null) {
  _activeHandle = h;
}
