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
              group: ['**/tickets/**', '**/users/**', '**/jobs/**'],
              message:
                'assignment/ não importa tickets/, users/ nem jobs/: eles é que dependem dele.',
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
              group: ['**/tickets/**', '**/assignment/**', '**/users/**', '**/jobs/**'],
              message:
                'sla/ não importa tickets/, assignment/, users/ nem jobs/: eles é que dependem dele.',
            },
          ],
        },
      ],
    },
  },
  {
    // jobs/ fica no topo: orquestra os outros módulos, e nenhum deles depende dele.
    files: [
      'apps/api/src/tickets/**/*.ts',
      'apps/api/src/users/**/*.ts',
      'apps/api/src/auth/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/jobs/**'],
              message: 'jobs/ depende de tickets/, users/ e auth/, nunca o contrário.',
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
      // Conteúdo de ticket é escrito por usuários: só entra na tela como texto do React.
      // Além do atributo JSX, a prop chega por spread, createElement/jsx() ou atribuição.
      // As APIs do DOM que interpretam HTML (innerHTML, outerHTML, insertAdjacentHTML,
      // setHTMLUnsafe, createContextualFragment, document.write/writeln) também ficam de fora.
      // Chave computada e alias (const d = document) fogem de uma regra sintática.
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Nada de HTML cru: renderize como texto.',
        },
        {
          selector: "Identifier[name='dangerouslySetInnerHTML']",
          message: 'Nada de HTML cru: renderize como texto.',
        },
        {
          selector: "Literal[value='dangerouslySetInnerHTML']",
          message: 'Nada de HTML cru: renderize como texto.',
        },
        {
          selector:
            'MemberExpression > Identifier.property[name=/^(innerHTML|outerHTML|insertAdjacentHTML|setHTMLUnsafe|createContextualFragment)$/]',
          message: 'Nada de HTML cru: renderize como texto.',
        },
        {
          selector:
            'MemberExpression > Literal.property[value=/^(innerHTML|outerHTML|insertAdjacentHTML|setHTMLUnsafe|createContextualFragment)$/]',
          message: 'Nada de HTML cru: renderize como texto.',
        },
        {
          selector:
            "MemberExpression[object.name='document'] > Identifier.property[name=/^write(ln)?$/]",
          message: 'Nada de HTML cru: renderize como texto.',
        },
      ],
    },
  },
  prettier,
);
