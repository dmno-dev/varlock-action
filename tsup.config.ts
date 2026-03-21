import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  noExternal: ['@actions/core', '@actions/github', 'debug'],
});
