import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Em desenvolvimento, /api vai para a API local, igual ao rewrite da Vercel em
// produção: o front sempre chama a mesma origem e o cookie de refresh é first-party.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
