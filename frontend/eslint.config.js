import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist', 'coverage', 'node_modules']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: { globals: globals.browser },
    rules: {
      // Nada de log: senha, token e cabeçalho Authorization nunca podem ir para o console.
      'no-console': 'error',
      // O Access Token fica somente em memória (DT-07).
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'O token não pode ser persistido (DT-07).' },
        { name: 'sessionStorage', message: 'O token não pode ser persistido (DT-07).' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'localStorage',
          message: 'O token não pode ser persistido (DT-07).',
        },
        {
          object: 'window',
          property: 'sessionStorage',
          message: 'O token não pode ser persistido (DT-07).',
        },
      ],
    },
  },
]);
