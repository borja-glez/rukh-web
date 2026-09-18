// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import astro from 'eslint-plugin-astro';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    'dist/',
    '.astro/',
    'node_modules/',
    '.lighthouseci/',
    'lighthouse-reports/',
    'playwright-report/',
    'test-results/',
    'public/',
  ]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs['flat/recommended'],
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ['scripts/**/*.mjs', 'src/scripts/theme-init.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/scripts/theme-init.js'],
    languageOptions: { globals: globals.browser, sourceType: 'script' },
    rules: {
      'no-var': 'off',
      'no-empty': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
]);
