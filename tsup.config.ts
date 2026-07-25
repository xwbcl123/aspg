import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/print-lifecycle-schema.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  dts: true,
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
