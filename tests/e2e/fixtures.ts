import { test as base } from '@playwright/test';
export { expect, type Page } from '@playwright/test';

export const test = base.extend({
  page: async ({ page }, use) => {
    const ready = () => page.waitForFunction(() => {
      const editor = window.__VELLUM_TEST__?.modules['/src/store/editor.ts'].useEditor;
      return editor?.persist.hasHydrated();
    });
    const goto = page.goto.bind(page);
    page.goto = async (...args) => {
      const response = await goto(...args);
      await ready();
      return response;
    };
    const reload = page.reload.bind(page);
    page.reload = async (...args) => {
      const response = await reload(...args);
      await ready();
      return response;
    };
    await use(page);
  },
});
