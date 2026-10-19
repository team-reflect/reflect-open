import { defineESLintConfig } from '@ocavue/eslint-config'

// Lint rules that keep the service architecture (`docs/contributing/services.md`).
// Each block names the rule of the architecture that it protects. An exception
// is a file in a list here, with its reason: never an inline disable comment.

const SOURCE_EXTENSIONS = '{ts,tsx}'

/**
 * `vi.mock` / `vi.doMock` only for the listed module specifiers. An entry that
 * ends in `*` allows every specifier with that prefix.
 */
const viMockAllowlistRule = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: { allow: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
    messages: {
      notAllowed:
        '`vi.mock` of "{{specifier}}" is not on the allowlist. Build `createTestCoreServices()` and render with `renderInApp` (seed a test double or spy on `app.<service>`), or mount the real provider in `wrapper`. Only a pure UI child or a heavy child may be mocked: list it in `eslint.config.js` with a reason.',
      notLiteral: 'Pass the module specifier of `vi.mock` as a string literal.',
    },
  },
  create(context) {
    const allow = context.options[0]?.allow ?? []
    const isAllowed = (specifier) => {
      return allow.some((entry) => {
        return entry.endsWith('*') ? specifier.startsWith(entry.slice(0, -1)) : specifier === entry
      })
    }
    return {
      CallExpression(node) {
        const { callee } = node
        if (
          callee.type !== 'MemberExpression' ||
          callee.object.type !== 'Identifier' ||
          callee.object.name !== 'vi' ||
          callee.property.type !== 'Identifier' ||
          (callee.property.name !== 'mock' && callee.property.name !== 'doMock')
        ) {
          return
        }
        const [first] = node.arguments
        if (first?.type !== 'Literal' || typeof first.value !== 'string') {
          context.report({ node, messageId: 'notLiteral' })
          return
        }
        if (!isAllowed(first.value)) {
          context.report({ node, messageId: 'notAllowed', data: { specifier: first.value } })
        }
      },
    }
  },
}

/**
 * `MaybePromise<T>` from `@reflect/utils`, not a hand-written `T | Promise<T>`.
 * The rule compares the source text of the union members. It skips the
 * definition itself: a generic type alias whose whole body is `P | Promise<P>`
 * for one of its type parameters `P`.
 */
const maybePromiseRule = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: {
      useMaybePromise: 'Use `MaybePromise<T>` from `@reflect/utils` instead of `T | Promise<T>`.',
    },
  },
  create(context) {
    const text = (node) => context.sourceCode.getText(node)
    const isDefinition = (union, value) => {
      return (
        union.parent.type === 'TSTypeAliasDeclaration' &&
        union.types.length === 2 &&
        union.parent.typeParameters?.params.some((param) => param.name.name === text(value))
      )
    }
    return {
      TSUnionType(node) {
        const members = new Set(node.types.map(text))
        for (const type of node.types) {
          const args = type.typeArguments?.params
          if (
            type.type !== 'TSTypeReference' ||
            type.typeName.type !== 'Identifier' ||
            type.typeName.name !== 'Promise' ||
            args?.length !== 1
          ) {
            continue
          }
          const values = args[0].type === 'TSUnionType' ? args[0].types : args
          if (isDefinition(node, args[0])) {
            return
          }
          if (values.every((value) => members.has(text(value)))) {
            context.report({ node, messageId: 'useMaybePromise' })
            return
          }
        }
      },
    }
  },
}

const architecturePlugin = {
  rules: { 'maybe-promise': maybePromiseRule, 'vi-mock-allowlist': viMockAllowlistRule },
}

// ---------------------------------------------------------------------------
// `vi.mock` allowlists
// ---------------------------------------------------------------------------

/** Mocked in any desktop test: pure UI children and heavy children. */
const DESKTOP_VI_MOCK_ALLOW = [
  // Vaul's drag and animation are verified on a device; tests use a passthrough.
  '@/components/ui/drawer.tsx',
  // The Base UI toast manager needs its viewport; tests record the `toast.add` calls.
  '@/components/ui/toast.tsx',
  // The ProseKit editor: a test of a screen around it uses a probe.
  '@/editor/note-editor.tsx',
  // The read-only Markdown renderer loads the same editor stack.
  '@/editor/markdown-preview.tsx',
  // The carousel engine measures real layout; tests script its API.
  'embla-carousel-react',
]

/** Extra specifiers for one desktop test file, each with its reason. */
const DESKTOP_VI_MOCK_ALLOW_BY_FILE = {
  // Platform adapters: the test stands in for the Tauri API under the adapter.
  'apps/desktop/src/services/*.test.ts': ['@tauri-apps/*'],

  // Heavy children: the pane and the task row mount the editor.
  'apps/desktop/src/components/daily-stream.focus.test.tsx': ['@/components/note-pane.tsx'],
  'apps/desktop/src/components/tasks/tasks-screen.test.tsx': ['./task-editor'],

  // The real resolver only lets `reflect-asset:` media through, which no test
  // browser can load; the mock also widens `X_MEDIA_URL_PROTOCOLS`.
  'apps/desktop/src/editor/note-editor.test.tsx': ['@/editor/use-x-post-resolver.ts'],

  // Presentation tests over every phase of the recorder. The context value is
  // scripted; the session behind it has its own tests in core and in
  // `providers/audio-memo-provider.test.tsx` / `mobile/audio-memo-provider.test.tsx`.
  'apps/desktop/src/components/audio-memo/audio-memo-button.test.tsx': [
    '@/providers/audio-memo-provider.tsx',
  ],
  'apps/desktop/src/mobile/daily-capture-menu.test.tsx': ['@/mobile/audio-memo-provider.tsx'],
  'apps/desktop/src/mobile/recording-drawer.test.tsx': ['@/mobile/audio-memo-provider.tsx'],
  'apps/desktop/src/mobile/mobile-screen.test.tsx': ['@/mobile/audio-memo-provider.tsx'],
}

/**
 * The extension has no service layer: its modules reach `wxt/browser` and each
 * other directly. The list is today's mocks, so a new target still fails.
 */
const EXTENSION_VI_MOCK_ALLOW = [
  'wxt/browser',
  './bookmark-settings',
  './extract-page-text',
  './flush',
  './like-settings',
  './native',
  './use-captured-page',
  './x-save',
  '@/lib/flush',
  '@/lib/page-text',
  '@/lib/popup-preferences',
  '@/lib/save-capture',
]

function viMockBlock(files, allow) {
  return {
    files,
    plugins: { architecture: architecturePlugin },
    rules: { 'architecture/vi-mock-allowlist': ['error', { allow }] },
  }
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const TAURI_IMPORT_MESSAGE =
  'Only the platform adapters in `apps/desktop/src/services/` (and `boot.ts`, `main.tsx`) import `@tauri-apps/*`. Read the service from `useCoreServices()` or take it in `ctx`.'

// A selector, not `no-restricted-imports`: that rule also reports
// `import * as React from 'react'`.
const REACT_ACT_SELECTOR = {
  selector: 'ImportDeclaration[source.value="react"] > ImportSpecifier[imported.name="act"]',
  message:
    "Import `act` from '@/test-utils/act.ts': it sets `IS_REACT_ACT_ENVIRONMENT` for the scope, so React does not warn.",
}

/** `import()` of a restricted package, which `no-restricted-imports` does not see. */
function dynamicImportSelector(pattern, message) {
  return { selector: `ImportExpression[source.value=/${pattern}/]`, message }
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const MODULE_LET_SELECTORS = [
  {
    selector:
      ':matches(Program > VariableDeclaration[kind="let"], Program > ExportNamedDeclaration > VariableDeclaration[kind="let"])',
    message:
      'No module-level mutable state in `@reflect/core`: state lives in the `#` fields of the service that `createXxxService(deps)` builds, so each `createCoreServices()` (and each test) gets its own.',
  },
]

// ---------------------------------------------------------------------------
// Code shape: no overloads, no accessors, `#` for private members
// ---------------------------------------------------------------------------

const ACCESSOR_MESSAGE = 'No accessors. Write getX() / setX().'
const ACCESSIBILITY_MESSAGE = 'Use # for private members; no accessibility modifiers.'

const CODE_SHAPE_SELECTORS = [
  {
    selector: 'TSDeclareFunction',
    message: 'No function overloads. Write one function per signature.',
  },
  { selector: "MethodDefinition[kind='get']", message: ACCESSOR_MESSAGE },
  { selector: "MethodDefinition[kind='set']", message: ACCESSOR_MESSAGE },
  { selector: "Property[kind='get']", message: ACCESSOR_MESSAGE },
  { selector: "Property[kind='set']", message: ACCESSOR_MESSAGE },
  { selector: 'PropertyDefinition[accessibility]', message: ACCESSIBILITY_MESSAGE },
  { selector: 'MethodDefinition[accessibility]', message: ACCESSIBILITY_MESSAGE },
  { selector: 'TSParameterProperty', message: ACCESSIBILITY_MESSAGE },
]

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

const NO_CONSOLE = [
  'error',
  {
    name: 'console',
    message:
      'Log through `LoggerService` (`deps.logger`, `useCoreServices().logger`, `ctx.logger`). A test asserts on `createTestLoggerService().getErrors()` / `getWarnings()`.',
  },
]

export default defineESLintConfig(
  {
    react: {
      version: '19.3',
      reactCompiler: true,
      files: ['**/*.tsx', './apps/desktop/src/**/*.ts'],
    },
    markdown: false,
    packageJson: false,
    command: true,
    perfectionist: false,
    jsdoc: false,
  },
  {
    ignores: ['./design-system/', '**/.wxt/', '**/.output/'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs'],
    /// keep-sorted
    rules: {
      '@eslint-react/set-state-in-effect': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },
  {
    files: [`**/*.${SOURCE_EXTENSIONS}`],
    plugins: { architecture: architecturePlugin },
    rules: { 'architecture/maybe-promise': 'error' },
  },
  {
    files: [`packages/core/**/*.${SOURCE_EXTENSIONS}`],
    rules: {
      'no-restricted-syntax': ['error', ...CODE_SHAPE_SELECTORS],
    },
  },

  // Rule: no module-level state in core. Every service is built by
  // `createCoreServices(adapters)` and holds its state in its own `#` fields.
  {
    files: [`packages/core/src/**/*.${SOURCE_EXTENSIONS}`],
    ignores: [`**/*.test.${SOURCE_EXTENSIONS}`],
    rules: {
      'no-restricted-syntax': ['error', ...MODULE_LET_SELECTORS, ...CODE_SHAPE_SELECTORS],
    },
  },

  // Rule: the desktop app reaches the platform through the adapters in
  // `services/`. Everything else gets a service from `useCoreServices()` / `ctx`.
  // Also: tests use the `act` of `test-utils/act.ts`.
  {
    files: [`apps/desktop/src/**/*.${SOURCE_EXTENSIONS}`],
    ignores: ['apps/desktop/src/test-utils/act.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@tauri-apps/*'], message: TAURI_IMPORT_MESSAGE }] },
      ],
      'no-restricted-syntax': [
        'error',
        REACT_ACT_SELECTOR,
        dynamicImportSelector(String.raw`^@tauri-apps\/`, TAURI_IMPORT_MESSAGE),
        ...CODE_SHAPE_SELECTORS,
      ],
    },
  },
  {
    files: [
      // The adapters.
      `apps/desktop/src/services/**/*.${SOURCE_EXTENSIONS}`,
      // The composition roots: `boot.ts` asks Tauri whether the shell is
      // native before any service exists; `main.tsx` is listed with it and
      // imports nothing from Tauri today.
      'apps/desktop/src/boot.ts',
      'apps/desktop/src/main.tsx',
    ],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': ['error', REACT_ACT_SELECTOR, ...CODE_SHAPE_SELECTORS],
    },
  },

  // Rule: all diagnostics go through `LoggerService`, in the app and in tests.
  {
    files: [
      `apps/desktop/src/**/*.${SOURCE_EXTENSIONS}`,
      `packages/*/src/**/*.${SOURCE_EXTENSIONS}`,
    ],
    ignores: [
      // The console implementation of `LoggerService`, and its test.
      'packages/core/src/ports/logger-service.ts',
      'packages/core/src/ports/logger-service.test.ts',
      // Boot-time: the platform facts are read before any service exists
      // (they decide which services to build).
      'apps/desktop/src/services/detect-platform.ts',
      // The in-memory backend of browser dev. It stands in for the Rust side
      // of the IPC bridge and has no services.
      'apps/desktop/src/dev/**',
    ],
    rules: { 'no-restricted-globals': NO_CONSOLE },
  },

  // Rule: a test builds its services (`createTestCoreServices`, `renderInApp`)
  // and does not replace modules. `vi.mock` is for pure UI children and heavy
  // children only; `@reflect/core`, `@/lib/*` and the providers that are a
  // thin shell over a service are never on the list.
  viMockBlock([`packages/**/*.${SOURCE_EXTENSIONS}`], []),
  viMockBlock([`apps/desktop/**/*.${SOURCE_EXTENSIONS}`], DESKTOP_VI_MOCK_ALLOW),
  ...Object.entries(DESKTOP_VI_MOCK_ALLOW_BY_FILE).map(([file, allow]) => {
    return viMockBlock([file], [...DESKTOP_VI_MOCK_ALLOW, ...allow])
  }),
  viMockBlock([`apps/extension/**/*.${SOURCE_EXTENSIONS}`], EXTENSION_VI_MOCK_ALLOW),
)
