import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()], root: 'frontend', base: './', clearScreen: false,
  build: { assetsInlineLimit: 0, outDir: '../dist', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
