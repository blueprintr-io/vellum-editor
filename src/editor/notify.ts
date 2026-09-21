/* Lightweight transient notices ("Copied PNG to clipboard").
 *
 * Deliberately NOT on the Zustand store: the file-action helpers in
 * files.ts are plain async functions called from menus, keybindings and
 * embedder plugins, and a notice is fire-and-forget UI feedback rather
 * than editor state. A DOM CustomEvent keeps the helpers store-agnostic
 * and lets a host that renders its own toasts listen on `window` instead
 * of mounting <NoticeToast>. */

export const NOTICE_EVENT = 'vellum:notice';

export type NoticeTone = 'info' | 'success' | 'warning';

export interface NoticeDetail {
  text: string;
  tone: NoticeTone;
  /** Auto-dismiss after this many ms. Default 2400. */
  ttl: number;
}

/** Broadcast a notice. No-op outside a browser (SSR / node tests). */
export function notify(
  text: string,
  opts: { tone?: NoticeTone; ttl?: number } = {},
): void {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  const detail: NoticeDetail = {
    text,
    tone: opts.tone ?? 'info',
    ttl: opts.ttl ?? 2400,
  };
  window.dispatchEvent(new CustomEvent<NoticeDetail>(NOTICE_EVENT, { detail }));
}
