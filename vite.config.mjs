import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import { notBundle } from 'vite-plugin-electron/plugin';
import { builtinModules, createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');
const externalPackages = new Set([
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`),
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
]);

export default defineConfig({
  plugins: [
    react(),
    electron({
      entry: 'main/index.js',
      onstart(args) {
        // Prevent default startup to avoid duplicate Electron instances
        console.log('Vite-plugin-electron: Startup managed by start-electron-dev.js');
      },
      vite: {
        plugins: [notBundle({ filter: [...externalPackages] })],
      },
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  }
});
