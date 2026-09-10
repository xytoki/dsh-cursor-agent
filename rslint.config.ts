import {
  defineConfig,
  js,
  ts,
  reactPlugin,
  reactHooksPlugin,
} from '@rslint/core';

export default defineConfig([
  {
    ignores: [
      'src/generated/**',
      'lib/**',
      'dist/**',
      'node_modules/**',
    ],
  },
  js.configs.recommended,
  ts.configs.recommended,
  reactPlugin.configs.recommended,
  reactHooksPlugin.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
      'prefer-const': 'off',
      'no-regex-spaces': 'off',
      'no-empty': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
]);
