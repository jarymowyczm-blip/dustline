import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base => the production build works from any sub-path
  // (GitHub Pages project sites, itch.io zips, file servers, ...).
  base: './',
  server: {
    open: true,
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 3000,
  },
});
