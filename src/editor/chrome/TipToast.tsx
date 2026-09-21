import { useEffect, useState } from 'react';
import { useEditor } from '@/store/editor';
import type { TipKey } from '@/store/editor';
import { I } from './icons';
import { modLabel, altLabel, shiftLabel } from '@/lib/runtime';

/** Body copy for every TipKey. `{{mod}}`, `{{alt}}` and `{{shift}}` are
 *  placeholders for the three modifier keys; substitution happens at render
 *  time so the same string ships to every platform (⌘/Ctrl, ⌥opt/Alt,
 *  ⇧shift/Shift - see runtime.ts label helpers).
 *
 *  KEEP TIPS SHORT. The toast is a contextual nudge that is at the
 *  bottom of the canvas while a gesture is in flight; the user can't read
 *  a paragraph mid-drag. Multi-modifier gestures use a compact
 *  "{{key}} action · {{key}} action" list, action-first.
 *
 *  When you add a tip:
 *    1. Add the matching TipKey to `editor.ts` (TipKey union).
 *    2. Add the body line here.
 *    3. Publish the key from wherever the gesture is - usually
 *       `setActiveTipKey(...)` in Canvas.tsx's `setInteraction`.
 *    4. The toast appears + fades out automatically when the key clears. */
const TIP_BODIES: Record<TipKey, string> = {
  'shift-perfect-square': 'Hold {{shift}} to draw a perfect square',
  'shift-perfect-circle': 'Hold {{shift}} to draw a perfect circle',
  'shift-perfect-diamond': 'Hold {{shift}} to draw a perfect diamond',
  'drag-shape': '{{mod}} duplicate · {{alt}} free-place · {{shift}} lock axis',
  'drag-connector': '{{alt}} free-place · {{shift}} lock axis',
  'resize-corner': '{{mod}} from centre · {{alt}} free-resize · {{shift}} lock ratio',
  'resize-edge': '{{mod}} both sides · {{alt}} free-resize · {{shift}} lock ratio',
  'rotate-free': 'Hold {{alt}} to rotate freely',
  'right-click-delete-bend': 'Right click on a bend to delete it',
  'dblclick-group-select': 'Double click to select individual objects in a group',
  'label-edit-newline': '{{shift}}⏎ new line · ⏎ done · Esc cancel',
};

/** Render `body` with each `{{…}}` placeholder substituted for the
 *  platform's modifier label. The Mac labels carry their glyph (⌘ / ⌥opt /
 *  ⇧shift); Windows/Linux render plain words (Ctrl / Alt / Shift). All
 *  render fine inline; no separate <kbd> styling at this level of subtlety. */
function formatTip(body: string): string {
  return body
    .replace(/\{\{mod\}\}/g, modLabel())
    .replace(/\{\{alt\}\}/g, altLabel())
    .replace(/\{\{shift\}\}/g, shiftLabel());
}

/** Fade duration (ms). Matches the mount/unmount timer below - bump both
 *  if you want a slower transition. ~180ms reads as a soft fade without
 *  feeling laggy; under ~120 the pop-in is too sudden. */
const FADE_MS = 180;

/** Contextual nudge that floats above the bottom edge of the canvas while
 *  a gesture is in flight. Reads `activeTipKey` from the store; renders
 *  nothing when the key is null OR when the user has switched tips off in
 *  Customise canvas / hamburger menu.
 *
 *  Fade in/out: when the store's `activeTipKey` flips, the local
 *  `displayed` body state lags behind so the component stays mounted long
 *  enough to fade out. On the way IN, we mount with opacity 0 and switch
 *  to 0.35 on the next frame to trigger the CSS transition. On the way
 *  OUT, we set opacity to 0 immediately and unmount after FADE_MS.
 *
 *  Visual: pill, lightbulb glyph on the left, tip text + a smaller "disable
 *  tips in settings" caption underneath. The pill is wrapped at 35%
 *  opacity - deliberately quiet so it never competes with the canvas
 *  itself. The pill's width follows the content (no fixed min-width), so a
 *  short tip stays small. */
export function TipToast() {
  const tipsEnabled = useEditor((s) => s.tipsEnabled);
  const activeTipKey = useEditor((s) => s.activeTipKey);

  // `displayed` is the body we're CURRENTLY rendering; lags behind the
  // store on the way out so we can play a fade. `visible` drives the
  // CSS transition's target opacity - flips false on hide, then displayed
  // clears after FADE_MS so the component unmounts.
  const [displayed, setDisplayed] = useState<TipKey | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const wantTip = tipsEnabled && activeTipKey != null;
    if (wantTip) {
      // Refresh the body even if the key changed mid-show (one tip → another).
      setDisplayed(activeTipKey);
      // Two-frame delay so the browser commits the initial opacity:0
      // BEFORE we transition to 0.35 - without this the element mounts
      // already at 0.35 and the fade-in is skipped. One rAF works in
      // most browsers but Safari occasionally batches state in a way
      // that drops the transition; double-rAF is the well-known fix.
      const r1 = requestAnimationFrame(() => {
        const r2 = requestAnimationFrame(() => setVisible(true));
        return () => cancelAnimationFrame(r2);
      });
      return () => cancelAnimationFrame(r1);
    } else {
      // Hide path: drop opacity → wait for fade to finish → unmount.
      setVisible(false);
      const t = setTimeout(() => setDisplayed(null), FADE_MS);
      return () => clearTimeout(t);
    }
  }, [activeTipKey, tipsEnabled]);

  if (displayed == null) return null;
  const body = TIP_BODIES[displayed];
  if (!body) return null;

  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 z-[14] pointer-events-none"
      // Apply 70% opacity to the wrapper so the icon, text and caption
      // fade together and retain the same relative contrast.
      style={{
        opacity: visible ? 0.7 : 0,
        transition: `opacity ${FADE_MS}ms ease`,
        bottom: 'var(--vellum-dock-bottom-tight, 14px)',
      }}
      role="status"
      aria-live="polite"
    >
      <div
        className="inline-flex items-center gap-2 rounded-full border border-border bg-bg/[0.95] backdrop-blur-chrome shadow-[0_2px_8px_rgb(0_0_0_/_0.18)] px-3 py-[6px] text-fg whitespace-nowrap"
      >
        <span className="text-fg-muted shrink-0">
          <I.lightbulb />
        </span>
        <span className="flex flex-col leading-[1.15]">
          <span className="text-[12px] font-medium">{formatTip(body)}</span>
          <span className="text-[9px] font-mono text-fg-muted tracking-[0.02em]">
            disable tips in settings
          </span>
        </span>
      </div>
    </div>
  );
}
