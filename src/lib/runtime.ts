// True when running inside the Tauri desktop shell. The desktop build
// must not make any network requests; gate any `fetch` callsites on this.
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** True only when running on macOS desktop. Used to pad floating UI clear of
 *  the macOS traffic-lights overlay (top-left, ~80×28px). Returns false in
 *  the web build and on Windows/Linux desktop. */
export function isMacDesktop(): boolean {
  if (!isDesktop()) return false;
  return navigator.userAgent.includes('Macintosh');
}

/** True when running on a Mac in any context (web OR desktop). Use this for
 *  user-facing keyboard-shortcut hints - the modifier the user actually
 *  presses (⌘ vs Ctrl) depends on their OS, not on whether they're in the
 *  Tauri shell. `isMacDesktop` is the wrong gate for that and produces "Ctrl"
 *  hints on macOS Safari / Chrome. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  // navigator.platform is deprecated but still the most reliable signal -
  // userAgentData.platform isn't in Safari yet. Fall back to userAgent.
  const p = navigator.platform || '';
  if (/Mac|iPhone|iPad|iPod/i.test(p)) return true;
  return /Macintosh/.test(navigator.userAgent || '');
}

/** True only when running on Windows desktop (any Tauri shell). Returns
 *  false in the web build and on macOS/Linux desktop. Do NOT use this to
 *  pad for caption buttons - Vellum Core keeps the native title bar on
 *  Windows; see `hasShellCaptionStrip`. */
export function isWindowsDesktop(): boolean {
  if (!isDesktop()) return false;
  return navigator.userAgent.includes('Windows');
}

/** True when the hosting desktop shell draws its own minimize / maximize /
 *  close cluster along the top edge (a frameless window). Only the
 *  Blueprintr desktop shell does that, on Windows and Linux; it exposes its
 *  bridge as `window.__bv__` from an init script that runs before any page
 *  script, so this is stable from the first render. Vellum Core's windows
 *  are decorated by the OS on Windows/Linux, so floating chrome must not
 *  reserve room for buttons that aren't there. */
export function hasShellCaptionStrip(): boolean {
  if (!isDesktop() || isMacDesktop()) return false;
  return '__bv__' in window;
}

/** True when running on Windows in any context (web OR desktop). Companion to
 *  `isMac` for user-facing modifier-key hints. */
export function isWindows(): boolean {
  if (typeof navigator === 'undefined') return false;
  const p = navigator.platform || '';
  if (/Win/i.test(p)) return true;
  return /Windows/i.test(navigator.userAgent || '');
}

/** True when running on Linux in any context (web OR desktop). We exclude
 *  Android (which reports "Linux" in the UA) since its modifier story differs
 *  and Vellum targets desktop Linux. Companion to `isMac` / `isWindows`. */
export function isLinux(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (isMac() || isWindows()) return false;
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return false;
  const p = navigator.platform || '';
  return /Linux|X11/i.test(p) || /Linux|X11/i.test(ua);
}

/** OS-appropriate label for the "command" modifier - the key chord shortcuts
 *  and the cmd/ctrl-drag duplicate use. ⌘ on macOS, Ctrl on Windows/Linux.
 *  Centralised here so every hint surface (TipToast, TipsButton, menus) reads
 *  the same value and the per-OS branch is in one place. */
export function modLabel(): string {
  return isMac() ? '⌘' : 'Ctrl';
}

/** OS-appropriate label for the Option/Alt modifier - used by the "place
 *  without snapping" / "rotate freely" gesture hints. macOS users call it
 *  Option (⌥); Windows/Linux call it Alt. */
export function altLabel(): string {
  return isMac() ? '⌥opt' : 'Alt';
}

/** OS-appropriate label for the Shift modifier. macOS pairs the glyph with the
 *  word (⇧shift); Windows/Linux just say Shift. Shift is the same physical key
 *  everywhere - the glyph is purely cosmetic - but matching the platform's
 *  visual vocabulary keeps the hints feeling native. */
export function shiftLabel(): string {
  return isMac() ? '⇧shift' : 'Shift';
}
