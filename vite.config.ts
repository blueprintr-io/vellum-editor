import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => ({
  // Relative base so dist/index.html works under file:// (Electron/desktop build).
  // Harmless for the web build since assets are served from the same origin.
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // Browser regressions run against one app build, even while source is edited.
    watch: mode === 'e2e' ? null : undefined,
  },
}));
