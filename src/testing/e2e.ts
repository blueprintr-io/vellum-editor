import * as module0 from '../editor/canvas-export';
import * as module1 from '../editor/canvas/projection';
import * as module2 from '../editor/canvas/routing';
import * as module3 from '../editor/canvas/silhouette';
import * as module4 from '../editor/export/binary';
import * as module5 from '../editor/export/source';
import * as module6 from '../editor/files';
import * as module7 from '../editor/insert';
import * as module8 from '../editor/notation/catalog';
import * as module9 from '../editor/notation/geometry';
import * as module10 from '../editor/rack/catalog';
import * as module11 from '../editor/rack/model';
import * as module12 from '../fixtures/render-pipeline';
import * as module13 from '../store/editor';
import * as module14 from '../store/persist';
import * as module15 from '../store/schema';

export const modules = {
  '/src/editor/canvas-export.ts': module0,
  '/src/editor/canvas/projection.ts': module1,
  '/src/editor/canvas/routing.ts': module2,
  '/src/editor/canvas/silhouette.ts': module3,
  '/src/editor/export/binary.ts': module4,
  '/src/editor/export/source.ts': module5,
  '/src/editor/files.ts': module6,
  '/src/editor/insert.ts': module7,
  '/src/editor/notation/catalog.ts': module8,
  '/src/editor/notation/geometry.ts': module9,
  '/src/editor/rack/catalog.ts': module10,
  '/src/editor/rack/model.ts': module11,
  '/src/fixtures/render-pipeline.ts': module12,
  '/src/store/editor.ts': module13,
  '/src/store/persist.ts': module14,
  '/src/store/schema.ts': module15,
};

declare global {
  interface Window {
    __VELLUM_TEST__?: { modules: typeof modules };
  }
}

window.__VELLUM_TEST__ = { modules };
