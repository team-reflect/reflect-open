import { defineESLintConfig } from '@ocavue/eslint-config'

export default defineESLintConfig(
  {
    react: {
      version: '19.2',
      reactCompiler: true,
      files: ['**/*.tsx', './apps/desktop/src/**/*.ts'],
    },
    markdown: false,
    packageJson: false,
    command: true,
  },
  {
    ignores: ['./design-system/', '**/.wxt/'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs'],
    // Disable some rules temporarily
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    /// keep-sorted
    rules: {
      '@eslint-react/dom-no-flush-sync': 'off',
      '@eslint-react/exhaustive-deps': 'off',
      '@eslint-react/naming-convention-ref-name': 'off',
      '@eslint-react/set-state-in-effect': 'off',
      '@eslint-react/use-state': 'off',
      '@eslint-react/web-api-no-leaked-event-listener': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'jsdoc/multiline-blocks': 'off',
      'jsdoc/no-multi-asterisks': 'off',
      'no-var': 'off',
      'perfectionist/sort-imports': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/globals': 'off',
      'regexp/no-super-linear-backtracking': 'off',
      'unicorn/no-computed-property-existence-check': 'off',
      'unicorn/no-optional-chaining-on-undeclared-variable': 'off',
      'unicorn/no-unnecessary-splice': 'off',
      'unicorn/number-literal-case': 'off',
      'unicorn/prefer-add-event-listener': 'off',
      'unicorn/prefer-then-catch': 'off',
    },
  },
)
