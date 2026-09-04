import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../../python/dolphin_terminal/static',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 8734,
    strictPort: true,
  },
});
