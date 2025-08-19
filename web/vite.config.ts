import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      autosheet: path.resolve(__dirname, '../src/index.js')
    }
  },
  server: {
    port: 5173,
    fs: {
      allow: [
        // Allow serving files from the project root
        path.resolve(__dirname, '..')
      ]
    }
  }
});


