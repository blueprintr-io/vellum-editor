import type { PersistStorage, StorageValue } from 'zustand/middleware';

/** Documents and imported artwork use IndexedDB; small preferences use localStorage. */
export interface RecoveryBackend {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export const RECOVERY_STATUS_EVENT = 'vellum:recovery-status';
let recoveryError: string | null = null;
let pendingWrites = 0;
export const getRecoveryError = () => recoveryError;
export const hasPendingRecoveryWrite = () => pendingWrites > 0;
export function reportRecoveryError(error: unknown) {
  recoveryError = `Browser recovery could not be saved. Keep this window open and use Save As to save a .vellum file. ${error instanceof Error ? error.message : String(error)}`;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(RECOVERY_STATUS_EVENT));
}
function clearRecoveryError() {
  if (!recoveryError) return;
  recoveryError = null;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(RECOVERY_STATUS_EVENT));
}

export function indexedDbRecoveryBackend(): RecoveryBackend {
  let opening: Promise<IDBDatabase> | undefined;
  const open = () => opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('vellum-recovery', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspaces');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opening = undefined; reject(request.error); };
    request.onblocked = () => { opening = undefined; reject(new Error('Recovery database is blocked by another window.')); };
  });
  const transact = async (key: string, mode: IDBTransactionMode, value?: unknown, remove = false) => {
    const db = await open();
    return new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction('workspaces', mode);
      const store = tx.objectStore('workspaces');
      const request = mode === 'readonly' ? store.get(key) : remove ? store.delete(key) : store.put(value, key);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? request.error ?? new Error('Recovery write failed.'));
    });
  };
  return {
    read: (key) => transact(key, 'readonly'),
    write: async (key, value) => { await transact(key, 'readwrite', value); },
    remove: async (key) => { await transact(key, 'readwrite', undefined, true); },
  };
}

const DOCUMENT_KEYS = new Set(['diagram', 'filePath', 'dirty', 'workspaceRevision', 'savedRevision', 'diagramTabs', 'activeTabId', 'tabSnapshots', 'personalLibrary']);
const sameFields = (a: Record<string, unknown> | undefined, b: Record<string, unknown>) =>
  !!a && Object.keys(a).length === Object.keys(b).length && Object.keys(b).every((key) => a[key] === b[key]);

/** Failed writes are reported without throwing through an editor mutation. */
export function createRecoveryStorage<T extends object>(
  local: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  backend?: RecoveryBackend,
): PersistStorage<T> & { flush(): Promise<void>; protect(): void; resume(): void } {
  let lastDocuments: Record<string, unknown> | undefined;
  let lastPreferences: Record<string, unknown> | undefined;
  let pending: { name: string; value: StorageValue<T> } | undefined;
  let queue: Promise<void> = Promise.resolve();
  let writing = false;
  let readFailed = false;
  return {
    protect() { readFailed = true; },
    resume() { readFailed = false; },
    getItem(name) {
      if (!backend) {
        try { const raw = local.getItem(name); return raw ? JSON.parse(raw) : null; }
        catch (error) { readFailed = true; reportRecoveryError(error); return null; }
      }
      return (async () => {
        try {
          await queue;
          const stored = await backend.read(name) as StorageValue<T> | undefined;
          let preferences: StorageValue<T> | undefined;
          try {
            const prefRaw = local.getItem(`${name}.preferences`);
            preferences = prefRaw ? JSON.parse(prefRaw) : undefined;
          } catch (error) { reportRecoveryError(error); }
          readFailed = false;
          if (stored) return { ...stored, state: { ...preferences?.state, ...stored.state } };
          const legacy = local.getItem(name);
          return legacy ? JSON.parse(legacy) : preferences ?? null;
        } catch (error) {
          // Keep an unreadable database untouched until recovery succeeds.
          readFailed = true;
          reportRecoveryError(error);
          return null;
        }
      })();
    },
    setItem(name, value) {
      if (readFailed) return;
      if (!backend) {
        try {
          const state = value.state as Record<string, unknown>;
          if (sameFields(lastDocuments, state)) return;
          local.setItem(name, JSON.stringify(value));
          lastDocuments = state;
          clearRecoveryError();
        } catch (error) { reportRecoveryError(error); }
        return;
      }
      pending = { name, value };
      if (writing) return queue;
      writing = true;
      pendingWrites++;
      queue = queue.then(async () => {
        try { while (pending) {
          const next = pending;
          pending = undefined;
          const documents: Record<string, unknown> = {};
          const preferences: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(next.value.state)) (DOCUMENT_KEYS.has(key) ? documents : preferences)[key] = value;
          try {
            if (!sameFields(lastDocuments, documents)) {
              await backend.write(next.name, { state: documents, version: next.value.version });
              lastDocuments = documents;
            }
            if (!sameFields(lastPreferences, preferences)) {
              local.setItem(`${next.name}.preferences`, JSON.stringify({ state: preferences, version: next.value.version }));
              lastPreferences = preferences;
            }
            // Remove the legacy full-document copy only after durable migration.
            local.removeItem(next.name);
            if (next.name === 'vellum.editor') local.removeItem('vellum.diagram.backup');
            clearRecoveryError();
          } catch (error) { reportRecoveryError(error); }
        } } finally { writing = false; pendingWrites--; }
      });
      return queue;
    },
    async removeItem(name) {
      await queue;
      try {
        await backend?.remove(name);
        local.removeItem(name);
        local.removeItem(`${name}.preferences`);
        lastDocuments = lastPreferences = undefined;
      } catch (error) { reportRecoveryError(error); }
    },
    flush: () => queue,
  };
}

const safeLocal = {
  getItem: (key: string) => typeof localStorage === 'undefined' ? null : localStorage.getItem(key),
  setItem: (key: string, value: string) => { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); },
  removeItem: (key: string) => { if (typeof localStorage !== 'undefined') localStorage.removeItem(key); },
};
export const recoveryStorage = createRecoveryStorage(safeLocal, typeof indexedDB === 'undefined' ? undefined : indexedDbRecoveryBackend());
