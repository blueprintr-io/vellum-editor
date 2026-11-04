/* Icon packs the user added from a file (draw.io library, zip of SVGs,
 * loose SVGs, a built Vellum pack). They join the bundled catalogue in
 * src/icons/manifest.ts, so they show in the Icons tab and in search like
 * any vendor pack, and their icons are inserted the same way.
 *
 * Packs can run to megabytes of SVG, so they live in IndexedDB beside the
 * recovery copy rather than in the preferences store. Every pack is kept
 * under one key and rewritten only when a pack is added or removed. Hosts
 * that replace IndexedDB (the Obsidian plugin) persist that key themselves. */

import { indexedDbRecoveryBackend, type RecoveryBackend } from '@/store/recovery-storage';
import { sanitizeSvg } from '@/lib/sanitize-svg';
import type { VendorPack } from './types';

export type AddedIcon = {
  /** Unique within its pack; the catalogue id is `<pack key>/<id>`. */
  id: string;
  name: string;
  category: string;
  keywords: string[];
  /** Sanitised, with ids and CSS classes scoped to this icon. */
  svg: string;
};

export type AddedIconPack = {
  /** Vendor key in the catalogue. Always starts with ADDED_PACK_PREFIX, so it
   *  can't collide with a bundled pack. */
  key: string;
  name: string;
  /** Version the pack declared, if any. */
  version: string;
  /** File the pack was read from. */
  source: string;
  addedAt: string;
  /** Who the artwork belongs to, when the pack says (a Vellum pack's meta). */
  holder?: string;
  guidelinesUrl?: string;
  icons: AddedIcon[];
};

export const ADDED_PACKS_KEY = 'vellum.iconPacks';
export const ADDED_PACK_PREFIX = 'user-';

type Stored = { version: 1; packs: AddedIconPack[] };

let backend: RecoveryBackend | null | undefined;
let packs: AddedIconPack[] = [];
let loading: Promise<AddedIconPack[]> | null = null;
const listeners = new Set<() => void>();

function storage(): RecoveryBackend | null {
  if (backend === undefined) {
    backend = typeof indexedDB === 'undefined' ? null : indexedDbRecoveryBackend();
  }
  return backend;
}

/** Swap the storage (tests, or a host without IndexedDB). `null` keeps
 *  packs in memory only. Forgets what was loaded. */
export function setAddedPackStorage(next: RecoveryBackend | null): void {
  backend = next;
  packs = [];
  loading = null;
}

const isString = (v: unknown): v is string => typeof v === 'string';

function isIcon(v: unknown): v is AddedIcon {
  const i = v as AddedIcon;
  return (
    !!i &&
    isString(i.id) &&
    isString(i.name) &&
    isString(i.category) &&
    Array.isArray(i.keywords) &&
    i.keywords.every(isString) &&
    isString(i.svg)
  );
}

function isPack(v: unknown): v is AddedIconPack {
  const p = v as AddedIconPack;
  return (
    !!p &&
    isString(p.key) &&
    p.key.startsWith(ADDED_PACK_PREFIX) &&
    isString(p.name) &&
    isString(p.version) &&
    isString(p.source) &&
    isString(p.addedAt) &&
    (p.holder === undefined || isString(p.holder)) &&
    (p.guidelinesUrl === undefined || isString(p.guidelinesUrl)) &&
    Array.isArray(p.icons) &&
    p.icons.every(isIcon)
  );
}

/** Shape check for what comes back from storage. A damaged pack drops only
 *  itself. SVG is sanitised again when a pack is opened. */
function fromStored(value: unknown): AddedIconPack[] {
  const list = (value as Partial<Stored> | undefined)?.packs;
  return Array.isArray(list) ? list.filter(isPack) : [];
}

async function readStored(): Promise<AddedIconPack[]> {
  const store = storage();
  return store ? fromStored(await store.read(ADDED_PACKS_KEY)) : packs;
}

/* Other tabs, and the other editor frames in the Obsidian plugin, hear about
 * a change on this channel and read the packs again. */
let channel: BroadcastChannel | null | undefined;
function changeChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(ADDED_PACKS_KEY);
  if (channel) {
    // Node keeps a process alive while a channel is open; browsers have no unref.
    (channel as BroadcastChannel & { unref?: () => void }).unref?.();
    channel.onmessage = () => {
      readStored().then(
        (list) => {
          packs = list;
          loading = Promise.resolve(list);
          for (const listener of listeners) listener();
        },
        (err) => console.error('reading added icon packs failed', err),
      );
    };
  }
  return channel;
}

/** Read the saved packs once. Later calls return the same promise. */
export function loadAddedPacks(): Promise<AddedIconPack[]> {
  changeChannel();
  loading ??= readStored()
    .catch((err) => {
      console.error('reading added icon packs failed', err);
      return [] as AddedIconPack[];
    })
    .then((list) => {
      packs = list;
      return list;
    });
  return loading;
}

export function getAddedPacks(): readonly AddedIconPack[] {
  return packs;
}

export function getAddedPack(key: string): AddedIconPack | null {
  return packs.find((p) => p.key === key) ?? null;
}

export function onAddedPacksChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function update(change: (list: AddedIconPack[]) => AddedIconPack[]): Promise<void> {
  await loadAddedPacks();
  const store = storage();
  // Read again first, so a pack another window added isn't written over.
  const current = store ? await readStored() : packs;
  const next = change(current);
  if (store) await store.write(ADDED_PACKS_KEY, { version: 1, packs: next } satisfies Stored);
  packs = next;
  for (const listener of listeners) listener();
  changeChannel()?.postMessage('changed');
}

/** Save a pack. One with the same key is replaced in place. */
export async function addIconPack(pack: AddedIconPack): Promise<void> {
  await update((list) =>
    list.some((p) => p.key === pack.key)
      ? list.map((p) => (p.key === pack.key ? pack : p))
      : [...list, pack],
  );
}

export async function removeIconPack(key: string): Promise<void> {
  await update((list) => list.filter((p) => p.key !== key));
}

/** The pack as the catalogue serves it: full ids, and SVG sanitised again
 *  in case the stored copy was edited outside the editor. */
export function addedVendorPack(pack: AddedIconPack): VendorPack {
  return {
    vendor: pack.key,
    version: pack.version,
    icons: pack.icons.map((icon) => ({
      id: `${pack.key}/${icon.id}`,
      vendor: pack.key,
      name: icon.name,
      category: icon.category,
      keywords: icon.keywords,
      svg: sanitizeSvg(icon.svg),
    })),
  };
}

/** Catalogue key for a pack name: "Fortinet" → "user-fortinet". */
export function addedPackKey(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return ADDED_PACK_PREFIX + (slug || 'icons');
}
