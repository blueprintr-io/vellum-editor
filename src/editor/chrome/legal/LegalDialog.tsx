// Legal dialog for IP complaints, library credits and terms of service.
// Content is authored in legalContent.tsx separately from the tab layout.
// The matching source documents are legal/credits.md, legal/terms.md and
// legal/ip-complaints.md; keep them aligned with legalContent.tsx.

import { useEffect, useRef, useState } from 'react';
import {
  IpComplaintsContent,
  CreditsContent,
  TermsContent,
} from './legalContent';

type LegalTab = 'ip-complaints' | 'credits' | 'terms';

const TABS: { id: LegalTab; label: string; sub: string }[] = [
  {
    id: 'ip-complaints',
    label: 'IP complaints',
    sub: 'Contact and rights concerns',
  },
  { id: 'credits', label: 'Credits', sub: 'Bundled-library attributions' },
  { id: 'terms', label: 'Terms', sub: 'License and service information' },
];

type Props = {
  open: boolean;
  onClose: () => void;
  /** Optional initial tab - used by deep links from the library picker
   *  ("Report an issue" lands on ip-complaints, "About" lands on credits). */
  initialTab?: LegalTab;
};

export function LegalDialog({ open, onClose, initialTab = 'ip-complaints' }: Props) {
  const [tab, setTab] = useState<LegalTab>(initialTab);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Re-sync tab when the dialog reopens with a different deep link.
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  // Outside click + Escape close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    };
    // Defer to next tick so the click that opened the dialog doesn't
    // immediately close it.
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDoc);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Legal"
    >
      <div
        ref={wrapRef}
        className="float w-[calc(640px*var(--vellum-text-scale,1))] max-w-[92vw] max-h-[80vh] flex flex-col"
      >
        {/* Header - title + close */}
        <div className="flex items-center justify-between px-4 py-[10px] border-b border-border">
          <div className="flex flex-col leading-tight">
            <span className="text-[13px] font-semibold text-fg">Legal</span>
            <span className="text-[10px] font-mono text-fg-muted tracking-[0.04em] uppercase">
              {TABS.find((t) => t.id === tab)?.sub}
            </span>
          </div>
          <button
            onClick={onClose}
            title="Close"
            aria-label="Close"
            className="bg-transparent border-none p-1 text-fg-muted hover:text-fg rounded"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-[2px] px-2 py-[6px] border-b border-border">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-shrink-0 bg-transparent border-none px-[10px] py-[5px] text-[11px] font-medium rounded-[5px] whitespace-nowrap ${
                tab === t.id
                  ? 'text-fg bg-bg-emphasis'
                  : 'text-fg-muted hover:text-fg hover:bg-bg-emphasis'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Body - scrolls; content is plain prose styled with the chrome
         *  type tokens so it matches the editor visual language. */}
        <div className="overflow-y-auto px-5 py-4 text-[12px] leading-relaxed text-fg font-body flex-1">
          {tab === 'ip-complaints' && <IpComplaintsContent />}
          {tab === 'credits' && <CreditsContent />}
          {tab === 'terms' && <TermsContent />}
        </div>
      </div>
    </div>
  );
}
