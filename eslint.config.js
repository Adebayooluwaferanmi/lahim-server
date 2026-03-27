import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './test/tsconfig.json', './src/db/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'arrow-body-style': ['warn', 'as-needed'],
      'no-param-reassign': ['error', { props: false }],
      curly: ['error', 'all'],
      'eol-last': ['error', 'always'],
      'no-debugger': 'error',
      '@typescript-eslint/unified-signatures': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    ignores: ['bin/**', 'dist/**', 'commitlint.config.js'],
  },
)
