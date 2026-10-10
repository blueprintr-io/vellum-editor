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
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!anyTabDirty()) return;
      timer = setTimeout(() => {
        void saveCurrentWorkspace('autosave').catch((error) => {
          console.error('autosave failed', error);
          notify(`Autosave failed: ${error instanceof Error ? error.message : String(error)}. Use Save As to save your changes.`, { tone: 'warning', ttl: 15000 });
        });
      }, AUTOSAVE_DEBOUNCE_MS);
    };
    // Live gestures advance the revision on every move. Observe them without
    // re-rendering the editor shell (and all of its chrome) just to reset a timer.
    const unsubscribe = useEditor.subscribe((state, previous) => {
      if (state.workspaceRevision !== previous.workspaceRevision ||
        state.workspaceId !== previous.workspaceId) schedule();
    });
    schedule();
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);

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
