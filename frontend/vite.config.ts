import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// O CORS é responsabilidade do Gateway (reflete a origem), então o servidor de desenvolvimento não precisa de proxy:
// o navegador chama o Gateway diretamente, pela URL em VITE_API_BASE_URL.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
  },
});
