/* Document-scoped attributions.
 *
 * Walks the current diagram and renders one notice per vendor + one per
 * iconify collection actually present. Mounted by AttributionsButton in the
 * GlobalDock; can also be reused by an export pipeline as a footer band
 * (`compact` prop).
 *
 * Renders nothing if the document contains no attributable icons. */

import { useMemo } from 'react';
import { useEditor } from '@/store/editor';
import { collectAttributions, hasAttributableIcons } from '@/icons/attribution';
import { useManifest } from '@/icons/manifest';

type Props = {
  /** When true, render in a compact "footer band" mode for exports - single
   *  paragraph per attribution, no headings. Default false (full panel). */
  compact?: boolean;
};

export function AttributionsPanel({ compact = false }: Props) {
  const diagram = useEditor((s) => s.diagram);
  const manifest = useManifest();
  const attributions = useMemo(() => collectAttributions(diagram), [diagram]);

  // Holder → per-vendor trademark notice from the manifest. The
  // attribution stamp on each shape only carries the holder string and
  // the guidelines URL; the *notice text* is in the manifest so it can
  // be updated centrally when a vendor's guidelines change. Until the
  // manifest finishes loading we fall back to a generic line (same as
  // before this lookup landed) so the panel renders without flicker.
  const noticeFor = useMemo(() => {
    const map = new Map<string, string>();
    if (manifest) {
      for (const v of Object.values(manifest.vendors)) {
        if (v.trademark?.holder && v.trademark.notice) {
          map.set(v.trademark.holder, v.trademark.notice);
        }
      }
    }
    return map;
  }, [manifest]);
  const FALLBACK_NOTICE =
    "Trademark used in accordance with the holder's brand guidelines.";

  if (!hasAttributableIcons(diagram)) return null;

  if (compact) {
    return (
      <div className="text-[9px] text-fg-muted leading-relaxed font-body">
        {attributions.vendors.map((v) => (
          <div key={v.holder}>
            <strong className="font-semibold">{v.holder}</strong> -{' '}
            {noticeFor.get(v.holder) ?? FALLBACK_NOTICE}
          </div>
        ))}
        {attributions.collections.map((c) => (
          <div key={c.prefix}>
            Icons from <strong className="font-semibold">{c.prefix}</strong> by{' '}
            {c.holder} ({c.license}).
          </div>
        ))}
      </div>
    );
  }

  return (
    <section className="text-[12px] text-fg leading-relaxed font-body">
      {attributions.vendors.length > 0 && (
        <div className="mb-4">
          <h4 className="text-[10px] font-mono text-fg-muted tracking-[0.04em] uppercase mb-2">
            Trademark Notices
          </h4>
          {attributions.vendors.map((v) => (
            <p key={v.holder} className="mb-2">
              <strong className="font-semibold">{v.holder}</strong>
              {v.count > 1 && (
                <span className="text-fg-muted text-[10px] font-mono ml-1">
                  ({v.count} icons)
                </span>
              )}
              <br />
              {/* The notice text comes from the manifest; we don't paraphrase. */}
              <span className="text-fg-muted">
                {noticeFor.get(v.holder) ?? FALLBACK_NOTICE}
              </span>{' '}
              {v.guidelinesUrls.map((u) => (
                <a
                  key={u}
                  href={u}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-accent text-[11px]"
                >
                  Brand guidelines
                </a>
              ))}
            </p>
          ))}
        </div>
      )}
      {attributions.collections.length > 0 && (
        <div className="mb-2">
          <h4 className="text-[10px] font-mono text-fg-muted tracking-[0.04em] uppercase mb-2">
            Icon Sets
          </h4>
          {attributions.collections.map((c) => (
            <p key={c.prefix} className="mb-1">
              <strong className="font-semibold">{c.prefix}</strong> - {c.holder}
              <span className="text-fg-muted ml-2 font-mono text-[11px]">
                {c.license}
              </span>
              {c.sourceUrl && (
                <>
                  {' · '}
                  <a
                    href={c.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-accent text-[11px]"
                  >
                    license
                  </a>
                </>
              )}
              {c.count > 1 && (
                <span className="text-fg-muted text-[10px] font-mono ml-1">
                  ({c.count})
                </span>
              )}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
