import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// O SWC emite os metadados de decorators (emitDecoratorMetadata) que a injeção
// de dependências do Nest precisa; o transformador padrão do Vite não emite.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
  },
});
