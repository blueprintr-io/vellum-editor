import { useEffect } from 'react';
import { useEditor } from '@/store/editor';
import { anyTabDirty, saveCurrentWorkspace } from '@/store/workspace-session';
import { getRecoveryError, hasPendingRecoveryWrite } from '@/store/recovery-storage';
import { notify } from './notify';

export const AUTOSAVE_DEBOUNCE_MS = 1500;

/** Watch every workspace revision, including background edits and tab changes. */
let unsavedChangesPrompt = true;

/** Hosts that save the document themselves can turn off the leave-page prompt. */
export function setUnsavedChangesPrompt(enabled: boolean) {
  unsavedChangesPrompt = enabled;
}

export function useAutosave() {
  const revision = useEditor((s) => s.workspaceRevision);
  const identity = useEditor((s) => s.workspaceId);
  useEffect(() => {
    if (!anyTabDirty()) return;
    const timer = setTimeout(() => {
      void saveCurrentWorkspace('autosave').catch((error) => {
        console.error('autosave failed', error);
        notify(`Autosave failed: ${error instanceof Error ? error.message : String(error)}. Use Save As to save your changes.`, { tone: 'warning', ttl: 15000 });
      });
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [revision, identity]);

  useEffect(() => {
    const onUnload = (event: BeforeUnloadEvent) => {
      if (!unsavedChangesPrompt) return;
      // Async recovery writes cannot be guaranteed after a page has closed.
      if (anyTabDirty() || getRecoveryError() || hasPendingRecoveryWrite()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);
}
