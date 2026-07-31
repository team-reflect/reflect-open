import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

/**
 * ESLint flat config scoped to the React frontend.
 *
 * The project's primary linter is oxlint (`pnpm lint`). This config adds only
 * the React Hooks + React Compiler rule set from `eslint-plugin-react-hooks`
 * (`recommended-latest`), which oxlint does not implement. Those rules flag the
 * Rules of React violations that cause the React Compiler to silently skip
 * ("bail out" on) a component, so they keep the codebase compiler-friendly.
 *
 * Run via `pnpm --filter @reflect/desktop lint:react`, and wired into the
 * repo-wide `pnpm lint` so it gates CI alongside oxlint.
 *
 * @see https://react.dev/learn/react-compiler
 * @see https://github.com/facebook/react/tree/main/packages/eslint-plugin-react-hooks
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'src-tauri/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    ...reactHooks.configs.flat['recommended-latest'],
  },
  {
    // `useMainWindowEffect` forwards a deps array to useEffect (the main-window
    // gate for app-wide singletons) — its callers get the same deps checking.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/exhaustive-deps': ['warn', { additionalHooks: '^useMainWindowEffect$' }],
    },
  },
  {
    // Test harnesses legitimately break the Rules of React that the compiler
    // assumes — reassigning module-scoped probe variables from a render to
    // capture output, rendering throwaway components, etc. None of this code is
    // compiled by the React Compiler in production, so the purity/effect rules
    // don't apply. The classic correctness rules (rules-of-hooks, deps) stay on.
    files: ['src/**/*.{test,spec}.{ts,tsx}'],
    rules: {
      'react-hooks/globals': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/set-state-in-render': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/incompatible-library': 'off',
    },
  },
)
