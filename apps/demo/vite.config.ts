import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = process.env.DEMO_API_PORT || '5178';

// The web dev server (5177) proxies /api to the Fastify backend (5178).
export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: 5177,
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
  },
});
