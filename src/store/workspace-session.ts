import { useEditor, type EditorState } from './editor';
import { notify } from '../editor/notify';
import { getActiveHandle, requestSaveDestination, saveVellumFile, setActiveHandle } from './persist';
import { parseWorkspace, type WorkspacePayload } from './schema';

/** Refuse incomplete recovery data instead of saving fabricated blank tabs. */
export function workspaceFromState(s: EditorState = useEditor.getState()): WorkspacePayload {
  return {
    activeTabId: s.exportReturnTabId ?? s.activeTabId,
    tabs: s.diagramTabs.map(({ id }) => {
      const diagram = id === s.activeTabId ? s.diagram : s.tabSnapshots[id]?.diagram;
      if (!diagram) throw new Error(`Tab ${id} has no recovery data. Open your last saved .vellum file or close this missing tab before saving.`);
      return { id, diagram };
    }),
  };
}

export function anyTabDirty(s: EditorState = useEditor.getState()): boolean {
  return s.workspaceRevision !== s.savedRevision || s.dirty || Object.values(s.tabSnapshots).some((snap) => snap.dirty);
}

export function confirmWorkspaceReplacement(): boolean {
  return !anyTabDirty() || confirm('Discard unsaved changes in all tabs?');
}

let saveQueue: Promise<unknown> = Promise.resolve();
/** Serialize Save, Save As, and autosave, and acknowledge the captured revision. */
export async function saveCurrentWorkspace(mode: 'save' | 'save-as' | 'autosave' = 'save') {
  const requestedState = useEditor.getState();
  const requestedIdentity = requestedState.workspaceId;
  const base = requestedState.filePath?.split(/[\\/]/).pop() || 'untitled.vellum';
  const filename = /\.vellum(?:\.ya?ml)?$/i.test(base) ? base : `${base}.vellum`;
  let destination: ReturnType<typeof requestSaveDestination> | undefined;
  if (mode === 'save-as' || (mode === 'save' && !getActiveHandle())) {
    parseWorkspace({ version: 'workspace-1.0', ...workspaceFromState(requestedState) });
    destination = requestSaveDestination(filename);
  }
  // Handle prompt rejection immediately even while an earlier disk write is pending.
  const prepared = destination?.then((value) => ({ value }), (error: unknown) => ({ error }));
  const perform = async () => {
    const picked = await prepared;
    if (picked && 'error' in picked) throw picked.error;
    if (picked?.value.status === 'cancelled') return;
    const state = useEditor.getState();
    if (requestedIdentity !== state.workspaceId) return;
    const handle = mode === 'save-as' ? null : getActiveHandle();
    if (mode === 'autosave' && (!handle || !anyTabDirty(state))) return;
    const workspace = workspaceFromState(state);
    const receipt = { workspaceId: state.workspaceId, revision: state.workspaceRevision, workspace };
    const result = await saveVellumFile(workspace, handle, filename, picked?.value);
    if (result.status === 'cancelled' || useEditor.getState().workspaceId !== receipt.workspaceId) return;
    if (result.status === 'downloaded') {
      notify('Download started. The browser cannot confirm completion, so this workspace remains marked unsaved.', { ttl: 10000 });
      return;
    }
    setActiveHandle(result.handle);
    useEditor.getState().setFilePath(result.filePath);
    useEditor.getState().markSaved(receipt);
  };
  const result = saveQueue.then(perform, perform);
  saveQueue = result.catch(() => {});
  return result;
}
