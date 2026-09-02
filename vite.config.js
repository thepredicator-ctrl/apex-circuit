import { defineConfig } from 'vite';

// base './' makes the production bundle work from any static host path
// (GitHub Pages project sites, Netlify subfolders, S3, nginx subpaths, ...)
export default defineConfig({
  base: './',
  server: {
    host: true,
    port: 5173,
    strictPort: false
  },
  preview: {
    host: true,
    port: 4173
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500
  }
});
