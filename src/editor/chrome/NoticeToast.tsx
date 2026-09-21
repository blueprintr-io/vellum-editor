import { useEffect, useRef, useState } from 'react';
import { NOTICE_EVENT, type NoticeDetail } from '@/editor/notify';

/** Transient confirmation pill ("Copied PNG to clipboard") that floats
 *  above the bottom edge of the canvas - same footprint as TipToast, but
 *  driven by `notify()` CustomEvents instead of store state, and fully
 *  opaque because it confirms an action the user just took rather than
 *  nudging them mid-gesture.
 *
 *  One notice at a time; a new one replaces the current one and restarts
 *  the timer. Sits 44px above the tip-toast slot so the two never overlap
 *  when a copy lands while a drag tip is showing. */
const FADE_MS = 160;

export function NoticeToast() {
  const [notice, setNotice] = useState<NoticeDetail | null>(null);
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const clearTimer = useRef<number | null>(null);

  useEffect(() => {
    const onNotice = (e: Event) => {
      const detail = (e as CustomEvent<NoticeDetail>).detail;
      if (!detail?.text) return;
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      if (clearTimer.current) window.clearTimeout(clearTimer.current);
      setNotice(detail);
      setVisible(true);
      hideTimer.current = window.setTimeout(() => {
        setVisible(false);
        clearTimer.current = window.setTimeout(() => setNotice(null), FADE_MS);
      }, detail.ttl);
    };
    window.addEventListener(NOTICE_EVENT, onNotice);
    return () => {
      window.removeEventListener(NOTICE_EVENT, onNotice);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      if (clearTimer.current) window.clearTimeout(clearTimer.current);
    };
  }, []);

  if (!notice) return null;
  const dot =
    notice.tone === 'success'
      ? 'bg-accent'
      : notice.tone === 'warning'
        ? 'bg-sketch'
        : 'bg-fg-muted';
  return (
    <div
      data-chrome="notice-toast"
      className="absolute left-1/2 -translate-x-1/2 z-[14] pointer-events-none"
      style={{
        opacity: visible ? 1 : 0,
        transition: `opacity ${FADE_MS}ms ease`,
        bottom: 'calc(var(--vellum-dock-bottom-tight, 14px) + 44px)',
      }}
      role="status"
      aria-live="polite"
    >
      <div className="inline-flex items-center gap-2 rounded-full border border-border bg-bg/[0.95] backdrop-blur-chrome shadow-[0_2px_8px_rgb(0_0_0_/_0.18)] px-3 py-[6px] text-fg whitespace-nowrap">
        <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${dot}`} aria-hidden="true" />
        <span className="text-[12px] font-medium">{notice.text}</span>
      </div>
    </div>
  );
}
