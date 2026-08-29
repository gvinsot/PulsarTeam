import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          icons: ['lucide-react'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
      // Terminal WebSocket for CLI runners. It authenticates with the session
      // cookie, so it has to come from the same origin as the SPA — proxying
      // it here is what makes the terminal usable under `vite dev`.
      '/ws': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },
});
