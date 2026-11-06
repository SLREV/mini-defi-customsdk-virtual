import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pinataDevApi } from './scripts/pinataDevApi';

export default defineConfig({
  // pinataDevApi hanya aktif di dev server (apply: 'serve') dan membaca
  // PINATA_JWT dari .env di sisi Node — secret tidak pernah masuk bundle browser.
  plugins: [react(), pinataDevApi()],
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      buffer: 'buffer',
    },
  },
  optimizeDeps: {
    include: ['buffer', '@solana/web3.js', '@solana/buffer-layout'],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
});
