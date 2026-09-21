import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { workspaceFromFile } from '../src/store/persist';

for (const name of ['legacy.vellum', 'editable-before-review.png', 'editable-before-review.svg']) {
  test(`opens fixed compatibility fixture ${name}`, async () => {
    const bytes = readFileSync(new URL(`./fixtures/compatibility/${name}`, import.meta.url));
    const workspace = await workspaceFromFile(new File([bytes], name));
    assert.equal(workspace.tabs.length, 1);
    assert.equal(workspace.activeTabId, workspace.tabs[0].id);
    const diagram = workspace.tabs[0].diagram;
    assert.equal(diagram.version, '1.0');
    assert.equal(diagram.meta?.title, 'Compatibility diagram');
    assert.equal(diagram.shapes.length, 1);
    assert.equal(diagram.shapes[0].id, 'old-rect');
    assert.equal(diagram.shapes[0].label, 'Saved before workspace tabs');
    assert.equal(diagram.shapes[0].w, 120);
  });
}
