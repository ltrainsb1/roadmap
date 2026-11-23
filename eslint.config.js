import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '.superpowers/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js', '*.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'mongodb', message: 'Only apps/api/src/db/** may import from mongodb.' }],
          patterns: [{ group: ['mongodb/*'], message: 'Only apps/api/src/db/** may import from mongodb.' }],
        },
      ],
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
