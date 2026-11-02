import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/dist', '**/coverage', 'apps/api/src/generated'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['apps/api/**/*.ts', 'packages/**/*.ts', '**/*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    // Fronteira do módulo de atribuição: tickets/ e users/ dependem dele, nunca o contrário.
    files: ['apps/api/src/assignment/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/tickets/**', '**/users/**'],
              message: 'assignment/ não importa tickets/ nem users/: eles é que dependem dele.',
            },
          ],
        },
      ],
    },
  },
  {
    // Fronteira do SLA: regras puras que tickets/ usa; nunca o contrário.
    files: ['apps/api/src/sla/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/tickets/**', '**/assignment/**', '**/users/**'],
              message:
                'sla/ não importa tickets/, assignment/ nem users/: eles é que dependem dele.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  prettier,
);
