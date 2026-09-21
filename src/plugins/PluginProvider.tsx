// React context that carries the consumer-supplied plugins array down to the
// slot consumers (Brand, Actions, ContextMenu). Plugins are NOT stored in the
// Zustand store: they contain non-serializable React nodes/functions and the
// store is persisted to localStorage. Context is the right home.

import {
  Component,
  createContext,
  useContext,
  useMemo,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import type { VellumPlugin } from './types';

const PluginContext = createContext<readonly VellumPlugin[]>([]);

export interface PluginProviderProps {
  plugins?: readonly VellumPlugin[];
  children: ReactNode;
}

export function PluginProvider({ plugins, children }: PluginProviderProps) {
  const stable = useMemo(() => plugins ?? [], [plugins]);

  // Dev-only: warn on duplicate ids. Duplicates would silently render twice
  // and confuse plugin-author debugging.
  if (import.meta.env?.DEV) {
    const seen = new Set<string>();
    for (const p of stable) {
      if (seen.has(p.id)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[vellum-editor] duplicate plugin id "${p.id}" - second instance will still render but ids should be unique`,
        );
      }
      seen.add(p.id);
    }
  }

  return (
    <PluginContext.Provider value={stable}>{children}</PluginContext.Provider>
  );
}

/** Returns the current plugin props, including updates under existing IDs. */
export function usePlugins(): readonly VellumPlugin[] {
  return useContext(PluginContext);
}

/** Invoke contribution callbacks below the error boundary so render failures
 * are contained to the affected slot. Event-handler failures are not caught. */
function SlotContent({ contribution }: { contribution: ReactNode | (() => ReactNode) }) {
  return <>{typeof contribution === 'function' ? contribution() : contribution}</>;
}

export function PluginSlot({ pluginId, slot, contribution }: {
  pluginId: string; slot: string; contribution: ReactNode | (() => ReactNode);
}) {
  return <PluginSlotBoundary pluginId={pluginId} slot={slot} resetKey={contribution}>
    <SlotContent contribution={contribution} />
  </PluginSlotBoundary>;
}

export class PluginSlotBoundary extends Component<
  { pluginId: string; slot: string; children: ReactNode; resetKey?: unknown },
  { failed: boolean; resetKey?: unknown }
> {
  state: { failed: boolean; resetKey?: unknown } = { failed: false, resetKey: this.props.resetKey };
  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { resetKey?: unknown }) {
    return props.resetKey !== state.resetKey ? { failed: false, resetKey: props.resetKey } : null;
  }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[vellum-editor] plugin "${this.props.pluginId}" failed in slot "${this.props.slot}".`, error, info);
  }
  render() { return this.state.failed ? null : this.props.children; }
}
