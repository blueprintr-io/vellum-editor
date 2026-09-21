import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

/** True when the user has asked their OS to reduce motion.
 *
 *  CSS animations can be gated declaratively with a
 *  `@media (prefers-reduced-motion: reduce)` block. SVG SMIL animations
 *  (`<animate>` / `<animateTransform>`) CANNOT - no browser applies the media
 *  query to them, and there is no CSS safety net. Every SMIL callsite has to
 *  consult this hook and omit its `<animate*>` children itself. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
