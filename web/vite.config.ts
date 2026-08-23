import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The built site is served by the door server's own Express from
 * dist/web, on the same origin as the API - so there is no CORS in
 * front of the UI, and one container ships both.
 */
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    // `npm run dev` here talks to a door server running on :3010.
    proxy: { '/api': { target: 'http://localhost:3010', changeOrigin: true } },
  },
});
