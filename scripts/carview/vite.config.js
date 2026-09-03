import { defineConfig } from 'vite';
export default defineConfig({
  root: '/home/z/my-project/scripts/carview',
  base: './',
  server: { port: 5199, host: true },
  build: { outDir: 'dist' }
});
