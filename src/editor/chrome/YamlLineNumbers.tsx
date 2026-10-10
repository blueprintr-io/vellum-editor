import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';

/** Decorative logical line numbers. A clipped mirror gives each number the
 * same height as its soft-wrapped textarea line without changing the source. */
export function YamlLineNumbers({ text, textareaRef }: {
  text: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => text.split('\n'), [text]);
  const gutterWidth = `calc(${Math.max(3, String(lines.length).length)}ch + 1.5rem)`;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!textarea || !mirror) return;
    let disposed = false;
    const syncScroll = () => {
      mirror.style.transform = `translateY(-${textarea.scrollTop}px)`;
    };
    const measure = () => {
      if (disposed) return;
      const style = getComputedStyle(textarea);
      for (const property of [
        'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch',
        'line-height', 'letter-spacing', 'word-spacing', 'tab-size',
        'white-space', 'overflow-wrap', 'word-break', 'padding',
      ]) {
        mirror.style.setProperty(property, style.getPropertyValue(property));
      }
      mirror.style.width = `${textarea.clientWidth}px`;
      mirror.style.setProperty('--yaml-text-padding', style.paddingLeft);
      syncScroll();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(textarea);
    textarea.addEventListener('scroll', syncScroll, { passive: true });
    void document.fonts.ready.then(measure);
    return () => {
      disposed = true;
      observer.disconnect();
      textarea.removeEventListener('scroll', syncScroll);
    };
  }, [textareaRef]);

  // Text edits can clamp scrollTop without resizing the textarea.
  useLayoutEffect(() => {
    if (mirrorRef.current && textareaRef.current) {
      mirrorRef.current.style.transform = `translateY(-${textareaRef.current.scrollTop}px)`;
    }
  }, [text, textareaRef]);

  return (
    <div data-testid="yaml-line-numbers" aria-hidden="true"
      className="relative order-first shrink-0 overflow-hidden border-r border-border bg-bg-subtle select-none pointer-events-none"
      style={{ width: gutterWidth }}>
      <div ref={mirrorRef} className="absolute top-0 box-border"
        style={{ left: '100%', visibility: 'hidden' }}>
        {lines.map((line, i) => (
          <div key={i} className="relative">
            <span data-line-number={i + 1} className="absolute top-0 pr-3 text-right text-fg-muted/60"
              style={{
                right: 'calc(100% + var(--yaml-text-padding, 12px))',
                width: gutterWidth,
                visibility: 'visible',
              }}>{i + 1}</span>
            {line || '\u200b'}
          </div>
        ))}
      </div>
    </div>
  );
}
