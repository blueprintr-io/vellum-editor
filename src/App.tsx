import { Editor } from './editor/Editor';
import { DiagramTabsBar } from './editor/chrome/DiagramTabsBar';
import type { VellumPlugin } from './plugins/types';

/** Stand-alone Vellum opt-ins. Embedded builds (Blueprintr's overlay
 *  App.tsx, the strata picker iframe) compose their own plugin array and
 *  leave this list out. */
const STANDALONE_PLUGINS: readonly VellumPlugin[] = [
  {
    id: 'vellum-diagram-tabs',
    diagramTabs: <DiagramTabsBar />,
  },
];

export default function App() {
  return <Editor plugins={STANDALONE_PLUGINS} />;
}
