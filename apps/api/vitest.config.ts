import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// O SWC emite os metadados de decorators (emitDecoratorMetadata) que a injeção
// de dependências do Nest precisa; o transformador padrão do Vite não emite.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/*.spec.ts'] } },
      {
        extends: true,
        // Os E2E dividem um banco e o apagam entre os testes: um arquivo por vez.
        test: { name: 'e2e', include: ['test/**/*.e2e-spec.ts'], fileParallelism: false },
      },
    ],
  },
});
