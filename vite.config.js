import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({ root: 'studio', plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': 'http://127.0.0.1:8797' } },
  build: { outDir: '../dist', emptyOutDir: true } });
