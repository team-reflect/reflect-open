import { defineESLintConfig } from '@ocavue/eslint-config'

export default defineESLintConfig(
  {
    react: {
      version: '19.2',
      reactCompiler: true,
      files: ['**/*.tsx'],
    },
    markdown: false,
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    // Disable some rules temporarily
    rules: {
      "jsdoc/multiline-blocks": 'off',
      'perfectionist/sort-imports': 'off',
      'unicorn/prefer-string-replace-all': 'off',
      'unicorn/no-return-array-push': 'off',
      '@typescript-eslint/require-await': 'off',
      'prefer-const': 'off',
    }
  }
)
